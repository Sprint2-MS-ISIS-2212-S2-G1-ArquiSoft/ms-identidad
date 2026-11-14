import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BatchModule } from './batch/batch.module';
import { HealthModule } from './health/health.module';
import { IdentidadModule } from './identidad/identidad.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const host =
          config.get<string>('DB_PRIMARY_HOST') ||
          config.get<string>('DB_HOST', 'localhost');
        const primaryUrl = config.get<string>('DB_PRIMARY_URL');
        const rdsMax = Number(config.get<string>('RDS_MAX_CONNECTIONS', '100'));
        const apiBudget = Math.max(5, Math.floor(rdsMax * 0.3));
        const poolSize = Math.min(
          Number(config.get<string>('DB_POOL_SIZE', '15')),
          apiBudget,
        );
        const useSsl =
          config.get<string>('DB_SSL') === 'true' ||
          host.includes('.rds.amazonaws.com') ||
          Boolean(primaryUrl && primaryUrl.includes('.rds.amazonaws.com'));

        return {
          type: 'postgres',
          ...(primaryUrl
            ? { url: primaryUrl }
            : {
                host,
                port: config.get<number>('DB_PORT', 5432),
                username: config.get<string>('DB_USER', 'identidad'),
                password: config.get<string>('DB_PASSWORD', 'identidad'),
                database: config.get<string>('DB_NAME', 'identidad'),
              }),
          ssl: useSsl ? { rejectUnauthorized: false } : false,
          extra: {
            max: poolSize,
          },
          autoLoadEntities: true,
          synchronize: true,
          logging: config.get<string>('DB_LOGGING') === 'true',
        };
      },
    }),
    IdentidadModule,
    BatchModule,
    HealthModule,
  ],
})
export class AppModule {}
