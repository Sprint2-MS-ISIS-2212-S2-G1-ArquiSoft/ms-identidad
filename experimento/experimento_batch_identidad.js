import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Gauge, Trend } from 'k6/metrics';

const DISTRIBUCION_URL = __ENV.DISTRIBUCION_URL || 'http://localhost:3000';
const IDENTIDAD_URL = __ENV.IDENTIDAD_URL || 'http://localhost:3001';
const SOCIO_ID = __ENV.SOCIO_ID || '123e4567-e89b-12d3-a456-426614174001';
const PRODUCTO_ID = __ENV.PRODUCTO_ID || '123e4567-e89b-12d3-a456-426614174000';

const FASE_S = Number(__ENV.FASE_S || 60);
const RPS_ONLINE = Number(__ENV.RPS_ONLINE || 50);
const TOTAL_PERFILES_BATCH = Number(__ENV.TOTAL_PERFILES_BATCH || 100000);
const PERFILES_POR_MENSAJE = Number(__ENV.PERFILES_POR_MENSAJE || 50);
const CORRIDA = __ENV.CORRIDA || 'corrida-batch-con-tacticas';

const throughputBatch = new Trend('batch_throughput_perfiles_seg');
const perfilesReprocesados = new Gauge('batch_perfiles_reprocesados');
const mensajesEnColaSqs = new Gauge('batch_mensajes_en_cola_sqs');
const conexionesPostgres = new Gauge('rds_conexiones_activas');

export const options = {
  scenarios: {
    trafico_online: {
      executor: 'constant-arrival-rate',
      rate: RPS_ONLINE,
      timeUnit: '1s',
      duration: `${FASE_S * 3}s`,
      preAllocatedVUs: 40,
      maxVUs: 150,
      exec: 'cotizarOnline',
    },
    disparar_batch_sqs: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      startTime: `${FASE_S}s`,
      exec: 'iniciarBatchSqs',
    },
    monitorear_worker_batch: {
      executor: 'constant-vus',
      vus: 1,
      duration: `${FASE_S * 3}s`,
      exec: 'monitorearBatch',
    },
  },
  thresholds: {
    'checks{fase:reposo}': ['rate>=0.99'],
    'checks{fase:batch}': ['rate>=0.99'],
    'http_req_duration{fase:reposo,tipo:cotizacion_online}': ['p(95)<=250', 'p(99)<=500'],
    'http_req_duration{fase:batch,tipo:cotizacion_online}': ['p(95)<=250', 'p(99)<=500'],
    'http_req_duration{fase:post_batch,tipo:cotizacion_online}': ['p(95)<=250', 'p(99)<=500'],
    'batch_throughput_perfiles_seg{fase:batch}': ['max>=1400'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function faseActual() {
  const transcurrido = (Date.now() - exec.scenario.startTime) / 1000;
  if (transcurrido < FASE_S) return 'reposo';
  if (transcurrido < FASE_S * 2) return 'batch';
  return 'post_batch';
}

export function cotizarOnline() {
  const fase = faseActual();
  const n = Math.floor(Math.random() * TOTAL_PERFILES_BATCH) + 1;
  const documento = `10${String(n).padStart(8, '0')}`;
  const tags = { fase, tipo: 'cotizacion_online' };

  const res = http.post(
    `${DISTRIBUCION_URL}/cotizar`,
    JSON.stringify({
      nombre: `Cliente ${n}`,
      documento,
      idProducto: PRODUCTO_ID,
      aceptaOpenData: false,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Socio-Id': SOCIO_ID,
      },
      tags,
      timeout: '5s',
    },
  );

  check(
    res,
    {
      'respuesta exitosa online (200/201)': (r) => r.status === 200 || r.status === 201,
    },
    { fase },
  );
}

export function iniciarBatchSqs() {
  console.log(
    `[${new Date().toISOString()}] Disparando seed de ${TOTAL_PERFILES_BATCH} perfiles en Amazon SQS (${PERFILES_POR_MENSAJE} perfiles/mensaje)...`,
  );
  const res = http.post(
    `${IDENTIDAD_URL}/batch/seed-sqs`,
    JSON.stringify({
      totalPerfiles: TOTAL_PERFILES_BATCH,
      perfilesPorMensaje: PERFILES_POR_MENSAJE,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { tipo: 'control_batch' },
      timeout: '60s',
    },
  );
  console.log(
    `[${new Date().toISOString()}] Respuesta seed SQS (HTTP ${res.status}): ${res.body}`,
  );
}

export function monitorearBatch() {
  const fase = faseActual();
  const res = http.get(`${IDENTIDAD_URL}/metricas`, {
    tags: { fase, tipo: 'telemetria' },
    timeout: '5s',
  });

  if (res.status === 200) {
    try {
      const body = res.json();
      const batch = body.reprocesamientoBatch || {};
      const sqs = body.colaSqs || {};
      const pool = body.tacticaPool70Porciento || {};

      const tps = Number(batch.throughputGlobalPerfilesSeg || 0);
      const total = Number(batch.totalPerfilesReprocesados || 0);
      const enCola = Number(sqs.mensajesEnEspera || 0);
      const conn = Number(pool.conexionesActivasEnPostgres || 0);

      if (tps > 0 || fase === 'batch') {
        throughputBatch.add(tps, { fase });
      }
      perfilesReprocesados.add(total, { fase });
      mensajesEnColaSqs.add(enCola, { fase });
      conexionesPostgres.add(conn, { fase });
    } catch (_) {
      // Ignorar error de parseo
    }
  }
  sleep(2);
}

export function handleSummary(data) {
  const m = data.metrics;
  const valor = (nombre, campo) =>
    m[nombre] && m[nombre].values ? m[nombre].values[campo] : null;

  const fases = {};
  for (const fase of ['reposo', 'batch', 'post_batch']) {
    fases[fase] = {
      exito_rate: valor(`checks{fase:${fase}}`, 'rate'),
      p50_ms: valor(`http_req_duration{fase:${fase},tipo:cotizacion_online}`, 'med'),
      p95_ms: valor(`http_req_duration{fase:${fase},tipo:cotizacion_online}`, 'p(95)'),
      p99_ms: valor(`http_req_duration{fase:${fase},tipo:cotizacion_online}`, 'p(99)'),
      max_ms: valor(`http_req_duration{fase:${fase},tipo:cotizacion_online}`, 'max'),
    };
  }

  const picoBatchTps = valor('batch_throughput_perfiles_seg{fase:batch}', 'max');
  const promedioBatchTps = valor('batch_throughput_perfiles_seg{fase:batch}', 'avg');

  const resumen = {
    corrida: CORRIDA,
    faseSegundos: FASE_S,
    rpsOnline: RPS_ONLINE,
    totalPerfilesBatch: TOTAL_PERFILES_BATCH,
    throughputBatchPicoPerfilesSeg: picoBatchTps,
    throughputBatchPromedioPerfilesSeg: promedioBatchTps,
    proyeccion10MillonesHoras:
      promedioBatchTps && promedioBatchTps > 0
        ? Math.round((10000000 / promedioBatchTps / 3600) * 100) / 100
        : null,
    fasesOnline: fases,
  };

  const texto = JSON.stringify(resumen, null, 2);
  return {
    stdout: `\n===== RESUMEN EXPERIMENTO ${CORRIDA} =====\n${texto}\n`,
    [`${CORRIDA}-resumen.json`]: texto,
  };
}
