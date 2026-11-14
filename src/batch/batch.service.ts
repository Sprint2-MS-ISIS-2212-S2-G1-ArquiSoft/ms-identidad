import {
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

export interface MensajePerfilBatch {
  id?: string;
  documento?: string;
   ids?: string[];
  documentos?: string[];
  fuenteOpenData?: string;
}

@Injectable()
export class BatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BatchService.name);
  private readonly workerId = `worker-${process.env.HOSTNAME || randomUUID().slice(0, 8)}`;

  private readonly mode: 'api' | 'worker' | 'both';
  private readonly sqsQueueUrl: string;
  private readonly awsRegion: string;
  private readonly sqsConcurrency: number;
  private readonly writeBackEnabled: boolean;

  // Regla del 70%: calculo matematico del pool de conexiones
  private readonly rdsMaxConnections: number;
  private readonly maxWorkerReplicas: number;
  private readonly primaryPoolSize: number;
  private readonly replicaPoolSize: number;

  private primaryPool!: Pool;
  private replicaPool!: Pool;
  private sqsClient?: SQSClient;

  private running = false;
  private loopPromises: Promise<void>[] = [];
  private metricsTimer?: NodeJS.Timeout;

  // Contadores locales de este worker
  private perfilesProcesadosTotal = 0;
  private perfilesVentana = 0;
  private lotesProcesadosTotal = 0;
  private ultimaVentanaTs = Date.now();
  private throughputReciente = 0;
  private ultimaLatenciaReplicaMs = 0;
  private ultimaLatenciaPrimaryMs = 0;

  constructor(private readonly config: ConfigService) {
    const rawMode = (
      this.config.get<string>('MODE', 'api') || 'api'
    ).toLowerCase();
    this.mode =
      rawMode === 'worker' || rawMode === 'both' ? rawMode : 'api';

    this.sqsQueueUrl = this.config.get<string>('SQS_QUEUE_URL', '');
    this.awsRegion = this.config.get<string>('AWS_REGION', 'us-east-1');
    this.sqsConcurrency = Number(
      this.config.get<string>('SQS_CONCURRENCY', '6'),
    );
    this.writeBackEnabled =
      this.config.get<string>('WORKER_WRITE_BACK', 'true') === 'true';

    // Calculo matematico del Pool de Conexiones (Regla del 70%)
    this.rdsMaxConnections = Number(
      this.config.get<string>('RDS_MAX_CONNECTIONS', '100'),
    );
    this.maxWorkerReplicas = Math.max(
      1,
      Number(this.config.get<string>('MAX_WORKER_REPLICAS', '4')),
    );
    const maxBudgetWorkers = Math.floor(this.rdsMaxConnections * 0.7);
    const maxPorWorkerCalculado = Math.max(
      2,
      Math.floor(maxBudgetWorkers / this.maxWorkerReplicas),
    );
    const configuredPoolSize = Number(
      this.config.get<string>('DB_POOL_SIZE', String(maxPorWorkerCalculado)),
    );

    if (this.mode === 'worker') {
      // El worker acota su pool estrictamente bajo la regla del 70%
      this.replicaPoolSize = Math.min(configuredPoolSize, maxPorWorkerCalculado);
      this.primaryPoolSize = Math.max(
        2,
        Math.min(5, Math.floor(this.replicaPoolSize / 2)),
      );
    } else {
      // Identidad API tiene garantizado el 30% restante de conexiones en Primary
      const apiBudget = Math.max(
        5,
        Math.floor(this.rdsMaxConnections * 0.3),
      );
      this.primaryPoolSize = Math.min(configuredPoolSize, apiBudget);
      this.replicaPoolSize = 2;
    }
  }

  async onModuleInit(): Promise<void> {
    const dbPort = Number(this.config.get<string>('DB_PORT', '5432'));
    const dbUser = this.config.get<string>('DB_USER', 'identidad');
    const dbPassword = this.config.get<string>('DB_PASSWORD', 'identidad');
    const dbName = this.config.get<string>('DB_NAME', 'identidad');

    const primaryHost =
      this.config.get<string>('DB_PRIMARY_HOST') ||
      this.config.get<string>('DB_HOST', 'localhost');
    const replicaHost =
      this.config.get<string>('DB_REPLICA_HOST') || primaryHost;

    const primaryUrl = this.config.get<string>('DB_PRIMARY_URL');
    const replicaUrl = this.config.get<string>('DB_REPLICA_URL');

    const dbSsl =
      this.config.get<string>('DB_SSL') === 'true' ||
      primaryHost.includes('.rds.amazonaws.com') ||
      replicaHost.includes('.rds.amazonaws.com') ||
      Boolean(primaryUrl && primaryUrl.includes('.rds.amazonaws.com'));

    const sslConfig = dbSsl ? { rejectUnauthorized: false } : undefined;

    this.primaryPool = new Pool(
      primaryUrl
        ? {
            connectionString: primaryUrl,
            max: this.primaryPoolSize,
            ssl: sslConfig,
          }
        : {
            host: primaryHost,
            port: dbPort,
            user: dbUser,
            password: dbPassword,
            database: dbName,
            max: this.primaryPoolSize,
            ssl: sslConfig,
          },
    );

    this.replicaPool = new Pool(
      replicaUrl
        ? {
            connectionString: replicaUrl,
            max: this.replicaPoolSize,
            ssl: sslConfig,
          }
        : {
            host: replicaHost,
            port: dbPort,
            user: dbUser,
            password: dbPassword,
            database: dbName,
            max: this.replicaPoolSize,
            ssl: sslConfig,
          },
    );

    await this.asegurarEsquema();

    if (this.sqsQueueUrl) {
      this.sqsClient = new SQSClient({ region: this.awsRegion });
    }

    this.logger.log(
      JSON.stringify({
        evento: 'inicio_identidad',
        workerId: this.workerId,
        mode: this.mode,
        primaryHost,
        replicaHost,
        regla70Porciento: {
          rdsMaxConnections: this.rdsMaxConnections,
          presupuestoMaxWorkers70Pct: Math.floor(this.rdsMaxConnections * 0.7),
          presupuestoReservaApi30Pct: Math.ceil(this.rdsMaxConnections * 0.3),
          maxWorkerReplicas: this.maxWorkerReplicas,
          primaryPoolSize: this.primaryPoolSize,
          replicaPoolSize: this.replicaPoolSize,
        },
        sqsConfigured: Boolean(this.sqsQueueUrl),
      }),
    );

    if (this.mode === 'worker' || this.mode === 'both') {
      if (!this.sqsQueueUrl) {
        this.logger.warn(
          'MODE=worker activo pero SQS_QUEUE_URL no esta definida. En espera...',
        );
      } else {
        this.iniciarConsumidoresSqs();
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
    }
    await Promise.allSettled(this.loopPromises);
    await this.primaryPool?.end().catch(() => undefined);
    await this.replicaPool?.end().catch(() => undefined);
  }

  private async asegurarEsquema(): Promise<void> {
    try {
      await this.primaryPool.query(`
        ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS score_riesgo integer DEFAULT 50 NOT NULL;
        ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS nivel_riesgo character varying DEFAULT 'MEDIO' NOT NULL;
        ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS actualizado_en timestamp without time zone DEFAULT now() NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_clientes_documento ON public.clientes(documento);
        CREATE TABLE IF NOT EXISTS public.batch_workers_metricas (
          worker_id character varying PRIMARY KEY,
          perfiles_procesados bigint DEFAULT 0 NOT NULL,
          lotes_procesados bigint DEFAULT 0 NOT NULL,
          throughput_reciente numeric(10,2) DEFAULT 0 NOT NULL,
          latencia_replica_ms numeric(10,2) DEFAULT 0 NOT NULL,
          latencia_primary_ms numeric(10,2) DEFAULT 0 NOT NULL,
          pool_replica_size integer DEFAULT 0 NOT NULL,
          pool_primary_size integer DEFAULT 0 NOT NULL,
          actualizado_en timestamp without time zone DEFAULT now() NOT NULL
        );
      `);
    } catch (err) {
      this.logger.warn(`No se pudo verificar esquema inicial: ${String(err)}`);
    }
  }

  private iniciarConsumidoresSqs(): void {
    this.running = true;
    this.ultimaVentanaTs = Date.now();

    for (let i = 0; i < this.sqsConcurrency; i++) {
      this.loopPromises.push(this.buclePollingSqs(i));
    }

    // Reportar metricas de throughput cada 2 segundos en log y en tabla compartida
    this.metricsTimer = setInterval(() => {
      void this.reportarMetricasVentana();
    }, 2000);
  }

  private async buclePollingSqs(pollerIdx: number): Promise<void> {
    while (this.running && this.sqsClient && this.sqsQueueUrl) {
      try {
        const res = await this.sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: this.sqsQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 20,
            VisibilityTimeout: 60,
          }),
        );

        const mensajes = res.Messages ?? [];
        if (mensajes.length === 0) {
          continue;
        }

        // Extraer todos los documentos o IDs de los hasta 10 mensajes recibidos
        const documentosSet = new Set<string>();
        const idsSet = new Set<string>();

        for (const msg of mensajes) {
          if (!msg.Body) continue;
          try {
            const parsed = JSON.parse(msg.Body) as MensajePerfilBatch;
            if (Array.isArray(parsed.documentos)) {
              for (const d of parsed.documentos) documentosSet.add(String(d));
            }
            if (parsed.documento) {
              documentosSet.add(String(parsed.documento));
            }
            if (Array.isArray(parsed.ids)) {
              for (const id of parsed.ids) idsSet.add(String(id));
            }
            if (parsed.id) {
              idsSet.add(String(parsed.id));
            }
          } catch {
            // Si el body es un documento en texto plano
            documentosSet.add(msg.Body.trim());
          }
        }

        const cantidadPerfilesEnLote =
          documentosSet.size + idsSet.size || mensajes.length;

        // 1. LECTURA MASIVA EN RDS READ REPLICA (Aislamiento OLTP vs Batch)
        const t0Replica = performance.now();
        let filasLeidas: Array<{
          id: string;
          documento: string;
          score_riesgo: number;
        }> = [];

        if (documentosSet.size > 0) {
          const docsArray = Array.from(documentosSet);
          const q = await this.replicaPool.query<{
            id: string;
            documento: string;
            score_riesgo: number;
          }>(
            `SELECT id, documento, score_riesgo
             FROM public.clientes
             WHERE documento = ANY($1::text[])`,
            [docsArray],
          );
          filasLeidas = q.rows;
        } else if (idsSet.size > 0) {
          const idsArray = Array.from(idsSet);
          const q = await this.replicaPool.query<{
            id: string;
            documento: string;
            score_riesgo: number;
          }>(
            `SELECT id, documento, score_riesgo
             FROM public.clientes
             WHERE id = ANY($1::uuid[])`,
            [idsArray],
          );
          filasLeidas = q.rows;
        }
        this.ultimaLatenciaReplicaMs =
          Math.round((performance.now() - t0Replica) * 100) / 100;

        // 2. RECALCULO DE PERFIL DE RIESGO CON MOCK LIGERO DE OPEN DATA
        const idsActualizar: string[] = [];
        const scoresActualizar: number[] = [];
        const nivelesActualizar: string[] = [];

        for (const fila of filasLeidas) {
          // Calculo determinista + senal Open Data simulada en memoria (sin bloquear red)
          const hashDoc =
            fila.documento
              .split('')
              .reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 100, 0) || 50;
          const nuevoScore = Math.max(10, Math.min(99, (hashDoc + 27) % 100));
          const nuevoNivel =
            nuevoScore >= 75 ? 'BAJO' : nuevoScore >= 40 ? 'MEDIO' : 'ALTO';

          idsActualizar.push(fila.id);
          scoresActualizar.push(nuevoScore);
          nivelesActualizar.push(nuevoNivel);
        }

        // 3. BULK UPDATE POR LOTES EN PRIMARY (opcional / acotado para no saturar IOPS)
        if (this.writeBackEnabled && idsActualizar.length > 0) {
          const t0Primary = performance.now();
          await this.primaryPool.query(
            `UPDATE public.clientes AS c
             SET score_riesgo = v.score,
                 nivel_riesgo = v.nivel,
                 actualizado_en = now()
             FROM unnest($1::uuid[], $2::int[], $3::text[]) AS v(id, score, nivel)
             WHERE c.id = v.id`,
            [idsActualizar, scoresActualizar, nivelesActualizar],
          );
          this.ultimaLatenciaPrimaryMs =
            Math.round((performance.now() - t0Primary) * 100) / 100;
        }

        // 4. BORRADO EN LOTE DE SQS (DeleteMessageBatch)
        const entries = mensajes
          .filter((m) => m.ReceiptHandle && m.MessageId)
          .map((m, idx) => ({
            Id: `${idx}`,
            ReceiptHandle: m.ReceiptHandle!,
          }));

        if (entries.length > 0) {
          await this.sqsClient.send(
            new DeleteMessageBatchCommand({
              QueueUrl: this.sqsQueueUrl,
              Entries: entries,
            }),
          );
        }

        const procesadosReales =
          filasLeidas.length > 0 ? filasLeidas.length : cantidadPerfilesEnLote;
        this.perfilesProcesadosTotal += procesadosReales;
        this.perfilesVentana += procesadosReales;
        this.lotesProcesadosTotal += 1;
      } catch (err) {
        this.logger.error(
          `Error en poller SQS #${pollerIdx}: ${String(err)}`,
        );
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async reportarMetricasVentana(): Promise<void> {
    const ahora = Date.now();
    const deltaSeg = Math.max(0.1, (ahora - this.ultimaVentanaTs) / 1000);
    const tpsVentana =
      Math.round((this.perfilesVentana / deltaSeg) * 100) / 100;

    // Solo actualizar throughputReciente si hubo actividad en la ventana o si bajo a 0 tras unos segundos
    this.throughputReciente = tpsVentana;
    const procesadosEnVentana = this.perfilesVentana;
    this.perfilesVentana = 0;
    this.ultimaVentanaTs = ahora;

    if (procesadosEnVentana > 0) {
      this.logger.log(
        JSON.stringify({
          metrica: 'identidad_worker_batch',
          workerId: this.workerId,
          perfilesVentana: procesadosEnVentana,
          throughputPerfilesSeg: this.throughputReciente,
          perfilesProcesadosTotal: this.perfilesProcesadosTotal,
          lotesProcesadosTotal: this.lotesProcesadosTotal,
          latenciaReplicaMs: this.ultimaLatenciaReplicaMs,
          latenciaPrimaryMs: this.ultimaLatenciaPrimaryMs,
        }),
      );
    }

    try {
      await this.primaryPool.query(
        `INSERT INTO public.batch_workers_metricas (
           worker_id, perfiles_procesados, lotes_procesados,
           throughput_reciente, latencia_replica_ms, latencia_primary_ms,
           pool_replica_size, pool_primary_size, actualizado_en
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (worker_id) DO UPDATE SET
           perfiles_procesados = EXCLUDED.perfiles_procesados,
           lotes_procesados = EXCLUDED.lotes_procesados,
           throughput_reciente = EXCLUDED.throughput_reciente,
           latencia_replica_ms = EXCLUDED.latencia_replica_ms,
           latencia_primary_ms = EXCLUDED.latencia_primary_ms,
           pool_replica_size = EXCLUDED.pool_replica_size,
           pool_primary_size = EXCLUDED.pool_primary_size,
           actualizado_en = now()`,
        [
          this.workerId,
          this.perfilesProcesadosTotal,
          this.lotesProcesadosTotal,
          this.throughputReciente,
          this.ultimaLatenciaReplicaMs,
          this.ultimaLatenciaPrimaryMs,
          this.replicaPoolSize,
          this.primaryPoolSize,
        ],
      );
    } catch {
      // Ignorar errores transitorios de telemetria
    }
  }

  /**
   * Pobla rapidamente la tabla clientes en RDS usando generate_series de Postgres.
   * Permite crear 100.000 perfiles en ~2 segundos sin saturar la red.
   */
  async seedPerfilesBaseDatos(cantidad = 100000): Promise<{
    insertados: number;
    totalEnBase: number;
    duracionMs: number;
  }> {
    const t0 = performance.now();
    await this.asegurarEsquema();

    const resInsert = await this.primaryPool.query(
      `INSERT INTO public.clientes (nombre, documento, score_riesgo, nivel_riesgo, actualizado_en)
       SELECT
         'Cliente ' || g,
         '10' || lpad(g::text, 8, '0'),
         50,
         'MEDIO',
         now()
       FROM generate_series(1, $1::int) AS g
       WHERE NOT EXISTS (
         SELECT 1 FROM public.clientes c WHERE c.documento = '10' || lpad(g::text, 8, '0')
       )`,
      [cantidad],
    );

    const resTotal = await this.primaryPool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM public.clientes`,
    );

    return {
      insertados: resInsert.rowCount ?? 0,
      totalEnBase: Number(resTotal.rows[0]?.total ?? 0),
      duracionMs: Math.round(performance.now() - t0),
    };
  }

  /**
   * Envia mensajes micro-batch a Amazon SQS para disparar el reprocesamiento masivo.
   * Por defecto: 100.000 perfiles agrupados en lotes de 50 perfiles/mensaje = 2.000 mensajes SQS.
   */
  async seedColaSqs(
    totalPerfiles = 100000,
    perfilesPorMensaje = 50,
  ): Promise<{
    totalPerfilesEncolados: number;
    mensajesSqsEnviados: number;
    perfilesPorMensaje: number;
    duracionMs: number;
  }> {
    if (!this.sqsClient || !this.sqsQueueUrl) {
      throw new Error('SQS_QUEUE_URL no esta configurada en el servicio');
    }

    const t0 = performance.now();
    // Reiniciar contadores de metricas antes de nuevo experimento
    await this.primaryPool
      .query(`DELETE FROM public.batch_workers_metricas`)
      .catch(() => undefined);
    this.perfilesProcesadosTotal = 0;
    this.lotesProcesadosTotal = 0;

    const mensajes: string[] = [];
    for (let inicio = 1; inicio <= totalPerfiles; inicio += perfilesPorMensaje) {
      const fin = Math.min(totalPerfiles, inicio + perfilesPorMensaje - 1);
      const documentos: string[] = [];
      for (let docNum = inicio; docNum <= fin; docNum++) {
        documentos.push(`10${String(docNum).padStart(8, '0')}`);
      }
      mensajes.push(
        JSON.stringify({
          documentos,
          fuenteOpenData: 'OPEN_DATA_SFC_BATCH',
        }),
      );
    }

    // Enviar en SendMessageBatch de 10 mensajes con concurrencia de 20
    const chunksDe10: string[][] = [];
    for (let i = 0; i < mensajes.length; i += 10) {
      chunksDe10.push(mensajes.slice(i, i + 10));
    }

    const CONCURRENCIA_ENVIO = 20;
    for (let i = 0; i < chunksDe10.length; i += CONCURRENCIA_ENVIO) {
      const slice = chunksDe10.slice(i, i + CONCURRENCIA_ENVIO);
      await Promise.all(
        slice.map((grupo, gIdx) =>
          this.sqsClient!.send(
            new SendMessageBatchCommand({
              QueueUrl: this.sqsQueueUrl,
              Entries: grupo.map((body, idx) => ({
                Id: `m_${i + gIdx}_${idx}`,
                MessageBody: body,
              })),
            }),
          ),
        ),
      );
    }

    return {
      totalPerfilesEncolados: totalPerfiles,
      mensajesSqsEnviados: mensajes.length,
      perfilesPorMensaje,
      duracionMs: Math.round(performance.now() - t0),
    };
  }

  /**
   * Devuelve las metricas consolidadas del experimento:
   * - Estado de la regla del 70% de conexiones
   * - Throughput agregado de todos los workers activos
   * - Profundidad actual de la cola SQS
   * - Conexiones activas en PostgreSQL
   */
  async obtenerMetricas(): Promise<Record<string, unknown>> {
    const workersRes = await this.primaryPool
      .query<{
        worker_id: string;
        perfiles_procesados: string;
        lotes_procesados: string;
        throughput_reciente: string;
        latencia_replica_ms: string;
        latencia_primary_ms: string;
        pool_replica_size: number;
        pool_primary_size: number;
        activo: boolean;
      }>(
        `SELECT
           worker_id,
           perfiles_procesados::text,
           lotes_procesados::text,
           throughput_reciente::text,
           latencia_replica_ms::text,
           latencia_primary_ms::text,
           pool_replica_size,
           pool_primary_size,
           (actualizado_en >= now() - interval '10 seconds') AS activo
         FROM public.batch_workers_metricas
         ORDER BY worker_id`,
      )
      .catch(() => ({ rows: [] }));

    const connRes = await this.primaryPool
      .query<{ conexiones_activas: string }>(
        `SELECT count(*)::text AS conexiones_activas
         FROM pg_stat_activity
         WHERE datname = current_database()`,
      )
      .catch(() => ({ rows: [{ conexiones_activas: '0' }] }));

    let sqsApproxMessages: number | null = null;
    let sqsInFlightMessages: number | null = null;
    if (this.sqsClient && this.sqsQueueUrl) {
      try {
        const sqsAttr = await this.sqsClient.send(
          new GetQueueAttributesCommand({
            QueueUrl: this.sqsQueueUrl,
            AttributeNames: [
              'ApproximateNumberOfMessages',
              'ApproximateNumberOfMessagesNotVisible',
            ],
          }),
        );
        sqsApproxMessages = Number(
          sqsAttr.Attributes?.ApproximateNumberOfMessages ?? 0,
        );
        sqsInFlightMessages = Number(
          sqsAttr.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0,
        );
      } catch {
        // Ignorar si no hay permisos de GetQueueAttributes
      }
    }

    let totalPerfilesReprocesados = 0;
    let totalLotes = 0;
    let throughputGlobalPerfilesSeg = 0;
    let workersActivos = 0;

    for (const w of workersRes.rows) {
      totalPerfilesReprocesados += Number(w.perfiles_procesados);
      totalLotes += Number(w.lotes_procesados);
      if (w.activo) {
        throughputGlobalPerfilesSeg += Number(w.throughput_reciente);
        workersActivos += 1;
      }
    }

    const tiempoEstimado10MillonesHoras =
      throughputGlobalPerfilesSeg > 0
        ? Math.round((10_000_000 / throughputGlobalPerfilesSeg / 3600) * 100) /
          100
        : null;

    return {
      instanciaActual: {
        workerId: this.workerId,
        mode: this.mode,
        primaryPoolSize: this.primaryPoolSize,
        replicaPoolSize: this.replicaPoolSize,
      },
      tacticaPool70Porciento: {
        rdsMaxConnections: this.rdsMaxConnections,
        limiteMaxWorkers70Pct: Math.floor(this.rdsMaxConnections * 0.7),
        reservaMinApiOnline30Pct: Math.ceil(this.rdsMaxConnections * 0.3),
        maxWorkerReplicas: this.maxWorkerReplicas,
        conexionesActivasEnPostgres: Number(
          connRes.rows[0]?.conexiones_activas ?? 0,
        ),
        cumpleRegla70Pct:
          Number(connRes.rows[0]?.conexiones_activas ?? 0) <=
          Math.floor(this.rdsMaxConnections * 0.7) + this.primaryPoolSize,
      },
      colaSqs: {
        configurada: Boolean(this.sqsQueueUrl),
        mensajesEnEspera: sqsApproxMessages,
        mensajesEnVuelo: sqsInFlightMessages,
      },
      reprocesamientoBatch: {
        workersActivos,
        workersRegistrados: workersRes.rows.length,
        totalPerfilesReprocesados,
        totalLotesProcesados: totalLotes,
        throughputGlobalPerfilesSeg:
          Math.round(throughputGlobalPerfilesSeg * 100) / 100,
        metaThroughputPerfilesSeg: 1400,
        cumpleMetaThroughput: throughputGlobalPerfilesSeg >= 1400,
        proyeccion10MPerfilesHoras: tiempoEstimado10MillonesHoras,
        detalleWorkers: workersRes.rows,
      },
    };
  }
}
