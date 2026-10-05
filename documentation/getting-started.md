# Getting started

This is the source of truth for installing, running, and checking Cartethyia.

## Requirements

- Bun 1.4.2 or newer.
- PostgreSQL is required only in **Full** mode; **Lite** embeds PostgreSQL with PGlite.
- A terminal and a Node-compatible environment for tooling.
- Redis is optional in both modes. Set `REDIS_URL` to use shared coordination;
  leave it unset for the in-memory backend (single-process deployments).

## Choose a database mode

Cartethyia has the same features in both modes; only the database infrastructure
changes. `.env.example` defaults to Lite for a fresh local install. The Docker
Compose deployment defaults to Full and bundles Redis; override either using its
environment variables.

| | Lite | Full |
|---|---|---|
| Database | Embedded PGlite; no database server to install | External PostgreSQL set by `DATABASE_URL` |
| Default audience | Casual/local, single-process use | VPS, high workload, sharing or selling |
| Extra services | None; Redis is optional | PostgreSQL required; Redis optional, bundled by Compose |
| Data location | `CARTETHYIA_DATA_DIR/pglite` (per-OS default; see below) | Managed by the PostgreSQL server |
| Strengths | Fastest setup, self-contained, low operational overhead | Independent DB service, designed for higher workloads and multi-instance deployments |
| Trade-offs | Single-process; embedded DB is a poor fit for heavy concurrent workloads | Requires operating/reaching a PostgreSQL service |

PGlite is real embedded PostgreSQL, not a different storage format. Move Lite
data to Full by exporting a Cartethyia JSON backup, configuring the Full
instance, then importing that backup in its console. The backup/restore format
is the migration path between modes.

### Lite (recommended for local installs)

Set `CARTETHYIA_DB_MODE=lite` (the `.env.example` default). Do not set
`DATABASE_URL`. Cartethyia stores the embedded database under
`CARTETHYIA_DATA_DIR/pglite`; if `CARTETHYIA_DATA_DIR` is unset, the default is
`%APPDATA%\\Cartethyia` on Windows, `~/Library/Application Support/Cartethyia`
on macOS, and `$XDG_DATA_HOME/Cartethyia` or `~/.local/share/Cartethyia` on Linux.
Set `REDIS_URL` only if shared Redis coordination is wanted.

### Full (recommended for VPS / higher workloads)

Set `CARTETHYIA_DB_MODE=full` and point `DATABASE_URL` at a reachable PostgreSQL
database. Redis remains optional for one process; set `REDIS_URL` for shared
coordination or multiple app instances. Credentials belong in environment
variables, never in the image or checked-in files.

## Choose a setup

### Local setup

The interactive installer asks for Lite or Full. Lite needs no database service.
For Full, use a PostgreSQL server on your computer. On Windows, Laragon is a
simple option; on macOS, Homebrew; on Linux, your distribution's PostgreSQL
package. The installer probes PostgreSQL only when Full is selected.

### Remote or cloud setup

Use Full for VPS/high-workload deployments: set `DATABASE_URL` to a managed or
self-hosted PostgreSQL URL reachable from the Cartethyia service. Use a private
`REDIS_URL` when deploying multiple app instances. Docker Compose defaults to
Full and supplies its Redis URL; PostgreSQL stays external.
## Install the requirements

No PostgreSQL or Redis installation is needed for Lite. For Full, install or
provision PostgreSQL and set `DATABASE_URL`; Redis is optional and is selected
by setting `REDIS_URL`. The installer probes only services required by the
selected mode.

## Configure the environment

From the repository root:

```bash
bun install
```

Cartethyia creates `.env` automatically on the next command. Run `bun setup`;
when attached to a terminal it asks **Lite or Full** if `CARTETHYIA_DB_MODE` is
unset. Use `bun setup --non-interactive` in automation and let the `.env` value
decide. The command:

- detect whether `.env` exists — if not, create it from `.env.example` keeping
  **only mandatory rows** (`KEY=value` without `#`); commented options stay
  commented,
- auto-generate `CARTETHYIA_ENCRYPTION_KEY` when it is missing or still the
  placeholder in an existing `.env` — no other value is ever overwritten,
- create `.env.test` from `.env.test.example` when the test-database URL is
  missing (so `bun run test:backend` has an isolated database).

For Lite, keep the default `CARTETHYIA_DB_MODE=lite`; no `DATABASE_URL` is
needed. For Full, set `CARTETHYIA_DB_MODE=full` and configure a reachable
`DATABASE_URL`. Redis is optional: set `REDIS_URL` for shared coordination or
leave it unset for the in-memory backend.

Check the relevant entries:

```bash
cat .env  # CARTETHYIA_DB_MODE, DATABASE_URL (Full only), CARTETHYIA_ENCRYPTION_KEY
```

