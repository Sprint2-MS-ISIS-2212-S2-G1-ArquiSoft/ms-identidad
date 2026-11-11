import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Timeout de toda llamada saliente hacia Terceros (regla 5 de CLAUDE.md). */
const TIMEOUT_MS = 5000;

interface RespuestaVerificacionKyc {
  valido: boolean;
}

/**
 * Cliente HTTP hacia el microservicio terceros.
 *
 * En el monolito esto era una llamada en proceso a TercerosService.verifyKyc().
 * Los reintentos, el backoff y el circuit breaker que ese mock traia NO se
 * migran: son tacticas del ASR de Terceros y se agregan en su propia rama.
 * Aqui solo queda el timeout, que es obligatorio, y la propagacion de
 * X-Socio-Id.
 */
@Injectable()
export class TercerosClient {
  private readonly logger = new Logger(TercerosClient.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Verifica la identidad del cliente contra el proveedor KYC.
   *
   * Distingue dos fallos distintos a proposito:
   * - devuelve `false` cuando Terceros responde que el documento no pasa la
   *   verificacion, lo que el servicio traduce a 400;
   * - lanza ServiceUnavailableException (503) cuando Terceros no responde
   *   (timeout, conexion rechazada o 5xx), porque "no pudimos verificar" no
   *   es lo mismo que "no pasa la verificacion".
   *
   * Ojo con el orden de los argumentos: la firma del monolito es
   * verifyKyc(documento, nombre), invertida respecto a verificarYGuardar.
   */
  async verifyKyc(
    documento: string,
    nombre: string,
    socioId?: string,
  ): Promise<boolean> {
    const baseUrl = this.config.get<string>('TERCEROS_URL');
    if (!baseUrl) {
      throw new ServiceUnavailableException(
        'Servicio de verificación KYC no disponible',
      );
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (socioId) {
      headers['X-Socio-Id'] = socioId;
    }

    let respuesta: Response;
    try {
      respuesta = await fetch(`${baseUrl}/kyc/verificaciones`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ documento, nombre }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // Timeout o conexion rechazada: Terceros no respondio.
      this.logger.error(
        `Terceros no respondio al verificar KYC: ${String(error)}`,
      );
      throw new ServiceUnavailableException(
        'Servicio de verificación KYC no disponible',
      );
    }

    if (respuesta.status >= 500) {
      this.logger.error(
        `Terceros respondio ${respuesta.status} al verificar KYC`,
      );
      throw new ServiceUnavailableException(
        'Servicio de verificación KYC no disponible',
      );
    }

    if (!respuesta.ok) {
      // 4xx: Terceros rechaza la peticion, se trata como KYC no superado.
      this.logger.warn(
        `Terceros respondio ${respuesta.status} al verificar KYC`,
      );
      return false;
    }

    const cuerpo = (await respuesta.json()) as RespuestaVerificacionKyc;
    return cuerpo.valido === true;
  }
}
