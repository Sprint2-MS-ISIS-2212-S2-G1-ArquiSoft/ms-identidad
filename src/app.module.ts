import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
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
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 5432),
        username: config.get<string>('DB_USER', 'identidad'),
        password: config.get<string>('DB_PASSWORD', 'identidad'),
        database: config.get<string>('DB_NAME', 'identidad'),
        autoLoadEntities: true,
        synchronize: true,
        logging: config.get<string>('DB_LOGGING') === 'true',
      }),
    }),
    IdentidadModule,
    HealthModule,
  ],
})
export class AppModule {}
