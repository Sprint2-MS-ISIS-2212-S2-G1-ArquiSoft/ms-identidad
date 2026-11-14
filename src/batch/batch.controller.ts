import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { BatchService } from './batch.service';

@Controller()
export class BatchController {
  constructor(private readonly batchService: BatchService) {}

  /**
   * Metricas en tiempo real del servicio Identidad:
   * - Regla del 70% de conexiones a RDS
   * - Throughput global de reprocesamiento batch (perfiles/seg)
   * - Profundidad de la cola Amazon SQS
   */
  @Get('metricas')
  obtenerMetricas(): Promise<Record<string, unknown>> {
    return this.batchService.obtenerMetricas();
  }

  /**
   * Pobla rapidamente la tabla clientes en RDS (por defecto 100.000 perfiles)
   * usando generate_series de PostgreSQL.
   */
  @Post('batch/seed-db')
  @HttpCode(200)
  seedBaseDatos(@Body() body?: { cantidad?: number }) {
    const cantidad = Number(body?.cantidad ?? 100000);
    return this.batchService.seedPerfilesBaseDatos(cantidad);
  }

  /**
   * Inyecta mensajes micro-batch en Amazon SQS para iniciar el reprocesamiento
   * masivo de perfiles.
   */
  @Post('batch/seed-sqs')
  @HttpCode(200)
  seedColaSqs(
    @Body() body?: { totalPerfiles?: number; perfilesPorMensaje?: number },
  ) {
    const totalPerfiles = Number(body?.totalPerfiles ?? 100000);
    const perfilesPorMensaje = Number(body?.perfilesPorMensaje ?? 50);
    return this.batchService.seedColaSqs(totalPerfiles, perfilesPorMensaje);
  }
}
