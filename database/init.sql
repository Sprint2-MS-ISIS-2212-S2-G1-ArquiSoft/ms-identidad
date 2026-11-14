--
-- BD Identidad · esquema y datos semilla del microservicio identidad.
-- Extraido de database/solventa.sql del monolito modular.
-- Solo las tablas que pertenecen a Identidad: no se replican las llaves
-- foraneas que apuntaban aqui, porque sus tablas viven en otros
-- microservicios:
--   suscripciones."clienteId" -> clientes(id)  (FK_74405abcf98eba0035238a326d1)
--   polizas."clienteId"       -> clientes(id)  (FK_e6810b42bf7069c220b6f7a4f1b)
-- La tabla clientes no tiene llaves foraneas salientes.
--
-- Identidad no aporta ningun tipo enum ni indice: el dump del monolito no
-- tiene ninguno para este dominio.
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;

--
-- Name: clientes; Type: TABLE
--
-- documento es la llave natural que usa POST /clientes/verificacion, pero no
-- lleva UNIQUE: tampoco lo tenia en el monolito. Garantizar unicidad bajo
-- concurrencia es idempotencia, o sea tactica de ASR, y se agrega aparte.
--
CREATE TABLE IF NOT EXISTS public.clientes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    nombre character varying NOT NULL,
    documento character varying NOT NULL,
    score_riesgo integer DEFAULT 50 NOT NULL,
    nivel_riesgo character varying DEFAULT 'MEDIO' NOT NULL,
    actualizado_en timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT "PK_d76bf3571d906e4e86470482c08" PRIMARY KEY (id)
);

ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS score_riesgo integer DEFAULT 50 NOT NULL;
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS nivel_riesgo character varying DEFAULT 'MEDIO' NOT NULL;
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS actualizado_en timestamp without time zone DEFAULT now() NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clientes_documento ON public.clientes(documento);

CREATE TABLE IF NOT EXISTS public.batch_workers_metricas (
    worker_id character varying PRIMARY KEY,
    perfiles_procesados bigint DEFAULT 0 NOT NULL,
    lotes_procesados bigint DEFAULT 0 NOT NULL,
    throughput_reciente numeric(10,2) DEFAULT 0 NOT NULL,
    latencia_replica_ms numeric(10,2) DEFAULT 0 NOT NULL,
    latencia_primary_ms numeric(10,2) DEFAULT 0 NOT NULL,
    pool_replica_size integer DEFAULT 0 NOT NULL,
    pool_primary_size integer DEFAULT 0 NOT NULL,
    actualizado_en timestamp without time zone DEFAULT now() NOT NULL
);

--
-- Datos semilla
--
-- El monolito no trae ninguna fila de clientes: en solventa.sql el bloque
-- COPY public.clientes esta vacio y seed.sql solo siembra polizas y
-- siniestros del experimento GDC-CDP-01-L01. Estas dos filas son datos de
-- prueba locales para poder ejercitar los endpoints de lectura.
--
INSERT INTO public.clientes (id, nombre, documento)
VALUES ('123e4567-e89b-12d3-a456-426614174010', 'Ana Gomez', '1020304050')
ON CONFLICT DO NOTHING;

INSERT INTO public.clientes (id, nombre, documento)
VALUES ('123e4567-e89b-12d3-a456-426614174011', 'Bruno Pardo', '1020304051')
ON CONFLICT DO NOTHING;
