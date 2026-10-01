
# Debug and Live Verify

Every diagnosis and live-verification task. Jump to your section; all share one Verify block at the end. Repo-root commands; use Grep/Read tools, never shell `grep`/`rg` or `ls`/`find`.

| Symptom | Go to |
|---|---|
| Any diagnosis, before you pick a section | 0 Diagnose first |
| 403 FreeTierError, model_not_found / not-allowed, tool_call_sequence_broken, transport_unavailable, egress faults | 1 Dispatch |
| "Failover / round robin not working" | 2 Routing |
| "Did it go via proxy?", `network_pool_id` null, bypass doubt | 3 Proxy check |
| No tool calls, calls vanish / stop early, truncated args, dropped images | 4 Tool-calling |
| Same call emitted twice | 5 Duplicates |
| Proof against the running backend | 6 Live verify |
| Local ledger drift in `cartethyia` / `cartethyia_test` | 7 DB reset |

## 0 Diagnose first

Done when you named the failing stage, stated the expected mechanism, and picked one observation that distinguishes it.

1. **Locate the stage first.** A `/v1/*` request passes: surface parse → canonical request → routing plan → capability projection → leases (admission → pool → reservation) → adapter → upstream → `completeAttempt` → surface encode. Name the owning stage. Most "provider bugs" are routing/capability decisions made earlier — never start at the adapter.
2. **One hypothesis, as a mechanism.** Not "the provider is broken" but "`X` reads `Y`, which is `undefined` when `Z`". Unfalsifiable = not a hypothesis yet.
3. **Pick the discriminating observation.** One probe that separates your hypothesis from the next-most-likely one: raw vs parsed, request vs response, one provider vs one surface, stub vs live. Pick the axis where the two candidates differ, not the easiest log.
4. **Run once, read.** Predicted failure confirms the model. Unpredicted failure is information — correct the model, then act. Re-running the same probe while nudging code is the loop that wastes hours.
5. **Then jump to that stage's section.** Can't name the stage yet → §1 steps 1–2 names it from data, not inference.