### CARTETHYIA_ENCRYPTION_KEY

Required 256-bit secret. It encrypts every stored provider credential and API
key at rest — treat it like a password.

Generation (choose ONE; 32 bytes = 256 bits, either encoding is accepted):

```bash
# macOS / Linux:
openssl rand -hex 32

# Windows (PowerShell):
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))

# Bun / Node (any platform):
bun -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64'))"
```

Paste the output as `CARTETHYIA_ENCRYPTION_KEY` in `.env`. Either 64-char hex
or base64 that decodes to 32 bytes is valid; the helpers (`scripts/internal/env.ts`,
`src/config.ts:decodeEncryptionKey`) validate the length on load. The setup/
install helpers generate one automatically — manual generation is only needed
when you want to rotate the key (use a backup/restore cycle when you do).

`DATABASE_URL` and `CARTETHYIA_PUBLIC_ORIGIN` contain example values — replace
them when your PostgreSQL host/port/database differs; `CARTETHYIA_PUBLIC_ORIGIN`
should be the externally reachable URL for OAuth callbacks/links. `REDIS_URL`
(and the other tunable counters/ceilings) stay commented until you need them;
defaults are commented defaults — deleting the comment would clobber the real
default with an example literal.

## Run the installer

## Start Cartethyia
After the installer completes:

```bash
bun run dev
```

For auto-restart on migrations or dependency changes, run `bun run dev:watch`
instead: source edits still hot-reload, and the supervisor reinstalls deps
(`bun install --frozen-lockfile`) and restarts in place when `migrations/*.sql`,
`package.json`, or `bun.lock` change, so it never needs to be re-run.

Open `http://localhost:12800/console`. Useful endpoints:

| Endpoint | Purpose |
|---|---|
| `/health` | Process liveness |
| `/health/ready` | Database, migration, and readiness status |
| `/metrics` | Prometheus metrics |
| `/v1/*` | Gateway API routes |
| `/console` | Dashboard |
| `/share/:token` | Public child-key enrollment |

Run the halves separately when needed:

```bash
bun run dev:backend
bun run dashboard:dev
```

## Docker

```bash
docker compose up --build -d
docker compose logs -f app
docker compose down
```

Compose defaults to **Full** (`CARTETHYIA_DB_MODE=full`) and points `REDIS_URL`
at its bundled Redis service. Set these in `.env` to choose otherwise:

```dotenv
CARTETHYIA_DB_MODE=lite
# DATABASE_URL is needed only for Full mode.
# REDIS_URL=redis://redis:6379  # omit/empty uses the in-memory backend
```

Full mode still requires an external PostgreSQL reachable through `DATABASE_URL`;
Compose does not bundle PostgreSQL. `/app/data` is a persistent named volume for
the Lite database, install id, and telemetry payloads. Redis starts in either
mode but is idle if `REDIS_URL` is empty.

## Commands

```bash
bun run doctor
bun run typecheck
bun run dashboard:typecheck
bun run dashboard:build
bun run build
bun run start
bun run restart
```

`bun run build` builds the dashboard, prepares the backend with the AOT pass, and
creates `dist/cartethyia`. Docker and the restart command handle graceful shutdown
automatically so active requests get a chance to finish.

## Migrations and backups

Numbered migrations under `migrations/` run automatically at boot and are recorded
in `cartethyia_schema_migrations`.

To move a deployment:

1. Export a backup from **Settings → Backup**.
2. Start the new instance with an empty database.
3. Wait for `/health/ready` to return `200`.
4. Import the backup.

Backups can contain provider credentials and API-key data. Treat them like passwords.

## Test database

PostgreSQL is also the required database for integration and contract checks. Keep it
separate from your development database. The installer creates `.env.test` from
`.env.test.example` when it is missing, so most local setups never have to touch
it. If it already exists it is kept as-is. The suite never falls back to
`DATABASE_URL` — `TEST_DATABASE_URL` is the only URL it reads.

```bash
bun run test-db:check
```

If local PostgreSQL is not available, use the disposable Compose database only as an
optional fallback:

```bash
cp .env.test.example .env.test
bun run test-db:up
bun run test-db:check
bun run test-db:down
```

The repository carries an active test suite (`test/`, `dashboard/test/`, run via
`scripts/ci-run-tests.ts` against the isolated `.env.test` database). Apply
migrations before database-backed checks. Never use production data for tests.

## Verification

Run the relevant gates:

```bash
bun run typecheck
bun run dashboard:typecheck  # when dashboard/ changes
bun run build                # when build or entry contracts change
bun run test:backend         # or: bun run test / dashboard:test / test:watch
```

For behavior changes, exercise the real boundary too: a gateway request, browser
surface, provider flow, or isolated database migration. Typecheck alone does not
prove runtime behavior.
