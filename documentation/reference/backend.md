# Backend

`src/` is the production backend: one Elysia process. `src/main.ts` calls
`bootstrap()`, then `createGatewayApp()`. The app serves the public gateway, the
console API, and the built dashboard. Dashboard code must not import this tree;
contracts cross the boundary as JSON.

## Boot

`buildProductionDeps()` (`src/boot/dependencies.ts`) is the composition root:
database, Redis or memory, provider registry, route snapshot, admission, usage
flush buffer, scheduled tasks. Lite migrates while opening SQLite; Full
migrates in `ensureMigrated()` under `pg_advisory_lock`. Pool size is checked
only for Full — `DATABASE_POOL_MAX` must be below the server's
`max_connections`; a server refusing `SHOW max_connections` logs and
continues.

## Public routes

Mounted by `createGatewayApp()` in `src/boot/app.ts`.

| Method | Path | Owner |
| --- | --- | --- |
| GET | `/health`, `/health/ready` | liveness; readiness checks migration ledger + dependencies |
| GET | `/metrics` | process metrics |
| POST | `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/completions` | `handleProviderProxyRequest` (one handler for the four translated surfaces) |
| POST | `/v1/responses/compact` | `createResponsesCompactHandler` |
| POST | `/v1/systemone` | `createSystemoneHandler` |
| POST | `/v1/search` | `createWebsearchHandler` |
| GET | `/v1/models`, `/v1/models/info`, `/v1/models/*` | model list and detail |
| POST | `/admin/drain` | drain, only when `CARTETHYIA_DRAIN_TOKEN` is set |

Compact, System One, and search have their own handlers (they do not share the
translation loop) but take the same preparer, snapshot, pool selector, and
telemetry buffer; without the buffer the route writes no usage.

## Dispatch

`src/transport/dispatch/proxy-request.ts` owns `handleProviderProxyRequest`:
authenticated request → `ProxyRequestPreparer.prepare()` → canonical request →
`RoutingEngine` plan → `runAttemptLoop` → leases → provider adapter → stream
(`dispatchStreamingAttempt`) or buffered response → `completeAttempt` →
release. A retryable failure releases the lease and tries the next candidate;
a terminal failure becomes a `GatewayError` and stops.

Retryability is decided in `src/transport/failure-policy.ts`. An overflow
(`context_length_exceeded`) is retryable — it names how large the prompt was
against the window *that* candidate offered, so a sibling with more room is
tried unchanged. Nothing in the loop shrinks or rewrites the prompt; a client
compacts on the 413 it receives once every candidate has overflowed.

Streaming owns its own cleanup: `ProxyRequestStateStore.cleanup()` is the
single release point (completion, error, cancel, client abort, deadline,
stall). A pending pull owns its terminal outcome and is not released twice.

## Protocol

`src/protocol/canonical-model.ts` is the request the rest of the backend sees;
`registry.ts` encodes and decodes the three wire families.

| Wire family | Request encoder | Response decoder |
| --- | --- | --- |
| `chat` | `canonicalToChatPayload` | `parseChatResponseToEvents`, `decodeChatSseStream` |
| `responses` | `canonicalToResponsesPayload` | `parseResponsesResponseToEvents`, `decodeResponsesSseStream` |
| `messages` | `canonicalToClaudeMessagesPayload` | `claudeResponseToEvents`, `parseClaudeSseStream` |

`GatewayError` carries a stable code, an origin (`cartethyia`, `upstream`,
`network`), and a public body; adapters map upstream failures into that type
and never throw bare strings across the dispatch boundary. Tool call identity
(`src/protocol/tool-identity.ts`) keeps one id across streamed deltas.
Reasoning is one canonical part whether the client sent a thinking block,
`reasoning_content`, or a Responses reasoning item; empty reasoning is
preserved, not invented.

## Providers

`src/providers/provider-registry.ts` is the registry; `default-registry.ts`
registers the bundled adapters; `registerByokProviders` adds operator rows. The
upstream host list used for SSRF is live: a provider added after boot is bound
on the next request, not at the next process start.

| Path | Role |
| --- | --- |
| `adapters/` | Per-provider HTTP and stream framing |
| `authentication/` | Token, OAuth refresh, credential envelope |
| `discovery/` | Offline catalog (`base-models.json`) and live probe |
| `operations/` | Account import, probe, enable, disable |
| `quota/` | Provider quota windows; cached readings also inform Usage floor routing |
| `configured-provider.ts` | Declarative `ApiKeyProviderSpec` rows for standard OpenAI-compatible providers |
| `search/` | Hosted search tools and grounding |

Per-account quota thresholds are applied during route eligibility; they are not
account health state. See [Usage floor](../features/usage-floor.md).
`base-adapter.ts` and `compatible-adapter.ts` cover standard-wire providers; a
bespoke provider frames its own bytes in its adapter — that fact lives on
provider metadata, not in `wire_family`. Details:
[Providers](providers.md).

## Routing and network

`src/transport/routing/router.ts` plans; `route-model.ts` holds the snapshot
types and `InMemoryRouteSnapshotService`; `admission.ts`/`reservations.ts`
hold slots and leases; `round-robin.ts` keeps the per-provider cursor. Three
independently configured strategies: provider, pool, and combo (all `fallback`
or `round_robin`) — see [network pools](../features/network-pools.md) and
[routing aliases and combos](../features/routing-aliases-combos.md).

