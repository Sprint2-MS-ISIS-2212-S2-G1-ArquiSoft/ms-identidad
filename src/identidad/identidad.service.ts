import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { Repository } from 'typeorm';
import { TercerosClient } from '../clients/terceros.client';
import { Cliente } from './entities/cliente.entity';

@Injectable()
export class IdentidadService {
  constructor(
    @InjectRepository(Cliente)
    private readonly clienteRepository: Repository<Cliente>,
    private readonly tercerosClient: TercerosClient,
  ) {}

  async listarClientes(documento?: string): Promise<Cliente[]> {
    return this.clienteRepository.find({
      where: documento ? { documento } : {},
      order: { nombre: 'ASC' },
    });
  }

  async getCliente(idCliente: string): Promise<Cliente> {
    // La columna id es uuid: consultar con un id mal formado revienta en
    // Postgres, asi que un id invalido se trata como inexistente (404).
    if (!isUUID(idCliente)) {
      throw new NotFoundException(`Cliente con id ${idCliente} no encontrado`);
    }
    const cliente = await this.clienteRepository.findOne({
      where: { id: idCliente },
    });
    if (!cliente) {
      throw new NotFoundException(`Cliente con id ${idCliente} no encontrado`);
    }
    return cliente;
  }

  /**
   * Busca el cliente por documento y, si no existe, lo crea despues de pasar
   * la verificacion KYC. Es la operacion que Distribucion invocaba en proceso
   * como identidadService.verificarYGuardar(nombre, documento).
   *
   * Idempotente respecto al documento: si ya existe se devuelve tal cual y no
   * se vuelve a llamar a Terceros.
   */
  async verificarYGuardar(
    nombre: string,
    documento: string,
    socioId?: string,
  ): Promise<Cliente> {
    let cliente = await this.clienteRepository.findOne({
      where: { documento },
    });
    if (!cliente) {
      // No existe, verificamos la identidad contra Terceros.
      const kycValido = await this.tercerosClient.verifyKyc(
        documento,
        nombre,
        socioId,
      );
      if (!kycValido) {
        throw new BadRequestException('Fallo en la verificación KYC');
      }

      cliente = this.clienteRepository.create({
        nombre,
        documento,
      });
      cliente = await this.clienteRepository.save(cliente);
    }
    return cliente;
  }
}
