import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

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
   * indexada para que el flujo transaccional online responda en < 5 ms
   * incluso con cientos de miles de perfiles en la tabla.
   */
  @Index('idx_clientes_documento')
  @Column()
  documento!: string;

  @Column({ name: 'score_riesgo', type: 'int', default: 50 })
  scoreRiesgo!: number;

  @Column({ name: 'nivel_riesgo', type: 'varchar', default: 'MEDIO' })
  nivelRiesgo!: string;

  @Column({
    name: 'actualizado_en',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
  })
  actualizadoEn!: Date;

  /**
   * Metodo base: el cliente otorga su consentimiento para el acceso
   * a sus datos financieros bajo el esquema Open Finance.
   */
  otorgarConsentimientoOpenFinance(): boolean {
    return true;
  }
}
