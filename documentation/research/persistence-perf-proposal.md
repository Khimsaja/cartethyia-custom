# Persistence & runtime performance: findings and proposal

Measured on this workspace: one gateway process, full Postgres, loopback stub
upstream, Redis up. Harness: `scripts/perf/{start,seed,upstream,load}.ts`.

The hot-path number is the gateway's own work (auth → admission → routing →
lease → attempt bookkeeping → telemetry → release). The upstream is a stub on
purpose: a real provider's latency would dominate p99 and hide what we are
looking for.

---

## 1. Baseline before any change

| | 40 concurrent | 100 concurrent |
|---|---|---|
| p50 | 156.4 ms | 381.8 ms |
| p95 | 403.8 ms | 619.2 ms |
| p99 | 491.0 ms | 758.6 ms |
| throughput | 201 req/s | 227 req/s |
| idle RSS → peak | 160.4 → 181.9 MB | 167.1 → 167.1 MB |
| after settle | 167.0 MB | 184.5 MB |
| dashboard p95 under load | 443 ms | 1453 ms |
| errors | 0 / 400 | 0 / 1000 |

Two things this baseline already tells us:

- **Reclaim works.** The 40-concurrency run gave back 14.9 MB after settling.
  Memory is not leaking wholesale; it is being *held*.
- **100 concurrent is where the dashboard starts to hurt** (p95 1.45 s), which
  matches the report: "gw ngapa-ngapain di dashboard bikin slowdown".

## 2. After Phase 1 (forced GC off, logger level gate)

| | 40 concurrent | 100 concurrent |
|---|---|---|
| p50 | 173.8 ms | 497.2 ms |
| p95 | 450.0 ms | 1013.5 ms |
| p99 | 693.3 ms | 1169.3 ms |
| idle RSS | 159.7 MB | 156.4 MB |
| after settle | 165.8 MB | 177.4 MB |

**Honest reading: Phase 1 did not improve latency, and the 100-concurrency
numbers moved the wrong way.** I am not claiming a win here. The most likely
explanation is noise — this is a dev machine with a shared Postgres, and the
two runs are single samples, not medians of N. What Phase 1 demonstrably did is
remove two correctness/latency hazards (below). Until each measurement is
repeated 3× and reported as a median, no latency claim in this document should
be treated as established.

---

## 3. Findings, ranked by impact (evidence in `file:line`)

### A. Forced GC was on by default — **fixed**

`src/observability/runtime-metrics.ts:166` ran `Bun.gc(true)` — a *synchronous
full collection* — every 5 minutes whenever in-flight was 0 and RSS had grown
32 MiB. Same file `:137` ran `Bun.gc(false)` under pressure. `gcOnPressure`
defaulted `true` and was not env-wired.

This is the single finding that best matches the reported symptom. A
stop-the-world collection on the shared event loop stalls **every concurrent
request**, which reads as unexplained lag. It also defeats the stated goal: a
process that only returns memory when forced to is still holding it.

Change: `gcOnPressure` now defaults to `false`, gated on a new
`CARTETHYIA_FORCED_GC` flag. Sampling interval 10 s → 30 s, configurable via
`CARTETHYIA_RUNTIME_METRICS_INTERVAL_MS`.

### B. `KEYS` scan on the request path (Redis)

`src/transport/routing/admission.ts:166` — `redis.keys("admission:inflight:*")`.
O(N) over the whole keyspace and **blocking**. Reached from
`RoutingEngine.saturatedCandidates` (`router.ts:403`) on every `plan()`, so
every request that has any candidate with a `max_inflight` ceiling pays it.

It did not fire in my baseline (the seeded route has no ceiling), which is
exactly why it is dangerous: it is invisible until an operator sets a
concurrency limit, and then it is on every request.

### C. Redis client has no command timeout

