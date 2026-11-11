# Solventa · microservicio `identidad`

ISIS-2212 Arquitecturas de software robustas · Grupo 1 · Sprint 2

**Responsabilidad:** Clientes y perfiles de riesgo. Procesa el recálculo batch de perfiles desde Amazon SQS sin afectar el tráfico en línea.

| | |
|---|---|
| Nodo de despliegue | EC2 Soporte |
| Llama a | terceros (HTTP); Amazon SQS (HTTPS) |
| Lo llaman | distribucion |
| Base de datos | BD Identidad (RDS PostgreSQL, Multi-AZ, con read replica) |
| Puerto interno | 3000 |
| Origen en el monolito | `src/modules/identidad` |

## Correr en local

```bash
cp .env.example .env
npm ci
npm run start:dev
```

El despliegue (docker-compose por nodo EC2), el gateway, los certificados y la documentación de experimentos viven en el repositorio paraguas `Sprint2-MS-ISIS-2212-S2-G1-ArquiSoft/ISIS2212_202620_S2_Grupo1`, rama `sprint-2-microservicios`.

## Correr en local con Docker

```bash
docker compose -f docker-compose.local.yml up -d --build
curl localhost:3001/health
docker compose -f docker-compose.local.yml down
```

`docker-compose.local.yml` es **solo para desarrollo**: levanta este servicio
(host `3001` → contenedor `3000`), su propio `postgres:16-alpine` (host `5433`
→ contenedor `5432`), que carga `database/init.sql` al crearse, y un
`terceros-mock`.

`terceros-mock` es un `node:20-alpine` con un servidor HTTP de pocas líneas
que hace de `ms-terceros` mientras ese servicio no esté migrado: responde
`{"valido":true}` a cualquier verificación KYC. Pararlo sirve para probar la
ruta de error:

```bash
docker compose -f docker-compose.local.yml stop terceros-mock   # 503 en /clientes/verificacion
docker compose -f docker-compose.local.yml start terceros-mock
```

Los dos clientes que siembra `database/init.sql` **no vienen del monolito**:
allí el bloque `COPY public.clientes` está vacío y `seed.sql` solo siembra
pólizas y siniestros. Son datos de prueba locales para ejercitar las lecturas.

## Contrato que debe implementar `ms-terceros`

Identidad consume un solo endpoint de Terceros, en `TERCEROS_URL`. Reemplaza
la llamada en proceso `tercerosService.verifyKyc(documento, nombre)` del
monolito:

```
POST {TERCEROS_URL}/kyc/verificaciones
{ "documento": "1020304050", "nombre": "Ana Gomez" }
→ 200 { "valido": true }
```

La llamada lleva timeout de 5 s y propaga `X-Socio-Id`. Los reintentos, el
backoff y el circuit breaker que el mock del monolito traía **no** están aquí:
son tácticas del ASR de Terceros.

## API

Contrato que consume Distribución. Todas las respuestas son
`application/json`.

### `GET /health`

Verifica el servicio y la conexión a la BD (`SELECT 1`).

| | |
|---|---|
| Body | — |
| `200` | `{ "status": "ok" }` |
| `503` | `{ "status": "error", "database": "unreachable" }` |

### `GET /clientes`

Lista los clientes, ordenados por `nombre`.

| | |
|---|---|
| Query | `documento` (opcional): filtra por documento de identidad, coincidencia exacta |
| Body | — |
| `200` | arreglo de clientes (vacío si el filtro no encuentra nada) |
| `400` | `documento` presente pero vacío |

```bash
curl "localhost:3001/clientes?documento=1020304050"
```

```json
[
  {
    "id": "123e4567-e89b-12d3-a456-426614174010",
    "nombre": "Ana Gomez",
    "documento": "1020304050"
  }
]
```

### `GET /clientes/:id`

Un cliente por id. Lo necesita quien tenga una columna `cliente_id` y requiera
el `nombre` o el `documento`: en el monolito eso se resolvía navegando la
relación `cotizacion.cliente`, que al separar los servicios desaparece.

| | |
|---|---|
| Param | `id`: uuid del cliente |
| Body | — |
| `200` | el cliente |
| `404` | `{ "message": "Cliente con id <id> no encontrado", "error": "Not Found", "statusCode": 404 }` |

Un `id` que no sea uuid también devuelve `404`, no `400`: para quien consume,
cualquier id que no exista se comporta igual.

```bash
curl localhost:3001/clientes/123e4567-e89b-12d3-a456-426614174010
```

```json
{
  "id": "123e4567-e89b-12d3-a456-426614174010",
  "nombre": "Ana Gomez",
  "documento": "1020304050"
}
```

### `POST /clientes/verificacion`

Verifica la identidad del cliente y lo registra. Reemplaza la llamada
`identidadService.verificarYGuardar(nombre, documento)` que Distribución hacía
en proceso dentro del monolito, en el paso 3 de `cotizar`.

Busca por `documento`: si el cliente ya existe lo devuelve tal cual y **no**
vuelve a llamar a Terceros; si no existe, verifica el KYC contra Terceros y
solo entonces lo crea. Es idempotente respecto al `documento`, y por eso
devuelve `200` y no `201`.

| | |
|---|---|
| Header | `X-Socio-Id` (opcional): lo inyecta el gateway y se propaga a Terceros |
| Body | `{ "nombre": string, "documento": string }`, ambos obligatorios y no vacíos |
| `200` | el cliente, existente o recién creado |
| `400` | body inválido, o `{ "message": "Fallo en la verificación KYC", ... }` si Terceros responde que el documento no pasa |
| `503` | `{ "message": "Servicio de verificación KYC no disponible", ... }` si Terceros no responde: timeout de 5 s, conexión rechazada o `5xx` |

El `400` y el `503` no son lo mismo y por eso están separados: `400` dice
"este documento no pasó la verificación" y `503` dice "no pudimos verificar".
Colapsarlos haría que Distribución rechazara clientes válidos cuando Terceros
está caído.

```bash
curl -X POST localhost:3001/clientes/verificacion \
  -H 'Content-Type: application/json' \
  -H 'X-Socio-Id: 123e4567-e89b-12d3-a456-426614174001' \
  -d '{"nombre":"Nuevo Cliente","documento":"9999999999"}'
```

```json
{
  "id": "3f1c0e3a-8d2b-4e9f-9a77-5c1d2e3f4a5b",
  "nombre": "Nuevo Cliente",
  "documento": "9999999999"
}
```

Nota: `documento` no tiene restricción `UNIQUE` en la base, igual que en el
monolito. Dos peticiones concurrentes con el mismo documento nuevo pueden
crear dos filas; garantizar lo contrario es idempotencia, es decir táctica de
ASR, y se agrega en su propia rama.