`src/network/` is the egress half: `pool/` selects a pool and accounts bytes,
`ssrf.ts` rejects disallowed destinations, `retry.ts` is the outbound retry
policy — distinct from the routing failover loop.

## Security

| Module | Duty |
| --- | --- |
| `api-key-auth.ts` | Hash lookup, enabled check, scope check |
| `admission/` | Per-key and per-tenant concurrency, lifetime counters |
| `model-access-rule.ts` | `whitelist` or `blacklist` plus one `model_list` |
| `csrf.ts` | Console mutation token |
| `abuse.ts`, `model-abuse.ts` | IP and model abuse gates |
| `ip-boundary.ts` | Trusted proxy peer resolution |
| `crypto.ts` | Key hashing and secret encryption |

An API key no longer carries a provider allowlist; model access is one mode
and one list. A key with `routing:invoke` does not silently gain
`search:invoke` — that grant is stored explicitly. Console sessions are
cookies, expired ones deleted by the hourly `console-session-sweep`; login
returns a user only when exactly one row matches the username.

## Persistence

`src/persistence/schema.ts` is the Drizzle source. The baselines define the
foundational schema; SQLite's baseline is generated from PostgreSQL. Preserve
released baseline files (their hashes are recorded in deployed databases).
Matching numbered migrations bring both backends to the current schema and
upgrade supported existing databases; databases with retired migration history
must be recreated from the baseline and recovered through backup/restore, which
maps legacy routing names and values (`bypass_proxy`, `bridge`, the old
provider User-Agent default, Cline's skip-proxy default, `fusion`) before
inserting rows.

Stores live in `src/persistence/stores/` and under the console domain owning
the table. `tenant-scope.ts` holds `globalOrOwnedBy`: a `NULL` tenant id is a
shared row — replacing it with `eq(tenantId)` hides shared catalog rows, and
the reverse is also wrong (quota and OAuth owner checks use `eq` on purpose).
`usage-flush.ts` coalesces admission counters: one update per key per flush.

## Observability

`src/observability/event-log.ts` appends one JSON object per request to
`data/telemetry-events/YYYY-MM-DDTHH.jsonl`; console usage, health, and share
stats read those files through `queryTelemetryEvents`; lifetime totals stay in
`telemetry_usage_totals`. `isGatewayError(status, httpStatus)` is the only
error predicate — 4xx, 499, 503, 529 are recorded but not gateway errors.

`telemetry-buffer.ts` batches inserts; the file appends after the aggregate
transaction commits, a rejected batch is not rewritten per retry, and a
non-UUID `tenantId` drops the batch. `payload-capture.ts` writes gzipped JSON
frame files, indexed by `telemetry_payloads` rows naming their encoding
(`jsonl-file` gzipped, `jsonb-file` pre-compression). Retention prunes by hour
prefix and never touches the current hour.

## Console API

`src/console/console-router.ts` mounts `/console/api`; CSRF and the mutation
limiter wrap every domain; `domain-registration.ts` attaches the domains.
Full surface table: [Console API](console-api.md).

| Prefix | Domain |
| --- | --- |
| auth routes | session, setup, lockout |
| `/providers` | catalog, detail, OAuth login |
| `/routing`, `/network/pools` | aliases and combos, egress pools |
| `/api-keys` | keys, share links, popups |
| `/cli-tools` | per-key CLI mappings |
| `/settings/runtime` | tenant preferences |
| `/backup` | export and restore, re-authenticates |
| `/studio` | model lab sessions |
| observability, live, logs, audit | usage, health, log ring, audit |

Backup restore drops columns listed in `LEGACY_DROPPED_COLUMNS`: an old backup
still carrying `share_popup_*`, `credit_limit`, or `used_at` restores without
recreating them.

## Workers

`src/workers/` keeps scheduling mechanics and jobs as flat modules:
`scheduler.ts` (task timers, non-overlap, shutdown, concurrency waves),
`sweep-runner.ts` (shared bounded runner for account sweeps),
`quota-refresh-sweep.ts` (stale quota + daily check-in ride-along),
`oauth-refresh-sweep.ts` (due credential refresh), `daily-checkin.ts` (claims
check-ins, reports Buddy activity; the quota sweep supplies tenant-safe
egress), `account-identity-sweep.ts` (derives account label/email from stored
credentials).

`src/boot/dependencies.ts` registers these with the scheduler. Other periodic
jobs stay beside their owning domains (session cleanup under
`src/console/auth/`, health cleanup under `src/providers/operations/`). A task
needing persistence receives the composition root's database handle; it does
not open a second pool. The composition root logs named startup phases with
elapsed time and RSS/heap — `[startup]` lines are phase diagnostics, not
steady-state memory benchmarks. Client version refresh is deliberately
deferred after startup.

## Where to change what

| Change | Start here |
| --- | --- |
| New client field | `canonical-model.ts`, then both encoders and decoders that must carry it |
| New provider | a spec in `configured-provider.ts` (standard OpenAI shape) or a family under `integrations/`, then the registry and discovery catalog |
| Routing rule | `router.ts` and `route-model.ts`, then the snapshot builder |
| Console resource | the domain under `src/console/`, then the dashboard hook that calls it |
| Schema | `schema.ts`, `migrations/full-postgres/0000_baseline.sql`, then regenerate SQLite with `scripts/generate/sqlite-ddl.ts` |
