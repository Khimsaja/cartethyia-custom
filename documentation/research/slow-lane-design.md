# Slow-lane support — design spike

Source: `documentation/research/oh-my-pi-provider-comparison.md` (#1, effort M, impact High).
Donor: oh-my-pi `packages/ai/src/providers/anthropic-slow-mode.ts` (wire contract +
`parseAnthropicSlowModeHeaders`), `packages/ai/src/providers/anthropic.ts:2695-2771,2862-2864,3727-3756`
(request gating + failure loop), `packages/coding-agent/src/session/anthropic-slow-mode.ts`
(`AnthropicSlowModeController` state machine, per-account lanes).
Normative constraints: `.skills/cartethyia-health-routing/SKILL.md`.

## 1. Header parsing

Donor `parseAnthropicSlowModeHeaders` (`anthropic-slow-mode.ts:172-232`) reads:

| Response header | Meaning |
|---|---|
| `anthropic-ratelimit-unified-slow-offer` | `treatment` = this account may enter the slow lane; `control` = may not |
| `anthropic-ratelimit-unified-slow-status` | `active` (serving on spare capacity), `not_needed` (standard lane served it), `slot_busy` (no spare capacity now — wait), `weekly_limit` / `budget_exhausted` (lane dead until reset), `ineligible` / `off` (lane closed), unknown → `unrecognized` |
| `anthropic-ratelimit-unified-slow-retry-after` | seconds between capacity retries (server pacing) |
| `anthropic-ratelimit-unified-slow-max-wait` | seconds ceiling on total capacity waiting per request |
| `anthropic-ratelimit-unified-slow-budget-utilization` | 0..1 of weekly slow allowance used |
| `anthropic-ratelimit-unified-slow-budget-reset` | epoch sec of allowance reset |
| `anthropic-ratelimit-unified-reset` / `-5h-reset` / `-7d-reset` | epoch sec of the hit limit's reset (names the window the lane lives inside) |
| `anthropic-ratelimit-unified-{representative-claim,overage-status}` | unified limit wall claimed (lane-entry signal on a 429) |
| `anthropic-ratelimit-unified-overage-{in-use,status}` | extra usage serving / allowed (ends the lane: `extra_usage`) |
| `anthropic-ratelimit-unified-grace-{5h,7d}-utilization` | wrap-up allowance in use (pre-lane stage; >0 = still serving) |

Our parse function shape (new module `src/providers/integrations/claude/claude-slow-lane.ts`,
next to `claude-quota.ts` which owns quota *endpoint* reads — the lane is per-*response*
header observation, a different owner):

```ts
export type ClaudeSlowStatus = "active" | "not_needed" | "slot_busy" | "weekly_limit"
  | "budget_exhausted" | "ineligible" | "off" | "unrecognized";
export interface ClaudeSlowSignal { offer?: "treatment"|"control"; status?: ClaudeSlowStatus;
  retryAfterMs?: number; maxWaitMs?: number; budgetUtilization?: number;
  budgetResetAtSec?: number; unifiedResetAtSec?: number; fiveHourResetAtSec?: number;
  weeklyResetAtSec?: number; unifiedLimitClaim: boolean; overageInUse: boolean;
  overageAllowed?: boolean; graceUtilization?: { fiveHour: number; sevenDay: number }; }
export function parseClaudeSlowHeaders(
  headers: Pick<Headers, "get"> | Record<string, string | undefined>,
): ClaudeSlowSignal | undefined; // undefined when no slow/unified headers present
```

Clamp timing like the donor (retry 5s–600s, max-wait 60s–6h, defaults 20s / 20min);
utilization clamped 0..1; past-dated resets dropped.

## 2. Lane-state model — DECISION: (b) orthogonal lane dimension

**Recommend (b): slow is an orthogonal, eligible-but-deprioritized lane — never a
`HARD_COOLDOWN_CATEGORIES` member.** Three skill-grounded reasons:

1. **A hard cooldown asserts "dialing reproduces the refusal" — false for slow.**
   The skill's hard class (`quota_exhausted`, …) excludes until deadline because
   retrying inside it "can only reproduce the refusal" (`router.ts:200-213`,
   route-catalog comment). A slow-lane account dialed *with* `anthropic-usage-limit:
   slow` succeeds on spare capacity; excluding it parks a serving credential —
   exactly the "cooldown blocks the account completely" anti-pattern the
   evaluator's own comment (`router.ts:180-189`) forbids.
2. **The 429-vs-503 rule must not fire for slow.** `plan()` answers 429 when every
   candidate is hard-excluded or cooling (`router.ts:552-608`). Slow accounts
   *serve*, so an all-slow pool must still plan and dial, not 429. Under (a) the
   all-slow end state 429s while capacity sits idle; under (b) lane-slow
   candidates carry a new eligible reason (`"slow"`), counted as servable in the
   `healthyCount` check, so ordering — not exclusion — carries the intent.
3. **Precedent: soft cooldown and saturation are already "eligible but last".**
   The skill orders cooling/saturated candidates behind healthy siblings without
   excluding them. Slow is the same shape with a different cause (provider pace,
   not failure): fresh → slow → cooling → saturated, then fail.

Mechanics: `EligibilityEvaluator.evaluate()` returns `{ eligible: true, reason:
"slow" }` for lane-active candidates (new reason string, no new exclusion);
`plan()` partitions eligible into healthy → slow → cooling (re-asserted after
`applyProviderRouting`, mirroring `router.ts:660-671`), saturated last. The
lane flag is stamped at plan time from a live registry (see §4), like
`applyUsageFloor` reads live quota — not baked into the snapshot.

## 3. Storage

**In-memory per-account lane registry** (`ClaudeSlowLanes`, port of donor
`AnthropicSlowModeLanes`, keyed by `provider_account_id`), owned by the new
`claude-slow-lane.ts` module. Per lane: phase (`idle` | `active{resetsAtSec,…}`),
latest `treatment` offer + its reset, `blocked{weekly|budget, untilSec}`,
`coolingOffUntilMs` (10 min after max-wait give-up), pacing (`retryAfterMs`,
`maxWaitMs`, `budgetUtilization`), wrap-up window. TTL/expiry is deadline-driven,
not timer-driven: active expires at `resetsAtSec + 60s` grace; offer/blocked
expire at their stated resets (budget block capped at 8 days); wrap-up expires at
its window reset. **On restart all lanes reset to idle** — fail-closed to today's
behavior (session wall → `quota_exhausted` hard cooldown) until the next 429
re-derives the offer. Deliberately *not* a new `provider_accounts` column (a lane
observation arrives on every response; a per-response DB write is churn, and a
migration is schema-telemetry surface for a spike) and *not* the quota-cache
envelope (`src/console/quota/cache.ts` v5 envelope is versioned, 15-min TTL,
fetch-oriented — wrong lifecycle; lane state changes per response, quota per
5-min poll). Multi-instance: each instance learns its own lanes independently —
safe (slower adoption, no wrong routing), revisit only if slow adoption rate
proves to be a problem.

## 4. Routing integration

Lane read lives in `RoutingEngine.plan()` (`src/transport/routing/router.ts`),
applied as a plan-time stamp pass beside `applyUsageFloor` (`router.ts:499-527`):

```ts
// after applyUsageFloor, before eligibility evaluation:
const gated = await this.applyUsageFloor(matching, snapshot, tid);
const laned = this.applySlowLane(gated); // stamps { lane: "slow" } from registry
const decisions = laned.map((c) => this.eligibility.evaluate(c));
```

- `EligibilityEvaluator.evaluate()` (`router.ts:278-312`): `lane === "slow"` →
  `{ eligible: true, reason: "slow" }` (checked after the hard exclusions, before
  the generic cooling branch).
- `healthyCount` (`router.ts:603-605`): counts `reason === "healthy" || reason ===
  "slow"` as servable, so all-slow still dials instead of 429.
- Ordering predicate (extends `router.ts:614-624` + re-assertion `666-671`):
  `healthy → slow → cooling → saturated`, stable within each tier so provider
  rotation still applies inside tiers.
- Failover order: **fresh → slow → fail** — slow candidates are reached only when
  no fresh candidate remains (or all fresh attempts failed retryably); slow
  failures that are capacity waits stay on the same account (see §5), slow
  terminal failures fail over to the next candidate.
- Sibling-headroom gate (port of donor `anthropicSlowModeHasNoSiblingHeadroom`):
  the slow header is attached only when no fresh sibling exists for the model;
  with a single account the lane is entered immediately.

## 5. Retry behavior

Donor: 429 `slot_busy` / 529 while `sentSlow` → sleep server `retry-after`
(±30% jitter, clamped) and resend **same account**, bounded by the server's
max-wait budget; terminal lane-ends (`weekly_limit`, `budget_exhausted`, `off`,
`ineligible`, wall-claim) exit the lane with no retry. Our plug points:

- **Same-account capacity wait inside the Claude route's attempt closure**
  (`src/transport/dispatch/attempt-loop.ts` contract: route-specific behavior in
  `prepare`/`attempt` closures, "this module never forks retry policy" —
  an inner capacity-wait loop in the Claude attempt closure honors that).
  Leases are **released during the wait** (a 20s–20min hold would pin the
  admission slot), then re-acquired for the resend; bounded by max-wait budget
  *and* the request deadline floor (`MIN_RETRY_BUDGET_MS`, attempt-loop.ts:186).
- **First-party OAuth only**: gate mirrors the donor
  (`anthropic.ts:2698-2705`) — Claude-family provider, `credential_kind ===
  "oauth"`, official `api.anthropic.com` URL. Header attached in
  `buildClaudeHeaders` (`claude.ts:218`) when `lanes.isActive(accountId)`.
- **Health-write bypass for intermediate waits**: `slot_busy`/529 capacity waits
  must NOT reach `recordAccountFailure` — today's `classifyAccountError` maps 429
  → `rate_limit_transient` → per-model cooldown, which would park the exact pair
  the lane is trying to serve. Only terminal give-up (max-wait exceeded, lane-end
  status) records health (`quota_exhausted` at the stated reset). `529` already
  maps to `capacity_exhausted` (retryable) in `failure-policy.ts:274-286`, so no
  status-table change; the new bit is a `slot_busy` identifier check on the slow
  status header *before* generic 429 classification in the Claude error path.
- `parseUpstreamBackoff` needs one additive read: `retry-after-ms`/`retry-after`
  already covered; the slow `retry-after` (seconds) feeds the same clamp.

## 6. Skill doc update (draft bullets for `.skills/cartethyia-health-routing/SKILL.md` Rules)

- A **slow lane** (`lane: "slow"`) is orthogonal to cooldown: the account serves
  on spare capacity via `anthropic-usage-limit: slow`, so it stays eligible and
  orders after fresh siblings (fresh → slow → cooling → saturated), never
  excluded. All-slow still dials; it must not answer 429.
- A slow-lane **capacity wait** (429 `slot_busy` / 529 while the slow header was
  sent) retries the *same account* after the server-stated interval (jittered,
  bounded by max-wait and the request deadline) with leases released during the
  wait. It is not a failure: it records no health and writes no cooldown.
- Only a **terminal lane end** (`weekly_limit`, `budget_exhausted`, `off`,
  `ineligible`, max-wait exceeded) mutates health — as `quota_exhausted` at the
  stated reset. First-party Claude OAuth only; the header is sent only when no
  fresh sibling can serve the model.

## 7. Test plan

1. **Header-parse unit** (`claude-slow-lane.test.ts`): table over all eight
   statuses + `unrecognized`; `retry-after`/`max-wait` seconds→ms; utilization
   clamp; past-dated resets dropped; `undefined` when no slow/unified headers.
2. **Routing-order test** (`router.test.ts` style): candidates
   fresh + slow + cooling → plan order `[fresh, slow, cooling]`; all-slow pool →
   plans (no 429) with slow first; slow + fresh where fresh fails → failover
   reaches slow.
3. **429-vs-503 classification test**: session-wall 429 *without* slow offer →
   `quota_exhausted` hard path (429 all-excluded) as today; session-wall 429
   *with* `treatment` offer → lane active, candidate eligible-`"slow"`, never
   `cooldown_hard`; `slot_busy` while sentSlow → same-account wait, assert
   `recordAccountFailure` not called / no `modelCooldowns` entry.

## 8. Open questions

1. **Which catalog accounts qualify as "first-party Claude OAuth"?** The gate
   needs provider id(s) + `credential_kind === "oauth"` + official-URL check,
   but subscription vs API-key credentials may share a provider row. *Settled
   by:* inventory of `provider_accounts` (credential kinds per Claude-family
   provider) plus where the adapter decides the upstream URL.
2. **Opt-in vs auto-accept for the slow header?** The donor gates auto-entry on
   no-sibling-headroom plus a user `/slow` switch; silently slowing a tenant's
   traffic has UX/latency implications. *Settled by:* product decision; default
   proposal is auto-accept with the headroom gate, no per-tenant switch in v1.
3. **Max-wait budget vs our request deadlines?** Donor default waits up to 20
   min; our per-attempt deadline floor (15s) and request deadlines may be far
   shorter, making long waits moot. *Settled by:* measuring configured deadline
   ranges (`src/config/timeouts.ts`) and deciding whether to lower the default
   max-wait for gateway use.
