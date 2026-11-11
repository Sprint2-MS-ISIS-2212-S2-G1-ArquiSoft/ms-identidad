import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TercerosClient } from '../clients/terceros.client';
import { Cliente } from './entities/cliente.entity';
import { IdentidadController } from './identidad.controller';
import { IdentidadService } from './identidad.service';

/**
 * Dominio de Identidad: clientes y su verificacion de identidad.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Cliente])],
  controllers: [IdentidadController],
  providers: [IdentidadService, TercerosClient],
  exports: [IdentidadService],
})
export class IdentidadModule {}