Anti-loop rules: never add the same log/assertion twice (a tap that didn't answer never will — change *what* you observe); confirm a restarted process picked up your change before re-running; test one model/case/provider before widening.

## 1 Dispatch debug

Done when: you can name the exact stage (surface parse, routing plan, lease, adapter codec, upstream) and point at the telemetry row plus payload proving it.

1. Trace the wire path first — surface (`chat`/`responses`/`messages`/`completion`) → canonical request → router candidate (`provider_id` + `wire_family`) → adapter codec. Never start at the adapter; most "provider bugs" are routing/capability decisions made earlier.
2. Split causes with the two telemetry tables: `telemetry_events` (`requested_model`, `provider_id`, `network_pool_id`, `status`, `error_category`, `error_origin`) tells fingerprint vs pool vs routing; `telemetry_payloads` is only a typed file-ref index (`storage`/`file`/`offset`/`length`/`checksum`/`version` → read the frame file for client/provider bodies).
   ```sql
   SELECT requested_model, provider_id, network_pool_id, status, error_category, error_origin
     FROM telemetry_events ORDER BY created_at DESC LIMIT 20;
   ```
   Payload capture is off by default (`telemetryPayloads: "none"`) — enable for the tenant, reproduce, read the frame.
3. opencode-family FreeTierError 403: upstream requires agent tools. `FREE_AGENT_TOOLS` + `ensureFreeAgentRequest()` live in `src/providers/integrations/opencode.ts`, wired as `prepareRequest` for `opencodeft`. Fix in canonical `prepareRequest`, never wire JSON; `prePayload` handles only `store: false` / `stream_options`.
4. Tool-sequence 400: every assistant `toolCall` needs a surviving `toolResult`. Shared repair is `repairRequestToolCalls()` (`src/transport/translation/tool-repair.ts`); confirm it survived encode before blaming the provider. Buddy family (`cb`/`cbcn`/`workbuddy`) runs `dropIncompleteToolRounds()` **before** it — order is load-bearing, or the repair synthesizes a placeholder and a partial batch looks complete.
5. Unservable requests are never rerouted to a different model. The planner degrades in place (controls dropped, media → placeholders) and re-plans; the rest fails `capability_unsupported`. Taxonomy in `src/transport/routing/route-model.ts`: `modelNotFoundError` (no match), `ambiguousModelError` (bare id, several providers), `accountsUnavailableError` (matches exist, all unhealthy — 503, retryable), `capabilityUnsupportedError` (planner tries the next degraded variant).
6. CLI variant ids (`model[1m]`, effort suffixes): `[...]`-stripping + `claude-<slot>` fallback in `src/transport/routing/router.ts` (private `normalizeAliasKey` via `resolveAlias`); verbatim match wins. Effort clamps in `clampReasoningEffort` (`src/transport/translation/thinking.ts`).
7. Unsupported feature on a new surface (e.g. prompt caching on `/zen`): parse the feature into the canonical model → declare support on the adapter spec (gated by the predicate in `src/transport/translation/capabilities.ts`) → gate the wire builder → drop only that semantic → live-replay (§6).
8. CodeBuddy 403 `11140` is content policy, NOT auth. `account-health-service.ts` excludes it (plus `safety review` / `content did not pass` / `request illegal` / `content blocked`) from credential-invalidation: no OAuth refresh, no `disabled` flip. A fix that refreshes/disables on 11140 is wrong by construction. One deliberate exception: buddy family `11140` returns 24h `policy_blocked` **cooldown** (never `disabled`) since the block fails every subsequent call — needs `providerId` on the failure evidence via `classifyUpstreamFailure`.
9. Egress DNS is advisory for pool/relay-bound dials; only direct dials require resolution. Aborted outbound DNS → `transport_closed` 499, never `invalid_request` 400 (`resolveAllAddresses`, `src/network/ssrf.ts`).
10. Retry: `isRetryableFailure()` decides failover, `fallbackRetryDelayMs()` spaces it (both `src/transport/failure-policy.ts`). New retryable shape → extend the classifier, not the loop.

**Watch out:** wrong layer (opencodeft injection → `prepareRequest`; 11140 → never the refresh path) / `accounts_unavailable` 503 is capacity, not catalog / bare model id ambiguity is correct behavior / `error_origin` (not just category) says router vs provider vs network.

## 2 Routing triage

Done when: you can show whether it is configuration (`enabled`, `rotateCount`, candidate count) or a real strategy-code bug.

1. Check `enabled` first — `enabled = false` disables every strategy, not just ordering. If both failover and round robin misbehave, suspect `enabled` (`reorderRun()` returns the run unchanged when `!settings.enabled` or `strategy === "fallback"`):
   ```sql
   SELECT tenant_id, provider_id, strategy, enabled, rotate_count
     FROM provider_routing_settings;
   ```
   Ask before querying a user's database. `enabled = false` while the UI shows a strategy is the known bug class.
2. Rule out two false positives before reading strategy code: high `rotateCount` (1–1000, default 1) looks like stuck round robin but is configuration; fewer than 2 candidates means nothing to rotate (`applyProviderRouting` needs `run.length > 1`, and cooling/unhealthy accounts leave `eligible` earlier, so "skips" are correct).
3. Only then read strategy code: `RoundRobinState.next` advances after `servedByCurrent >= rotateCount`; `resolveProviderRouting` prefers the tenant bucket, then `__global__`; combo round robin is separate (`getRoundRobin()` vs `getProviderRoundRobin()`).
4. Schema co-edit: any routing-setting change touches `src/persistence/schema.ts` **and** `migrations/0000_baseline.sql` in the same commit, plus the next numbered migration (applied at boot, no hand-run; see `development.md` §3).

**Watch out:** high `rotateCount` ≠ broken rotation / single candidate = nothing to rotate / tenant vs `__global__` bucket mismatch between dashboard and dispatch.

## 3 Proxy-routing check

Done when: a telemetry-to-pool join (or its principled absence) proves the egress path.

1. A null `network_pool_id` proves nothing until you know which path wrote the row. Dispatch binds via `acquirePoolSlot()` (client UA, chat surface); console probes bind via `outboundFetchFor` (UA `gateway-probe`). Old probe rows may legitimately be null.
2. Authenticate: `POST /console/api/auth/login` with a cookie jar; mutations also need `csrf_token` cookie + matching `x-csrf-token` header. Gateway calls use the `CARTETHYIA_API_KEY` bearer from `.env`.
3. Proof: join the newest `telemetry_events` row to `network_pools` — a non-null pool id whose `kind`/`status`/tenant match `<tenant-id>` (wait ~1.5 s after the call for the buffer flush).
4. Tenant-scoped candidates carry pool ids unless bypassed. Public models (`requiresAccount: false`) keep two candidates — scoped with pools plus `tenant_id: null` without.
5. Bypass mirrors `route-catalog.ts`: `resolveTenantOverride(tenant.bypassProxy, global.bypassProxy, DEFAULT_PROXY_BYPASS_PROVIDER_IDS.has(providerId))`. Only flagged providers bypass by default.
6. After metadata/routing changes, restart via the process manager (operator step), then re-probe. Never claim proxy use from a bare 200.

**Watch out:** null pool id on a probe row is expected / hardcoded counts/UUIDs go stale — use placeholders / no proxy claim without the telemetry-to-pool join.

## 4 Tool-calling triage

Done when: you can attribute it to capability degradation, a wrong persisted row, or a wire-decoder gap — with the fix location named.

1. Check the degradation log first — the fastest signal. `preparer.ts` logs `[routing] degraded request capabilities` with a `degraded: [...]` list (throttled per model + capability set). `"tools"`/`"reasoning"` there is NOT a capability-row problem: `buildCapabilityProfile()` grants them unconditionally, so a `false` in `models.tool_call`/`models.reasoning` never strips them. If the log still names them, the *wire* cannot carry the capability — not the row.
2. The row only controls content modalities and `web_search`. `image`/`document`/`audio` come from the row's declared modalities (falling open for every codec-backed wire); `webSearch` follows `models.web_search`. Requirements derive in `deriveRequiredCapabilities()`; `projectForRoute()` throws `capability_unsupported` per unmet requirement. A `false` on a capable model is recorded metadata, not a routing denial.
3. Wrong modality/`web_search` value → check `source` first. `manual` rows: re-add the model (upsert repairs schema-default rows). `discovered` rows: `false` is absent metadata the profile ignores. `builtin` rows: reconcile on restart via `seedBundledModels`. Only builtin reconciles on restart — manual/discovered need a console re-add. After a DB fix, restart or trigger a console mutation: `/v1/models` may list the model while routing still serves the stale in-process snapshot.
4. Capabilities fine → check wire decoding. Responses wire: `decodeResponsesSseStream` (async generator) must handle argument deltas AND complete-item `response.output_item.done` / `response.function_call_arguments.done` (some backends emit only the complete item — guard with a delta-seen set so streamed calls aren't emitted twice); `mapResponsesStopReason()` must yield `tool_use` when a call was seen. Unterminated stream = truncated. Chat wire: `finish_reason: "tool_calls"` → `tool_use`; missing finish reason = truncated.
5. Verify: `bun run typecheck`, then drive the real pipeline with a throwaway `.tmp-<topic>.ts` and read the printed payload.

**Watch out:** never "fix" by loosening the degradation guard or accepting unterminated streams (truncated args get executed) / discovery `toolCall` disagreements explain metadata, not dropped calls / a control model routing fine on the same provider clears the adapter — check the row.

### Appendix: dropped image attachment

A. Gateway receive? Group telemetry by client on `request_body` containing `image_url` — `with_img = 0` means the client never sent it: client bug, stop. Payload rows expire (~15 min TTL); extract hashes immediately.
B. Gateway forward? Diff `request_body` vs `provider_request_body` in the frame the row's typed file columns name (`data:image` counts + lengths). Equal = lossless, look downstream.
C. Ablate shape with a tiny test PNG: (a) text+image in one message, (b) image-only then text-only, (c) image-only then two texts, (d) repeat (a) on a second model. Bundled works but split loses the image on one provider only → upstream merges same-role messages and drops the image part; fix that adapter (coalesce text+image) with a regression test on the provider-bound payload.
D. `image` falls open for every codec-backed wire — the route carries the part and the upstream decides. Only bespoke adapters (Cursor, Devin; `providerUsesBespokeWire`) need an explicit `image` modality, since they frame their own protocol.

## 5 Duplicate tool calls

Done when: the upstream wire (not the decoder) is proven as the source and the ledger covers the shape.

1. Rule 0: one `tool_call_delta` per upstream tool item. A proxy decoder emits what the upstream sent — doubled actions mean the upstream likely sent two items. Verify on the native wire first (responses-family → `/v1/responses`) with generous `max_output_tokens`; read the output item ids. Known shape: one logical call as TWO items, identical suffix, `call_` vs `fc_` prefix, same name/args.
2. Single authority: `src/transport/tool-identity.ts`. `toolIdentityKey()` normalizes the `call_`/`fc_` prefix — the ONLY place that prefix is interpreted. `createToolEmitLedger()` gates call-defining events. No per-path Sets, no pasted prefix patterns elsewhere. `isDuplicateDefinition()` applies name+arguments fallback only to unknown prefixes; `call_`/`fc_` return false so legitimate identical parallel calls survive.
3. Budget twin: `finish_reason: length` with tokens burned on reasoning is a budget problem, not decoding — sweep `max_tokens` for the flip to `tool_calls`. `TOOL_CALL_MAX_TOKENS_FLOOR = 32_000` (`src/protocol/request/messages.ts`) is Anthropic/Messages-wire only; generalizing it is an operator cost decision.

**Watch out:** read the upstream items before assuming a decoder bug / never re-add per-path dedupe Sets — they rot, the ledger is the one gate / name+args fallback on known prefixes suppresses legitimate parallel calls.

## 6 Live verify

Done when: a real request completes and the log, telemetry, and payload rows assert the expected values.

1. Rebuild rule: a `dashboard/src/**` change MUST run `bun run dashboard:build` first — the backend serves the prebuilt `dist/dashboard`; without a rebuild you debug a stale bundle. Restart the backend (operator step), wait for the port (default 12800; `PORT` overrides). Resolve a real `<provider>/<model>` id — never assume a prefix.
2. Authenticate: `POST /console/api/auth/login` with console credentials in a cookie jar (`session_token` HttpOnly + `csrf_token`; mutations also send `x-csrf-token`). Gateway calls use the `CARTETHYIA_API_KEY` bearer from `.env`. Login failures lock by `identifier:clientIp`.
3. Clear the ring (`DELETE /console/api/logs`), fire exactly one probe:
   ```bash
   curl -sS -N --max-time 180 -H 'content-type: application/json' \
     -H "authorization: Bearer <CARTETHYIA_API_KEY>" \
     -d '{"model":"<provider>/<model>","messages":[{"role":"user","content":"Reply with exactly: PONG"}],"max_tokens":20}' \
     http://127.0.0.1:12800/v1/chat/completions
   ```
4. Read `GET /console/api/logs?limit=200` (ring capacity 500, messages truncate at 2000 chars). Lines with `event` are lifecycle events: `request_start` (method, endpoint, clientIp), `request_complete` (model, providerId, accountId, networkPoolId, status, durationMs, `details` tokens + cost), `request_error` (status, errorCode), `token_refresh` (accountId, providerId, `details.expiresAt`). Assert real values matching the HTTP result, not line existence.
5. Forcing `token_refresh`: the sweep covers only accounts expiring within `OAUTH_REFRESH_SKEW_MS` (5 min). Move one into the window instead of waiting:
   ```sql
   UPDATE provider_oauth_states SET expires_at = now() + interval '90 seconds'
     WHERE provider_account_id = '<id>';
   ```
   Wait ~75 s, re-read the log, confirm the expiry actually advanced (proves refresh happened, not just attempted).
6. DB reads via `pg` (`new pg.Client(...)`), as throwaway repo-root `.mjs` files deleted afterwards. Assert the newest `telemetry_events` row (endpoint, `telemetry_status`, requested model) and the payload row (`expires_at - captured_at` = 15-minute retention).
7. Drawer + kill-switch matrix: `GET /console/api/system/usage/requests/:requestId` (masked IP by default; payload keys `request`/`response`/`clientResponse`/`providerRequest`/`providerResponse`); `PATCH /console/api/settings/runtime` `{"telemetryPayloads":"none"}` → zero new payload rows, then back to `bounded`; `PATCH {"privacyMode":"full"}` reveals IPs, then reset to `masked`.
8. Client capture (last resort): tiny logging proxy on a nearby port (bodies outside the repo), redirect via the client's settings file (stored values beat env — back up, restore byte-identical, verify), drive in a real TTY. Proof = newest `telemetry_events` row flipping to `completed` with a real provider + non-trivial latency. Stop the proxy, delete temps, `git status` shows only the intended change.

**Watch out:** stale bundle (forgot `dashboard:build`) / asserting line existence instead of values / kill-switches left flipped (`none`/`full`) / throwaway `.mjs` or proxy bodies left in the repo.

## 7 DB reset

Done when: both databases are fresh, migrated, seeded, and integration-capable — with the backups named in the report.

1. Confirm local Postgres (names, sizes, connections, migration dir) and that the target is not production. No approval, no reset.
2. Rename, never drop: `cartethyia` → `cartethyia_pre_reset_YYYYMMDD` (same for `_test`; terminate connections first, recreate fresh). Drops need a separate approval.
3. Boot the backend once against the fresh main DB — migrations + production seeding run during init. Verify the ledger holds `0000_baseline.sql`, `/health/ready` 200, sane provider/model counts. Stop the smoke backend.
4. Point the app at the fresh test DB when you need to exercise DB-backed paths (`db-gate.ts` repoints `DATABASE_URL` there before any pool opens):
   ```powershell
   $env:CARTETHYIA_TEST_DATABASE_URL = "postgres://postgres:<password>@localhost:5432/cartethyia_test"
   $env:REDIS_MODE = "single_instance_local"
   ```
5. Report the backup names; they stay until the operator drops them.

**Watch out:** `VAR=...` prefix form doesn't work in PowerShell (`$env:` instead) / migrating only one DB leaves the other drifted / no smoke-boot means seeding never runs.

## Verify

Shared gate — `bun run typecheck`. Dashboard touched → add `dashboard:typecheck` and `dashboard:build`. The repository does not currently carry a test suite, so prove a behavior change by driving the real path (a live request, a `.tmp-<topic>.ts` against the real pipeline, or the browser) and reporting what you observed.
