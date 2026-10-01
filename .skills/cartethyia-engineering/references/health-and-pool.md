# Health and pool policy

Account + proxy-pool classification: which upstream errors disable, cool down, or degrade, and how cooldown windows are decided. Consolidates the account-health policy, health-classification, health-event display, and tool-repair invariant skills.

## Authorities (do not fork them)

| Concern | File |
|---|---|
| Account classification | `src/providers/operations/account-health-service.ts` (`classifyAccountError`, `AccountErrorCategory`, `recordAccountFailure`, `persistAccountFailure`, `sweepExpiredCooldownsFor`) |
| Failure → evidence bridge | `src/transport/failure-policy.ts` (`classifyUpstreamFailure`, `statusToErrorCategory`, `mapUpstreamHttpError`, `parseProviderResetDuration`, `parseAbsoluteResetTimestamp`) |
| Proxy-pool health machine | `src/network/pool-health-machine.ts` (`recordPoolDispatchOutcome`, `disablePoolForProxyHttpStatus`) |
| Pool probe classification | `src/console/routing/pools/probe-result.ts` (`classifyPoolProbeResponse`, `classifyPoolConnectError`) |
| Dispatch completion hook | `src/transport/dispatch/attempt-finalize.ts` (`completeAttempt`) |
| OAuth-refresh eligibility | `src/transport/dispatch/retry-policy.ts` (`isOAuthCredentialInvalidated`, `shouldCooldownPool`) |
| Cooldown knobs | `src/config.ts` (`CONFIG_SPEC` + `resolve*CooldownMs`) and `.env.example` |
| UI badges | `dashboard/src/routes/provider-detail/Accounts.tsx`, `dashboard/src/routes/Proxy.tsx`, `dashboard/src/routes/Quota.tsx` |

## Decision rules

| Upstream signal | Status | Never |
|---|---|---|
| Real credential evidence (401/403 + `credentialEvidence` + genuine auth phrasing) | `disabled` (or `cooldown` when OAuth refresh can fix it) | — |
| Deterministic content-policy rejection (11140, "safety review", "request illegal", "content blocked", "content did not pass") | unaffected | disable, refresh |
| Hosted tool failure (web_search / x_search / web_fetch / "tool invocation" / "search backend") | unaffected | disable, refresh |
| 402 Payment Required | `quota_exhausted` → `cooldown` | disable |
| 407 Proxy Authentication Required | network-origin; account untouched (pool: reachable + disabled) | mutating the upstream account |
| 429 / quota codes | `cooldown` | — |
| Timeout / 5xx / abort / fetch failed | `degraded` WITH non-null `retryAt` | `disabled` |
| Unmatched | `degraded` (shortest backoff) | null `retryAt` |

**Only real credential evidence disables.** `disabled` is terminal: null `cooldownUntil`, never swept, operator must re-enable.

**Every non-`active` status except `disabled` needs a `retryAt`.** `sweepExpiredCooldowns` selects on `cooldownUntil IS NOT NULL`, so a `degraded` row with a null deadline is never auto-recovered and stays unroutable.

**Upstream evidence wins.** A `Retry-After` / `x-ratelimit-reset` header or a duration quoted in the provider message always beats the configured fallback. The config values are fallbacks only.

## Provider-specific pins (deliberate exceptions, keep documented)

- **xAI Grok Build free-tier exhaustion** (`subscription:free-usage-exhausted`, "included free usage", "rolling 24-hour window") → 24h `quota_exhausted` cooldown. Never the 1h fallback, never `degraded`.
- **Buddy family (`cb` / `cbcn` / `workbuddy`) + `11140`** → `policy_blocked` 24h **cooldown** (not `disabled`): the block fails every subsequent invocation so it must leave rotation, but the credential is valid and clears upstream.

## Provider-reset evidence can be absolute

`parseProviderResetDuration` must handle BOTH shapes:
- relative — `"quota will reset in 3 hours"`, `"try again in 30s"`
- absolute — `"your usage will reset at 2026-09-24 02:12:51 UTC+8"` (WorkBuddy/CodeBuddy code `6004`)

A relative-only parser returns `null` for the absolute form, so the classifier falls back to the per-category default (15m for rate limits) and the account re-enters rotation inside the provider's own reset window.

Rules:
- `parseAbsoluteResetTimestamp` normalizes `YYYY-MM-DD HH:MM:SS` + `UTC±H[:MM]` explicitly; `Date.parse` cannot read that space-separated form with a bare offset.
- A past stamp returns `null` (never a negative delay) so the caller keeps its default.
- Bound to 24h (`MAX_COOLDOWN_MS`).
- A provider-stated reset ALWAYS wins over the fallback.

Verify with real message text, not a paraphrase:
```ts
classifyAccountError(new Error(msg), {
  origin: "upstream", scope: "provider",
  providerId: "workbuddy", providerCode: "6004", statusCode: 429,
})
// expect: category rate_limit_transient, status cooldown, retryAt === the instant the provider named
```

## Cooldown scope: model vs account

