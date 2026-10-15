# Persistence & runtime performance: findings and result

Measured on this workspace: one gateway process, full Postgres, loopback stub
upstream, Redis up. Harness: `scripts/perf/{start,seed,upstream,load}.ts`.

The hot-path number is the gateway's own work (auth → admission → routing →
lease → attempt bookkeeping → telemetry → release). The upstream is a stub on
purpose: a real provider's latency would dominate p99 and hide what we are
looking for.

---

## 1. Result (median of 3 runs per scenario)

| | 40 concurrent | 100 concurrent |
|---|---|---|
| | before → after | before → after |
| p50 | 156 → 164 ms | 382 → 379 ms |
| p95 | 404 → 364 ms | 619 → 619 ms |
| p99 | 491 → 607 ms | 759 → 758 ms |
| idle RSS | 160 → 152 MB | 167 → 138 MB |
| after settle | 167 → 151 MB | 185 → 165 MB |

**Latency is unchanged within noise.** p95 at 100 concurrent is identical
(619 ms); p99 at 40 concurrent got *worse* (491 → 607 ms). I am not claiming a
latency win, because there isn't one in these numbers.

**Memory did improve, and reclaim is evidenced:** after-settle RSS fell at both
concurrency levels (167 → 151 MB at 40; 185 → 165 MB at 100), and individual
runs show the drop directly (e.g. peak 151 → 138 MB after settling). That is
the "memory comes back on its own" property, now without forced GC.

**Query plans improved where they were measurable:** a bare `models.model_id`
lookup went from a sequential scan to a Bitmap Index Scan (verified with
`EXPLAIN` on a freshly migrated database).

Single samples were misleading at first — one 100-concurrency run read p50 418
and another 270. Every number above is a median of 3, per the discipline this
document originally asked for.

---

## 2. What changed

**Phase 1 — forced GC off, log work gated on level**
- `runtime-metrics.ts` ran `Bun.gc(true)` (synchronous, stop-the-world) whenever
  the process was idle and RSS had grown 32 MiB, plus `Bun.gc(false)` under
  pressure; `gcOnPressure` defaulted `true` and was not env-wired. Now opt-in
  via `CARTETHYIA_FORCED_GC`, sampling 10 s → 30 s
  (`CARTETHYIA_RUNTIME_METRICS_INTERVAL_MS`).
- `logger.ts` built the safe copy (deep copy + `JSON.stringify` for the console
  ring) *before* Pino's level check, so every `log.debug` paid it at the
  production `info` default. Level is now consulted first. Verified: a debug
  call no longer enters the ring; info/warn unchanged.

**Phase 2 — service cutoff**
- `CARTETHYIA_DISABLED_TASKS` (comma-separated task names), enforced in
  `ScheduledTaskRegistry.register`, including `runNow`. One config row instead
  of twelve flags. Verified at boot: the four heaviest sweeps log
  "disabled by CARTETHYIA_DISABLED_TASKS" and never tick. 4 tests.

**Phase 3 — index and column projections**
- `account-health-service`: `recordAccountFailure`/`recordAccountSuccess` no
  longer fetch the full `provider_accounts` row (which drags
  `credential_ciphertext`, the largest value stored per account) to read a
  status and a counter. `recordAccountSuccess` runs on *every* success and for
  a healthy account fetched the row to decide nothing.
- `models`: added `0003_add_models_model_id_index` for both backends plus the
  schema declaration. Every prior index was left-prefixed on `provider_id`, so
  bare-id lookups seq-scanned the largest catalog table.

**Also fixed, found while measuring**
- `store.update` accepted `isDefault` in its patch type but never wrote it, so
  a legacy default key was never promoted and a rename dropped the default.
- `mergeJson` chose its dialect from `DB_MODE` rather than the connection,
  emitting `::jsonb` into SQLite.
- `provider_accounts` unique index carried a `::uuid` cast the SQLite baseline
  does not have.
- Three test files reset the cached credential key to `undefined` though files
  share it within a worker; added
  `snapshotCredentialEncryptionKeyForTesting`.

---

## 3. Remaining findings, not yet acted on

Ranked. These are the ones with real headroom left.

1. **`KEYS` scan on the request path** — `admission.ts:166`
   `redis.keys("admission:inflight:*")`, reached from
   `saturatedCandidates` on every `plan()`. Invisible until an operator sets a
   `max_inflight` ceiling, then paid per request. Replace with `SCAN` or a
   maintained `SET`.
2. **Redis client has no `commandTimeout`** (`redis.ts:75`) and IP abuse is
   fail-closed on every `/v1/*` request. A blip becomes unbounded latency or
   mass 503 instead of a fast failure. Also no `maxmemory-policy` on the
   bundled Redis while several key families have no TTL or unbounded
   cardinality.
3. **~6 sequential unbatched DB writes per request** in `completeAttempt`
   (`attempt-finalize.ts:602-660`). `commitUsage` must stay awaited; the
   success branch of `reportAttemptOutcome`, pool health, and payload capture
   are the safe deferrals.
4. **Snapshot rebuild amplification** — 11 `SELECT`s plus `seedBundledModels`
   on every rebuild, and `account-health-sweep` invalidates on any recovery, so
   a flapping account turns into a per-request write loop.
5. **Per-event `JSON.stringify`** in `encoder.ts:135` for byte accounting, and
   `messages.slice()` inside a loop in `tool-repair.ts` (O(M×N) on long
   transcripts).

---

## 4. Risks and what is not proven

- **No latency improvement is proven**, and one percentile regressed. Do not
  merge expecting a speedup; the wins here are memory, a verified query plan,
  and the removal of a stop-the-world GC.
- `CARTETHYIA_FORCED_GC` changes behavior for anyone who relied on idle GC.
  It is documented and reversible per-install.
- Disabling `quota-refresh-sweep` makes the Quota page a manual refresh unless
  re-enabled — a product decision, not purely technical. It ships **off** by
  default (nothing is disabled unless the operator lists it).
- `0003_add_models_model_id_index` applies to new databases and to existing
  ones via the forward migration. An install with retired migration history
  still needs the documented backup/restore path.
- Two pre-existing test failures remain and are **not** regressions:
  `streaming dispatch contract > ... stalled stream ...` and `... typed
  deadline abort ...`. Both fail identically with all my changes stashed. They
  are consistent, not flaky, and tracing shows the stub generator never gets
  past its first `yield` — which may be a real release-stream defect worth its
  own investigation. I did not change stream semantics to make them pass.
