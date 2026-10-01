# Contributing to Cartethyia

Setup, workflow, and PR checks.

## Prerequisites

- Bun 1.4.2 (see `.bun-version`; Docker pins `oven/bun:1.4.2-debian`)
- PostgreSQL (external in every mode — native and Docker alike)
- Redis for `REDIS_MODE=normal`; optional for `REDIS_MODE=single_instance_local`
- A Node-compatible environment for tooling

## Local setup

```bash
bun install
cp .env.example .env
# Edit DATABASE_URL and CARTETHYIA_ENCRYPTION_KEY in .env.
bun run setup     # copies .env if missing, probes Postgres/Redis (the backend migrates at boot)
bun run doctor    # re-checks the environment and /health/ready
bun run dev       # backend (bun --hot) + dashboard (Vite) under concurrently
```

Useful endpoints once running (`http://localhost:12800` by default):

```text
/health        liveness
/health/ready  readiness (DB + migrations + Redis)
/metrics       Prometheus metrics
/v1/*          gateway APIs
/console       dashboard
```

`bun run dev:backend` and `bun run dashboard:dev` run each half separately.
`bun run dev` runs both under `concurrently`: backend `bun run --hot src/main.ts` on `PORT` (default 12800), dashboard Vite dev server on 5173. No supervisor, no in-place restart — a client hitting the backend mid-restart sees a refused connection. **CTRL+C** stops both.
`VITE_BACKEND_URL` (see `.env.example`) points Vite at the backend. Production serving: `README.md` (Docker Compose).

## Running tests

The repository does not currently carry a test suite. Verification is
`bun run typecheck` for the backend and `bun run dashboard:typecheck` for the
dashboard.

## Verification gate (before every PR)

Backend change:

```bash
bun run typecheck
```

Dashboard change, additionally:

```bash
bun run dashboard:typecheck
```

CI (`.github/workflows/ci.yml`) runs exactly these gates. Typecheck and build
never require Buf, vendor protobuf sources, or network access.

## Code conventions (short version)

What bites new contributors most:

- `src/` production only.
- No `index.ts` barrels; concrete files. `import type` for types. Strict TS: no `any`, no suppressions, no needless assertions; `unknown` + narrowing at boundaries.
- Entity dirs use role filenames: `contracts.ts` (types + validation + operations + routes), `routes.ts`, `store.ts`, `service.ts`, `errors.ts`.
- `scripts/` flat, `ops-*` / `build-*` / `ci-*` prefixes.
- Comments explain policy, security, non-obvious tradeoffs — not the next line.
- `README.md` + `.env.example` product/runtime; `CHANGELOG.md` entries under `Unreleased` stay historical once written.

## Pull requests

- Branch from `main`, keep the change focused, remove callers in the same
  change (no compat shims).
- Fill in `.github/pull_request_template.md`: what changed, gates run, docs updated.
- Every privileged console mutation ends with audit + route-snapshot
  invalidation; every security layer stays fail-closed; telemetry stays
  metadata-only and best-effort.