`rate_limit_transient` / `model_capacity` are throttles: with a `modelId` they write `modelCooldowns[modelId]` (the ACCOUNT stays `active`, only that model is excluded). Everything else writes the account `status`. `route-catalog.ts` marks the candidate `health_status: "cooldown"` and `EligibilityEvaluator` refuses it. So a per-model 429 must never park the whole account.

## Adding a provider-specific rule

A rule that depends on *which* provider failed needs `providerId` on the evidence. Thread it: `mapUpstreamHttpError` sets `details.providerId` → `classifyUpstreamFailure` copies it → `AttemptHealthReport.evidence.providerId` → `classifyAccountError` options. Do not read provider identity from message text.

Put provider-specific durations next to the generic fallbacks as a named constant, and use `Math.max(statedCooldown ?? 0, PINNED_MS)` so a provider value can never shorten a pinned window.

New tunable delays: add a row to `CONFIG_SPEC`, a `resolve*CooldownMs()` reader, and a commented `.env.example` line. Call the resolver at the use site (not a module-load constant) so it can be adjusted without a rebuild.

Keep `isOAuthCredentialInvalidated` in step with any new exclusion, or a 403 will still force an OAuth refresh for a non-credential failure.

## Tool-history repair ordering (buddy family)

In `src/transport/request/preparer.ts`, for `cb`/`cbcn`/`workbuddy`:

```
repairRequestToolCalls({ ...req, messages: dropIncompleteToolRounds(req.messages) })
```

`dropIncompleteToolRounds` MUST run first. The generic repair synthesizes a `<missing tool output>` result for every unanswered call, so running it first makes a partial batch look complete, defeats the buddy policy, and dispatches exactly the shape those gateways reject (`11148`, "tool calls and tool results do not match"). A broken history stays broken — the client replays it every turn — so one bad round kills the conversation.

The orphan scan must use `canContainToolResult()` (tool OR user roles). The Messages ledger re-homes Anthropic tool results into `user` turns; a `role === "tool"`-only scan misses orphans there, and `chat.ts` then emits them as unpaired `role:"tool"` messages.

## UI requirement

A `disabled` badge must show the category/reason (e.g. `Disabled · policy_blocked`), not a bare "Disabled" — otherwise it is undiagnosable next to `Cooldown`/`Degraded`. Check `disabled` **before** `cooldown`, because a disabled row can still carry a stale `cooldownUntil` and would otherwise render as "Cooldown". Quota surfaces need `lastErrorCategory` projected in the console response.

## Health-event model display

When model-scoped provider throttles must be visible in account health history:

1. Trace `recordAccountFailure` and the `modelId` evidence path. Model cooldowns may leave account status active, so do not infer affected model from the account's current `modelCooldowns` map: that map is transient and later recovery/sweep may change it.
2. Persist event-time attribution in `health_events.model_id` (nullable for legacy, account-level, non-model events). Update canonical Drizzle schema, fresh-install `0000_baseline.sql`, next numbered idempotent SQL migration, persistence docs, and event list projection/type.
3. Render a Model column on each HealthEventsModal history row. Keep the current account status and explicit Recover action, but avoid a summary that pairs account ACTIVE status with ambiguous "N models cooling" copy — a model value is historical event detail, not current account state.
4. Make the shared modal content resilient: preferred wide Dialog width bounded by its existing viewport CSS, wrap untrusted/long model IDs and reason text, bounded scroll region for the table. Preserve horizontal scrolling from DataTable where needed.
5. Regression tests cover persistence/projection of `modelId` and rendered model-row visibility; migration integrity and backend/dashboard typechecks. For account status PATCHes, disabling/re-enabling is not recovery: preserve error and cooldown evidence. Only explicit recovery or replacing credentials clears it.

## Untyped stream throws become 500 `unknown_error`

A bare throw in the stream path (e.g. `res.json()` `SyntaxError` on a non-JSON body) is not recognized by any classifier: telemetry records `unknown_error` and the client gets `500 · "the upstream failure could not be classified"`. Any upstream-body parse failure must raise a typed `GatewayError` (502 `transport_unavailable`, origin `upstream`) carrying the upstream's own message. HTML error pages belong to `upstream`, not `cartethyia`.

## Verify

```bash
bun run typecheck && bun run dashboard:typecheck
bun run build
```

The repository does not currently carry a test suite. Prove a health/cooldown change by exercising the real path — a live request that triggers the classification, or a `.tmp-<topic>.ts` driving the real classifier — and report the observed outcome.

Prove a classification end-to-end, not just at the unit boundary:

```bash
bun -e 'import { GatewayError } from "./src/transport/gateway-error";
import { classifyUpstreamFailure } from "./src/transport/failure-policy";
import { classifyAccountError } from "./src/providers/operations/account-health-service";
const e = new GatewayError("authentication_failed", 403, "request illegal",
  { providerId: "cb", providerCode: "11140", credentialEvidence: true }, "upstream");
console.log(classifyAccountError(e, { ...classifyUpstreamFailure(e) }));'
```

## Docs to sync

`README.md` (cooldown behavior), `CHANGELOG.md` under `## Unreleased`, `.env.example`, and this skill's references when a documented rule is intentionally reversed.

Remember the gateway must be restarted for changes to take effect.