`src/persistence/redis.ts:75-79` — `{ maxRetriesPerRequest: 2 }`, and no
`commandTimeout` / `connectTimeout` / bounded `retryStrategy`. IP abuse
(`abuse-guard.ts`) runs a Redis `EVAL` on **every** `/v1/*` request before auth
and is fail-closed. A Redis blip therefore becomes unbounded latency or a 503
on every request, not a fast failure.

Also: no `maxmemory`/`maxmemory-policy` is configured on the bundled Redis
(`docker-compose.yml`), and several key families have no TTL or unbounded
cardinality (`cartethyia:model-abuse:bans:ip` never expires;
`cartethyia:ip:<ip>:<route>` has unbounded cardinality where the in-memory
store is capped at 10 000). Reaching a memory ceiling yields OOM write
errors, and admission is fail-closed → 503.

### D. Logger built payloads before checking the level — **fixed**

`src/observability/logger.ts:112-116` — `logArgs` called `safeLogArgs`
(depth-capped deep copy) and `ring()` (`JSON.stringify`) **before** Pino's
level check inside `write`. At the production default (`info`), every
`log.debug` still paid both. `request-context.ts:210` logs at debug on nearly
every chat request.

Verified, not assumed: with `LOG_LEVEL=info`, a debug call no longer enters the
console ring (ring entries 3 → 2), and info/warn still emit unchanged.

### E. Per-request synchronous DB writes

`attempt-finalize.ts:602-660` awaits, sequentially, before the response:
usage commit, `reportAttemptOutcome` (SELECT + UPDATE + health_event INSERT),
pool health (SELECT + UPDATE), payload capture (gzip + file + INSERT). Report
counts **~6 unbatched statements per request**, repeated per failover
candidate.

`commitUsage` must stay awaited — it is the usage accounting. The safe
deferrals are `reportAttemptOutcome` (success branch), pool health, and payload
capture (diagnostic only).

### F. Route snapshot rebuild is expensive and triggered often

`route-catalog.ts:330-346` runs 11 `SELECT`s, several with no predicate
(`models`, `model_aliases`, `model_combos`, `network_pools` — full scans). Worse,
the builder calls `refreshActiveCatalogs?.()` first
(`route-catalog.ts:698-704`), which re-runs `seedBundledModels` — a DELETE per
provider plus a large upsert — **on every rebuild**.

And `account-health-sweep` calls `snapshotService.invalidate()` on any
recovery (`dependencies.ts:255`), so a flapping account turns into: failure →
invalidate → next request pays re-seed + 11 reads. A write-amplification loop
under sustained failure.

### G. Missing indexes and over-fetching

- `models.model_id` bare lookups have **no index** — the only indexes are
  `(provider_id, …)`, left-prefixed on `provider_id`. `public-model-store.ts:555`
  and `routing/model/store.ts:398` query by bare id → seq-scan on the largest
  catalog table.
- `account-health-service.ts:731,897` — full-row `provider_accounts` SELECT on
  **every** attempt outcome, pulling `credential_ciphertext bytea` just to read
  a status. `recordAccountSuccess` fetches it on every success to usually do
  nothing.
- `pool-health-machine.ts:76` — full-row `network_pools` (incl. `endpoint_config
  jsonb`) per dispatch outcome.
- `api-key-store.ts:453` — all 30 `api_keys` columns incl. `key_encrypted bytea`
  on the auth hot path. The SQLite backend narrows this; Postgres does not.

### H. Background services — ranked cutoff list

Source: `src/boot/dependencies.ts`. **None of these has a disable flag today**
except `lease-sweep` (implicitly, via `REDIS_URL` being unset).

