import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ListarClientesQueryDto {
  /** Filtra el listado por documento de identidad (coincidencia exacta). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  documento?: string;
}
