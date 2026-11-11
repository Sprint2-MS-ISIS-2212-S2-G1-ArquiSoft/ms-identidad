import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Cliente de Solventa.
 *
 * Las dos relaciones @OneToMany que existian en el monolito se eliminaron:
 * Suscripcion y Poliza viven en otros microservicios y la llave foranea ya
 * era de su lado (suscripciones."clienteId", polizas."clienteId"), asi que
 * aqui no queda nada. Cliente no es dueno de ninguna llave foranea.
 *
 * Cotizacion tambien apuntaba aqui con un @ManyToOne unidireccional; esa
 * columna de id queda en el microservicio de Cotizacion.
 */
@Entity('clientes')
export class Cliente {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  nombre!: string;

  /**
   * Documento de identidad. Es la llave natural que usa la verificacion,
   * pero no tiene restriccion UNIQUE, igual que en el monolito.
   */
  @Column()
  documento!: string;

  /**
   * Metodo base: el cliente otorga su consentimiento para el acceso
   * a sus datos financieros bajo el esquema Open Finance.
   */
  otorgarConsentimientoOpenFinance(): boolean {
    return true;
  }
}
