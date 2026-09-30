# Persistence

`src/persistence/` is the single persistence boundary for Postgres and Redis.
Every table, enum, index, and shared column helper that the code reads or
writes lives in `schema.ts` (canonical Drizzle source);
`postgres.ts` owns the bounded `pg` pool, the
single `drizzle()` instance, and the SQL-only migration ledger; `redis.ts`
owns the shared ioredis client. All other modules are table operations or
tenant-scoping helpers — no second connection path exists.

## Layout

```text
src/persistence/
  PERSISTENCE.md          this file
  schema.ts               canonical Drizzle source: every table, enum, index, shared type
  postgres.ts             bounded pg Pool + drizzle singleton + migration ledger runner
  redis.ts                shared ioredis client + atomic Lua eval guard
  connection-url.ts       shared connection-string resolution/validation for both clients
  readiness.ts            boot probe (DB + migrations + Redis) with 5s memo
  telemetry-store.ts      event writes, durable usage totals, retention/payload ops
  share-store.ts          enroll/handoff links (hashed lookup + retained ciphertext) + atomic child-key issuance
  tenant-scope.ts         globalOrOwnedBy / ownedByOnly / resolveTenantOverride
  tenant-preferences.ts   console_settings reader + TTL cache + revision counter
  page-cursor.ts          base64url cursor encode/decode with bounded LRU memo
  api-key-store.ts        api_keys CRUD + findActiveByHash (auth source of truth)
```

## Schema groups (`schema.ts`)

- **Identity:** `tenants(id, name, status, created_at)` — root of all FKs.
- **Catalog:** `providers(id, tenant_id NULL=global, capability_profile,
  base_url/compatibility_profile BYOK-only, enabled, requires_account)`;
  `models(provider_id, model_id, endpoint_path, wire_family, service_kind,
  limits, modalities, reasoning/tool_call/web_search, cost, source, enabled)` with
  `models_provider_model_route_uidx`; `tenant_disabled_models` (tenant
  suppression of global/builtin rows; tenant-owned and BYOK rows are toggled
  directly on `models.enabled` instead).
- **Credentials / health:** `provider_accounts` (ciphertext + `auth_state` +
  health machine: `status`, `consecutive_failures`, last
  success/error/cooldown/recovered, `model_cooldowns`, `max_inflight`);
  `provider_oauth_states` 1:0/1 split (`refresh_ciphertext`,
  `client_secret_ciphertext`, `expires_at`, `lease_owner`/`lease_expires_at`
  fenced CAS). `auth_state` holds only non-secret per-account upstream auth
  configuration (auth method, region, profile ARN, OAuth client id, token
  endpoint) — it is carried to the adapter and to token refresh because the
  request depends on it and a single credential string cannot express both;
  `client_secret_ciphertext` is the encrypted companion secret for flows whose
  refresh replays the client credentials their login registered. Secrets never
  live in `auth_state`. `network_pools` (kind, endpoint config, ciphertext,
  `max_inflight`, weight, tenant + health machine + latency/health-check
  columns);
  `health_events` (entity kind + exactly-one-FK CHECK, from/to status, reason,
  error category, and optional affected model for model-scoped throttles).
- **Routing:** `model_aliases(tenant, alias, target_model)`;
  `model_combos(tenant, name, members[], strategy)`;
  `provider_routing_settings(provider_id, tenant_id NULL=global, strategy,
  rotate_count, max_inflight, enabled, bypass_proxy, user_agent)` with dual
  unique indexes (tenant-scoped + partial global). The route User-Agent defaults to Codex but is
  attached only to built-in API-key routes whose adapter metadata does not declare a native
  User-Agent builder; an existing provider or account header remains authoritative. OAuth and
  custom-provider identity settings remain independent;
  `pool_routing_settings(tenant_id PK, strategy, rotate_count)` — the
  pool-group counterpart (absent row reads as `least_loaded`); `telemetry_events`
  carries `error_origin` (cartethyia/upstream/network) beside `error_category`
  because the category alone cannot separate "our bad request" from "upstream
  rejected the request".
- **Inbound keys / sharing:** `api_keys` (personal authentication hashes or
  hashless share templates, child-parent relationship, canonical issued-IP
  identity, encrypted personal-key material, limits and allow/deny lists);
  `share_links` (SHA-256 `token_hash` lookup key plus the retained
  `token_encrypted`, kind `enroll`|`handoff`, active/expiry/last-viewed
  metadata; legacy `used_at` stays stored but is not exposed);
  `console_lockouts` (IP-keyed, survives restart, shared across instances).
