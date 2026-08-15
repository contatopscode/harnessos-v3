# HarnessOS — Postgres deploy (Contabo VPS + shared Postgres)

Pacote pronto pra deploy do HarnessOS no Postgres compartilhado da VPS
Contabo (`213.199.32.229`). O app roda via `docker compose up -d` (Dockerfile
na raiz já tá pronto), o banco é externo (Postgres compartilhado) e as
tabelas são criadas pelo `migrate.sh` antes do primeiro start.

---

## TL;DR — 4 passos

### 1. Criar o banco no Postgres compartilhado (uma vez)

Conecte no Postgres compartilhado (`213.199.32.229:5433`, user admin) e
rode:

```sql
CREATE DATABASE harnessos;
CREATE ROLE archon WITH LOGIN PASSWORD 'SET_ME_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE harnessos TO archon;

\c harnessos
GRANT ALL ON SCHEMA public TO archon;
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- necessário pro gen_random_uuid()
```

### 2. Copiar `.env.production.template` e preencher

```bash
cp deploy/postgres/.env.production.template .env.production
$EDITOR .env.production
# preencher: DB_PASS, MINIMAX_API_KEY, BETTER_AUTH_SECRET (se for usar)
```

### 3. Rodar as migrations

```bash
set -a; source .env.production; set +a
./deploy/postgres/migrate.sh
```

Saída esperada: 27 linhas em `remote_agent_*` (ver `expected-tables.txt`).

### 4. Subir o container

```bash
# Build + run do HarnessOS via docker-compose (já existente na raiz)
docker compose up -d --build
```

Pronto. O server escuta em `:3000` (mapeia pro host no `docker-compose.yml`).

---

## Como o server descobre o DB

O server lê `DATABASE_URL` do ambiente (ou do `~/.archon/.env` que o
`docker-entrypoint.sh` carrega). Quando setado, ele **automaticamente** usa
o adapter Postgres (`@archon/core/db/adapters/postgres.ts`) em vez do
SQLite default. Não precisa mudar nada no código — só a env var.

---

## Adaptar a Memory pra Postgres (OBRIGATÓRIO)

A Memory/RAG (Path B) usa SQLite FTS5 no dev. O `harnessos-postgres-init.sql`
já cria o equivalente Postgres (`tsvector` + `GIN index`). Mas a query path
em `packages/core/src/db/memories.ts` ainda tá FTS5-only — precisa trocar
pelo `memories-postgres-aware.ts` deste pacote.

```bash
# Antes de subir o container
cp deploy/postgres/memories-postgres-aware.ts \
   packages/core/src/db/memories.ts

bun --filter @archon/core type-check
bun test packages/core/src/db/memories.test.ts
```

A versão nova detecta `getDatabaseType()` em runtime e cai no path
Postgres (tsvector + ts_rank_cd) ou SQLite (FTS5 + bm25) automaticamente.
Zero mudança na API pública.

---

## Arquivos deste pacote

| Arquivo                                | O quê                                                                   |
|----------------------------------------|-------------------------------------------------------------------------|
| `harnessos-postgres-init.sql`          | DDL consolidado: 21 tabelas + 2 agents + 1 memory + 4 Better Auth = 27 |
| `memories-postgres-aware.ts`           | Substituição drop-in pro `packages/core/src/db/memories.ts`            |
| `migrate.sh`                           | Roda o SQL via `psql`, idempotente, com listagem final de tabelas       |
| `.env.production.template`             | Todas as env vars que o server precisa, com placeholders               |
| `expected-tables.txt`                  | Lista canônica das 27 tabelas esperadas                                |
| `README.md` (este arquivo)             | Passo-a-passo                                                           |

---

## Notas de versão

- **Versão**: 0.5.0 (HarnessOS rebrand, 15 commits do Deep Upgrade sprint)
- **Postgres mínimo**: 14 (precisa de `gen_random_uuid()` da pgcrypto).
  Postgres 13 também funciona se você trocar pra `uuid_generate_v4()` da
  `uuid-ossp` — é só ajustar o DDL.
- **M3 model id**: `MiniMax-M3` (M maiúsculo, foi como descobri no
  `~/.earendil-works/pi-ai/dist/providers/minimax.models.js`). Se M3 for
  renomeado upstream, atualize `ARCHON_TIER_LARGE_MODEL` no `.env`.
- **Sem dados em prod ainda**: o banco começa vazio. O bundled agents + 12
  workflows bundled seedam sozinhos no primeiro start
  (`bootstrapBundledAgents` no `packages/core/src/agents/index.ts`).
- **Better Auth tables ficam vazias** a menos que `BETTER_AUTH_SECRET` esteja
  setado e você visite `/login` no Web UI. Sem `BETTER_AUTH_SECRET` o
  endpoint `/api/auth/*` retorna 503 e as tabelas ficam dormentes (inocuas).

---

## Opção B: SQLite no container (sem DB externo)

Se você preferir **não** usar o Postgres compartilhado e deixar o app
embutir o DB dele (volume persistente), a única diferença é:
- Não setar `DATABASE_URL` (o server cai pro default SQLite)
- Não rodar o `migrate.sh`
- O `archon.db` vai pra `/var/lib/docker/volumes/archon_data/_data/archon.db`

Mais simples, zero infra externa. Recomendado pra dev/single-user.
Este pacote é **específico pro caminho Postgres** — use
`deploy/sqlite/README.md` (em branco por enquanto, mas basta pular os passos
1-3 do TL;DR acima) se quiser essa rota.

---

## Verificação pós-deploy

```bash
# Server health
curl -s http://localhost:3000/api/codebases

# DB tables
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" \
  -d "$DB_NAME" -c "\dt remote_agent_*"

# Should print 27 rows
```

Se aparecer menos, rode `./deploy/postgres/migrate.sh` de novo — o SQL é
idempotente, então preenche o que falta sem danificar o que já tá lá.
