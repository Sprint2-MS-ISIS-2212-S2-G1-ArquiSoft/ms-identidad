import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Cuerpo de POST /clientes/verificacion.
 *
 * Copia de los campos que Distribucion ya recibia en su CotizarDto: segun la
 * regla 2 de CLAUDE.md los DTOs se copian, nunca se importan de otro servicio.
 */
export class VerificarClienteDto {
  @IsString()
  @IsNotEmpty()
  nombre!: string;

  @IsString()
  @IsNotEmpty()
  documento!: string;
}
