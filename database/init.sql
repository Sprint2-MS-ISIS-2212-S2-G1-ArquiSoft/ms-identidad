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
    CONSTRAINT "PK_d76bf3571d906e4e86470482c08" PRIMARY KEY (id)
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