- **Ops:** `admin_audit_log` (actor, tenant SET NULL, action, target, detail);
  `console_settings(tenant_id PK, preferences JSONB, updated_at)`;
  `cli_tool_mappings` + `cli_tool_settings`; `telemetry_events`
  (metadata-only by construction — no prompt/body/key columns; catalog FKs
  deliberately omitted so a telemetry write never depends on a provider row);
  `telemetry_usage_totals` (durable per-tenant/account and per-tenant/API-key
  request, error, and token aggregates that survive event retention);
  `telemetry_payloads` (15-minute rows); `studio_sessions` (opaque JSONB).

Enums: `health_status`, `credential_kind`, `wire_family`,
`network_pool_kind`, `health_entity_kind`, `telemetry_source_surface`,
`telemetry_status`, `model_combo_strategy`, `provider_routing_strategy`,
`pool_routing_strategy`.
Shared helpers: `tenantRefNullable/tenantRefRequired/tenantRefPrimaryKey`,
`tenantCascadeSetNull`, `createdAtColumn`/`updatedAtColumn`/
`timestampColumns`, and the `bytea` custom type for envelope-encrypted
ciphertext.

## Connections and migrations

- `postgres.ts`: `requireDatabaseUrl()` resolves the connection string from
  `DATABASE_URL`, then `DATABASE_PRIVATE_URL` / `DATABASE_PUBLIC_URL`, then an
  assembled `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` set. An empty
  value is treated as absent, because an unresolved platform reference yields
  `""` rather than an error; explicit host + port are still required, and no
  host is ever inferred from Docker/Laragon. `poolMaxFromEnv()`; `getPool()`
  and `getDb()` singletons cached on `globalThis` (idle 60s, connect 5s,
  statement 30s, idle-in-transaction 60s, lock 5s, keepAlive; PgBouncer-safe:
  no session state, no LISTEN/NOTIFY). `DATABASE_POOL_MAX` is a per-process
  *ceiling*, not a reservation — connections open on demand, and the proxy path
  issues few (routing comes from the in-process snapshot, admission counters
  live in Redis; a dispatch attempt still does its own credential read and
  health write, and reads tenant preferences behind a short cache), so the
  pool's largest consumers are the console API, one
  telemetry flush, the worker sweeps, auth, and readiness.
  `assertPoolFitsServerCapacity()` runs at boot: it reads the server's
  `max_connections` and refuses a pool that alone meets it, because the gateway
  is designed to run several processes behind `reusePort` and each opens its own
  pool — nothing in one process can see its siblings. Otherwise it logs how many
  processes fit, which is the arithmetic the operator cannot read off the config
  file. Migration ledger:
  `resolveMigrationsFolder()`, per-file `BEGIN` / SQL / ledger insert /
  `COMMIT` under `pg_advisory_lock`, `readMigrationLedgerStatus()` comparing
  discovered files against ledger rows, `ensureMigrated()` once-flag,
  `closeDb()`; `setPoolForTesting()` mirrors `setRedisForTesting()` for the
  capacity check.
- `redis.ts`: `requireRedisUrl()` resolves from `REDIS_URL`, then
  `REDIS_PUBLIC_URL`, then an assembled `REDISHOST`/`REDISPORT`/`REDISUSER`/
  `REDISPASSWORD` set — the same empty-is-absent rule as `postgres.ts`, applied
  through the shared `connection-url.ts`. `getRedis()`
  singleton (`maxRetriesPerRequest: 2`, error logged without crashing);
  `getRedisOrUndefined()` for metrics/readiness paths that must not throw;
  `closeRedis()` (QUIT raced with a bounded timeout, `disconnect()` fallback);
  `redisEvalNumber()` — static-script atomic eval with a finite-number guard
  so a garbled result throws instead of reading as a bogus counter.
- `readiness.ts`: `checkReadiness(db, redis, redisMode, timeoutMs = 5000)`
  memoized for 5s keyed on the full probe identity (db instance, redis
  client, mode, timeout). Order: `SELECT 1` → migration ledger `applied` →
  `redis.ping() === "PONG"` (skipped in `single_instance_local`). Exports
  `RedisMode` + `resolveRedisMode()` which validates `REDIS_MODE`.

## Table stores and helpers