| Rank | Service | Interval | Cost | Proposal |
|---|---|---|---|---|
| 1 | `quota-refresh-sweep` | 60 s | 40 accounts/pass, 45 s budget, **real upstream quota traffic** + DB writes | opt-in |
| 2 | daily check-in ride-along | same pass | extra upstream calls + ledger writes | `maxCheckinsPerPass: 0` |
| 3 | `oauth-refresh-sweep` | 60 s | 2000-row join scan **every minute** + sequential token calls | opt-in or 5–10 min |
| 4 | `client-version-monitor` | 15 m | ~20–30 external HTTP fetches; every client has a pinned fallback | lazy: on rejection, not timer |
| 5 | `runtime-metrics` | 10 s | (was) sync GC; now 30 s + GC off | done |
| 6 | `account-health-sweep` | 30 s | 2 DB sweeps; invalidates snapshot → F | 60 s + gate invalidate |
| 7 | `account-enrichment-sweep` | 30 s | converges to empty query | 5–10 min |
| 8 | share-stats SSE | **2 s** | DB read per connected viewer, per tick | 10 s+ or memoize |
| 9 | `pool-agent-sweep` | 60 s | redundant with inline 30 s eviction | drop |

Keep as-is: `inflight-backstop`, `console-session-sweep`, `lease-sweep`, both
flush buffers, SSE keepalives.

### I. Hot-path allocation (lower priority, confirmed present)

- `encoder.ts:135` — `JSON.stringify(event)` **per streamed event**, purely for
  byte accounting.
- `tool-repair.ts:36-70` — `messages.slice()` inside a per-assistant-message
  loop: O(M×N) on long agentic transcripts.
- `logger.ts:150-156` `logError` builds **two** copies of every error.

---

## 4. Proposed execution, in priority order

Each phase ends with a re-measure. Nothing here needs a schema change except
4.4.

**4.1 — Service cutoff (highest value, lowest risk)**
Add one `CARTETHYIA_DISABLED_TASKS` list read in `buildProductionDeps` and
consulted at each `scheduledTasks.register(...)`. One config row covers all
twelve tasks instead of twelve flags. Then disable 1–4 and 9 from the table
above by default for small deployments and document the re-enable.

**4.2 — Redis safety**
- `commandTimeout` + bounded `retryStrategy` on the ioredis client, so an outage
  fails fast instead of hanging every request.
- Replace `KEYS` in `snapshotAccountInflight` with `SCAN`, or maintain a `SET`
  of active inflight keys.
- TTL on `cartethyia:model-abuse:bans:ip`; cardinality bound on the IP/strike
  key families (the in-memory stores already have one at 10 000).
- Set `maxmemory` + `maxmemory-policy` on the bundled Redis.

**4.3 — Batch the per-request writes**
Defer the success branch of `reportAttemptOutcome`, pool-health writes, and
payload capture behind a bounded in-process queue (same pattern as
`TelemetryBatchBuffer`, drained at shutdown). Keep `commitUsage` awaited.
Payload capture needs the promise held in a process-level registry so a restart
does not lose the last N.

**4.4 — Indexes and column projections**
- Add an index on `models.model_id` (migration; new baseline entry).
- Narrow to explicit column lists: `account-health-service` (drop
  `credential_ciphertext`), `pool-health-machine`, `api-key-store` auth read.
- Gate `snapshotService.invalidate()` on a real status change.

**4.5 — Measurement discipline first**
Before claiming any latency win: run each scenario 3×, report the median, and
restart the gateway between runs. My current samples are single-run and the
100-concurrency pair disagrees by more than I can attribute to the change.

---

## 5. Risks and what is not yet proven

- **No latency improvement is proven.** Phase 1 removed two hazards; the
  100-concurrency sample got *worse* (p95 619 → 1014 ms). Until 4.5 lands, treat
  every latency delta here as noise-level.
- `CARTETHYIA_FORCED_GC` is a behavior change for anyone who was relying on
  idle GC. It is documented and reversible via the flag.
- Disabling `quota-refresh-sweep` by default changes product behavior: the
  Quota page becomes a manual refresh unless the operator re-enables the
  sweep. That is a product decision, not purely a technical one.
- The `models.model_id` index needs a migration and a new baseline entry; both
  Postgres and SQLite baselines must move together.
- Redis `commandTimeout` could turn a slow-but-working Redis into fast
  failures. Pick the value against a measured p99, not a guess.
