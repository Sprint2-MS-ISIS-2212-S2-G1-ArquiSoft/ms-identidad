import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ListarClientesQueryDto } from './dtos/listar-clientes.query.dto';
import { VerificarClienteDto } from './dtos/verificar-cliente.dto';
import { Cliente } from './entities/cliente.entity';
import { IdentidadService } from './identidad.service';

@Controller()
export class IdentidadController {
  constructor(private readonly identidadService: IdentidadService) {}

  @Get('clientes')
  listarClientes(@Query() query: ListarClientesQueryDto): Promise<Cliente[]> {
    return this.identidadService.listarClientes(query.documento);
  }

  /** Sin ParseUUIDPipe a proposito: el 404 lo decide el servicio. */
  @Get('clientes/:id')
  getCliente(@Param('id') id: string): Promise<Cliente> {
    return this.identidadService.getCliente(id);
  }

  /**
   * 200 y no 201: es un get-or-create sobre el documento, no una creacion
   * pura. El X-Socio-Id que inyecta el gateway se propaga hacia Terceros.
   */
  @Post('clientes/verificacion')
  @HttpCode(200)
  verificarCliente(
    @Body() dto: VerificarClienteDto,
    @Headers('x-socio-id') socioId?: string,
  ): Promise<Cliente> {
    return this.identidadService.verificarYGuardar(
      dto.nombre,
      dto.documento,
      socioId,
    );
  }
}