- `telemetry-store.ts`: `DrizzleTelemetryStore(db)` — `insertEvents(rows)`
  writes event batches and upserts account/API-key lifetime totals in one
  transaction; those totals remain after metadata events expire.
  `insertPayload(row)`, `deleteExpiredPayloads()`, and `pruneTelemetry(before)`
  retain the existing payload policy. Metadata retention is configured by
  `CARTETHYIA_TELEMETRY_RETENTION_DAYS` (default 30 days); payload retention is
  15 minutes. `telemetryPayloads` is tenant-gated and defaults to metadata-only
  (`bounded` is an explicit debugging opt-in); rows hold checksummed frame
  references, not bodies (see `observability/OBSERVABILITY.md`).
- `share-store.ts`: `hashShareToken()` (SHA-256); `DrizzleShareLinkStore` —
  creates `enroll` and `handoff` links and resolves only active, unexpired links
  whose parent matches the kind: `resolveShareLink()` returns a discriminated
  `{kind: "enroll" | "handoff"}` result, resolving an `enroll` link only when its
  parent is an active hashless share template and a `handoff` link only when its
  parent is an active personal key, and `null` when the link's kind and the key's
  mode disagree. `issueSharedApiKey()` locks
  parent and link before inserting the policy-inheriting child; the database
  unique-IP violation maps to the one-active-child-per-IP conflict.
- `api-key-store.ts`: list/get/create/update/revoke plus `listChildren()` and
  `findActiveByHash()`. Parent revoke or conversion to personal mode revokes
  children and deactivates links transactionally; hashless templates cannot
  authenticate.
- `api_keys.share_popup_*` stores optional donation/information popup copy and external URL metadata. `0015_api_key_share_popup.sql` adds the nullable fields and constrains mode; image bytes are referenced by HTTPS URL and never uploaded or stored by the gateway.
- `tenant-scope.ts`: `globalOrOwnedBy(column, tenantId)` (NULL rows are
  global; a null requester is a platform identity and matches globals only),
  `ownedByOnly()`, and `resolveTenantOverride(tenantRow, globalRow, default)`
  — whole-row tenant-wins precedence, never a per-field merge. Both
  `transport/routing/route-catalog.ts` and the console provider-detail store
  read through it so dispatch and dashboard never disagree.
- `tenant-preferences.ts`: single-row `console_settings` read plus
  `CachedPreferencesReader` over `TtlCache(5s, 128)` keyed
  `tenantId:revision`, with a process revision counter — the hot dispatch
  path reads preferences without importing dashboard code.
- `page-cursor.ts`: `encodeCursor()` base64url JSON; `decodeCursor()` returns
  `undefined` for missing/malformed input, with a bounded 256-entry LRU memo.

## Rules

- `DATABASE_URL` and `REDIS_URL` are the documented connection sources; a host
  is never inferred. Both resolvers additionally accept the published aliases
  and the discrete variable set (see above), and each of those is a value the
  deployment explicitly provided rather than a guess.
- Schema changes go through `schema.ts` and `migrations/0000_baseline.sql`.
  `migrationFiles()` reads numbered `NNNN_*.sql` files directly from the
  repository's tracked `migrations/` directory and applies them in order at
  boot, recording each in `cartethyia_schema_migrations`. `0000_baseline.sql`
  is the complete schema for a fresh install and `0001_*` and later are forward
  migrations for databases that already recorded an earlier file, so a schema
  change updates the baseline and adds the next numbered file.
- **The baseline must be self-contained.** It is the entire schema for a
  database created today, so a column that exists only in a later numbered file
  reaches an already-migrated database and no fresh one — a new deployment then
  starts missing it while every developer machine looks fine. `network_pools.kind`
  and `telemetry_events.error_origin` were absent from a fresh install exactly
  this way. A change therefore updates `schema.ts`, the baseline, and — when an
  existing database needs to converge — a numbered file, all in one commit.
  `test/contracts/migration-integrity.contract.test.ts` asserts the baseline
  carries the folded-in shape, and `test/integration/isolated-db.test.ts`
  compares a freshly migrated database against `schema.ts` column by column.
- Telemetry event tables stay metadata-only; captured drawer content is written
  to append-only `.jsonb` frame files and `telemetry_payloads` stores only typed
  file-reference columns (`storage`/`file`/`offset`/`length`/`checksum`/`version`)
  — never a jsonb body — opt-in, redacted, and TTL-expired.
