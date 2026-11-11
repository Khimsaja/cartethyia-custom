// Routing contracts and snapshots.
import { GatewayError } from "../../protocol/gateway-error";
import { log } from "../../observability/logger";
import { type ServiceKind, type WireFamily } from "../../protocol/canonical-model";
import type { CallerIdentity } from "../../security/access-control";
import type { ProviderQuotaWindow } from "../../providers/quota/quota-contracts";

export type { CallerIdentity };


export type RoutingRevision = number;

export type CapabilityProfile = Readonly<Record<string, boolean>>;

export interface RouteCandidate {
  readonly provider_id: string;
  readonly model_id: string;
  readonly wire_family: WireFamily;
  /** Explicit wire dialect (from `models.dialect`), when set. Absent = resolver fallback. */
  readonly dialect?: string;
  /**
   * Protocol shape of the model. `llm` (the default) flows through the
   * canonical surface pipeline; a non-`llm` model is dispatched by its native
   * route handler, which reads `endpoint` directly and never encodes a
   * canonical request. Absent means `llm` — every pre-existing row.
   */
  readonly service_kind?: ServiceKind;
  readonly endpoint: string;
  /** Catalog output ceiling. Absent means the wire default still applies. */
  readonly output_limit?: number | null;
  readonly capability_profile: CapabilityProfile;
  /** Route-selected User-Agent fallback; provider-supplied identities remain authoritative. */
  readonly user_agent?: string;
  readonly max_inflight?: number;
  readonly provider_account_id?: string;
  /** Cooldown class: `hard` = excluded until the deadline; `soft` = deprioritized. */
  readonly cooldown_kind?: "hard" | "soft";
  /** Operator-facing label of `provider_account_id` (never the secret), for
   * the Console Log detail line — logs must show a name, not a bare id. */
  readonly provider_account_label?: string;
  /** Every active pool eligible for automatic per-request selection
   * (`NetworkPoolSelector.tryAcquireAvailablePool`) — the dispatch handler
   * picks the least-loaded/non-cooldown pool at request time; there is no
   * admin-pinned single pool. Absent/empty when the provider bypasses the
   * proxy pool entirely (direct dispatch). */
  readonly network_pool_ids?: readonly string[];
  /** True when routing requires a pool even if health filtering leaves none eligible. */
  readonly network_pool_required?: boolean;
  /** `network_pool_ids[i]` → its configured max concurrency, for the
   * selection algorithm's overflow decision. */
  readonly network_pool_limits?: Readonly<Record<string, number>>;
  /** `network_pool_ids[i]` → its routing weight (100 = neutral). Effective
   * capacity scales as `limit * weight / 100`; weight ≤ 0 takes the pool
   * out of selection. */
  readonly network_pool_weights?: Readonly<Record<string, number>>;
  /** Selection strategy for the tenant that owns `network_pool_ids`;
   * `tenantId` names that pool-owning tenant (settings owner and rotation
   * cursor key). Absent = `least_loaded`. */
  readonly network_pool_routing?: PoolRoutingSetting & { readonly tenantId: string };
  /** This provider's ceiling on *each* pool's concurrent requests, from
   * Routing Strategy. Distinct from `max_inflight` (one account) and from
   * `network_pool_limits` (one pool, every provider). Absent = unlimited, the
   * default, and then no per-provider counter is ever touched. */
  readonly network_pool_provider_limit?: number;
  /** `null`/`undefined` = globally routable; a tenant id = routable only for that tenant's requests (BYOK). */
  readonly tenant_id?: string | null;
  /**
   * The tenant that owns this candidate's account (`provider_accounts.tenant_id`),
   * or null for a shared pool-wide account. Distinct from `tenant_id` (the
   * requesting tenant). Used to scope the admission bucket: a shared account
   * is one bucket across tenants; a tenant-owned account is scoped to its
   * owner so two tenants cannot drain each other's ceiling.
   */
  readonly owner_tenant_id?: string | null;
  /** `false` only for a genuinely credential-less provider (e.g. OpenCode
   * Free) dispatched with zero `provider_accounts` rows — the handler skips
   * `resolveCredentialForAccount` and dispatches with a `"none"` credential.
   * Absent/`true` preserves the existing invariant: no account configured
   * means the route is unusable, not silently public. */
  readonly requires_account?: boolean;
  /**
   * True when the upstream refuses this model on a free plan.
   *
   * Three-valued by absence as well as by value: only `true` excludes a free
   * account. `false` and absent both mean the model is not known to be gated,
   * and routing must not turn "not known" into "free accounts may serve it" —
   * that would send pro-only traffic to an account that is certain to be
   * refused.
   */
  readonly pro_only?: boolean;
  /**
   * True when the provider publishes this model as free (its own directory
   * statement, e.g. Qoder's `is_free`). A free model may be routed to any
   * account — the credit-preference ordering skips it entirely.
   */
  readonly free_tier?: boolean;
  /**
   * The plan the provider last reported for `provider_account_id`.
   *
   * Absent means the plan was never read, which is a different state from
   * "free": guessing free here would defeat the gate it exists to serve.
   */
  readonly account_plan?: string | null;
  /** Usage-floor ceiling from Routing Strategy; read live at plan time. */
  readonly usage_floor?: number;
  readonly usage_floor_unit?: "credit" | "percent";
  /** Live quota windows (cache) the floor check evaluates. */
  readonly quota_windows?: readonly ProviderQuotaWindow[];
  /** A successful Start Plan balance authoritatively lists its model grants. */
  readonly quota_entitlements_known?: boolean;
  /** Normalized quota/plan fact stamped at plan time (unified engine). */
  readonly quota_fact?: NormalizedQuotaFact;
}

/**
 * A candidate as the routing engine actually evaluates it: the catalog fields
 * above plus the health/cooling stamp `route-catalog.ts` projects onto it and
 * the plan-time slow-lane marker.
 *
 * Declared here — not as a route-catalog-local intersection — so
 * `EligibilityEvaluator.evaluate` can take the routed shape without a cast,
 * and so every stamping site agrees on the same field set by construction.
 */
export type RoutedCandidate = RouteCandidate & {
  /**
   * Health marker the catalog projects from `provider_accounts.status` and
   * unexpired `model_cooldowns` entries. Absent = no health exclusion known.
   * Mutable by declaration: the catalog builds the base candidate first and
   * stamps health/cooling onto it as account rows are walked.
   */
  health_status?: "cooldown" | "model_cooldown" | "disabled";
  /** Cooldown class the catalog derives from the account's last error category. */
  cooldown_kind?: "hard" | "soft";
  /**
   * Epoch milliseconds at which this candidate's cooling window ends, when one
   * is in force. Routing-internal: it is what lets `plan()` report a real reset
   * on the all-accounts-cooling answer, and it never reaches a client verbatim —
   * only the derived `retry-after` does.
   */
  cooldown_until?: number;
  /**
   * Slow-lane stamp applied at plan time (test-supported; runtime slow-lane
   * activity is read live via `sharedClaudeSlowLanes.isActive`).
   */
  lane?: "slow";
  /**
   * Normalized quota/plan fact stamped at plan time by the routing decision
   * engine. The decision engine reads this instead of re-deriving window state.
   */
  quota_fact?: NormalizedQuotaFact;
  /**
   * Operator-configured account priority (0 when unset). Higher ranks ahead
   * within the same rank group, before usage measurement.
   */
  account_priority?: number;
  /**
   * True when the account's remaining quota fraction is at or below the
   * configured reserve percent. A reserved account stays eligible but orders
   * behind non-reserve siblings.
   */
  in_reserve?: boolean;
  /**
   * Drain urgency score: headroom fraction / remaining hours until reset.
   * Higher = quota about to expire unused, ranked first within a rank group.
   */
  drain_score?: number;
};

/**
 * Provider-routing strategies. The runtime tuple is the source: the console's
 * Elysia body schema builds its `t.Literal` union from these values and its
 * operations layer validates direct callers against the same list, so a new
 * strategy cannot land in one and be silently missing from the other.
 */
export interface ProviderRoutingSetting {
  readonly strategy: ProviderRoutingStrategy;
  /** Requests served by one account before round robin advances. */
  readonly rotateCount: number;
  /** Per-account inflight ceiling from the routing panel; `null` = unlimited
   * concurrency per account. */
  readonly maxInflight: number | null;
  /** Per-pool inflight ceiling for this provider; `null` = unlimited, and
   * `null` is the default. Bounds one provider's share of one proxy pool,
   * independently of `maxInflight` (one account) and of the pool's own
   * `network_pools.max_inflight` (every provider). */
  readonly maxInflightPerProxy: number | null;
  /** Minimum remaining allowance an account must hold to stay routable.
   * `null` means no floor. `credit` compares the summed remaining credit;
   * `percent` compares the aggregate credit percent and lowest independent
   * percentage-only window. */
  readonly usageFloor: number | null;
  readonly usageFloorUnit: "credit" | "percent";
  readonly enabled: boolean;
  /** Built-in API-key User-Agent; OAuth and custom providers retain their identities. */
  readonly userAgent?: string;
  /** Operator-set custom User-Agent override; non-empty overrides `userAgent`
   * (and any provider-native identity) at the request edge. `null`/empty
   * means no custom override. */
  readonly customUserAgent?: string | null;
  /** When true, this (tenant, provider) dispatches direct — candidates
   * never carry `network_pool_ids` regardless of pool availability. */
  readonly skipProxy: boolean;
}

/**
 * Providers whose routing defaults to `skipProxy: true` when no explicit
 * settings row exists yet for a given (tenant, provider) pair. Not a hard
 * lock — an explicit `skipProxy: false` row overrides this same as any
 * other provider. Picks the starting value for providers that commonly
 * don't work through a plain HTTP/S proxy; route them via a SOCKS5 or
 * proxy pool instead if proxying is required. Consumed by both the
 * console API default (`console/domains/provider-detail.ts`) and the real
 * `transport/routing/route-catalog.ts` so the two never drift.
 *
 * Single owner is the manifest `defaultSkipProxy` flags in
 * `providers/metadata.ts`; consumers import it directly from there.
 */

/**
 * Snapshot-level map carrying per-tenant per-provider routing preferences.
 * Outer key is tenantId string, inner key is providerId. Global settings
 * (tenant_id IS NULL) are stored under the sentinel "__global__".
 */
export type ProviderRoutingMap = Readonly<
  Record<string, Readonly<Record<string, ProviderRoutingSetting>>>
>;

/**
 * Pool-group selection strategy for one tenant — the network-pool counterpart
 * to `ProviderRoutingSetting`. `least_loaded` (default) keeps the weighted
 * least-loaded scan with its rotating tie-break; `round_robin` serves
 * `rotateCount` requests per pool before advancing and skips over capacity or
 * cooldown pools the way account failover does.
 */
export interface PoolRoutingSetting {
  readonly strategy: PoolRoutingStrategy;
  /** Requests served by one pool before round robin advances. */
  readonly rotateCount: number;
}

/**
 * Exact account a request must be routed to, because a provider session is
 * already live on it.
 *
 * A tool result for a Cursor Run is only meaningful on the account whose Run
 * asked for the call. Routing it to a sibling account — even a healthy one —
 * writes the result into an unrelated upstream turn, so affinity is a hard
 * constraint on the candidate set rather than a preference: `plan` pins to this
 * account or refuses.
 */
export interface RouteContinuationAffinity {
  readonly providerId: string;
  readonly providerAccountId: string;
  /**
   * True when the request's tool-result ids are all already answered by the
   * conversation history (a replay), so no call is still owed to the pinned
   * account. In that case, if the pinned account is no longer routable for
   * the requested model, the request may safely rebase to a fresh Run on an
   * eligible account instead of being refused — the recorded exchange travels
   * as history. When false, the pin is a hard constraint: a live pending call
   * must reach the exact account that owns it.
   */
  readonly rebaseable: boolean;
}

export interface RoutePlan {
  readonly revision: RoutingRevision;
  readonly candidates: readonly RouteCandidate[];
  readonly requested_model: string;
  readonly resolved_model: string;
  readonly provider_id: string;
  /**
   * The system decision behind each candidate, keyed by the candidate's
   * admission bucket. Written once at plan time; every later layer (dispatch,
   * telemetry) reads this instead of re-deriving its own ordering.
   */
  readonly decisions: ReadonlyMap<string, RoutingDecision>;
}

/** How eligible a candidate is and why — written once, read by every layer. */
export const ROUTING_RANK = {
  /** Fresh candidate with a positive known quota / above its usage floor. */
  FRESH_KNOWN: 0,
  /** Fresh candidate whose quota state is unknown (no read, unsupported, stale). */
  FRESH_UNKNOWN: 1,
  SLOW: 2,
  COOLING: 3,
  SATURATED: 4,
} as const;
export type RoutingRank = (typeof ROUTING_RANK)[keyof typeof ROUTING_RANK];

export interface RoutingDecision {
  readonly eligible: boolean;
  readonly rank: RoutingRank;
  readonly reason: string;
  readonly health_status?: string;
  readonly cooldown_until?: number;
  readonly floor_blocked?: boolean;
  readonly plan_gate_blocked?: boolean;
  readonly capability_blocked?: boolean;
  readonly saturated?: boolean;
}

/**
 * The normalized quota/plan fact the unified routing engine evaluates per
 * candidate. Produced once per candidate before `evaluateCandidate`, so the
 * decision engine never re-reads quota sources or re-derives window state.
 */
export interface NormalizedQuotaFact {
  /** `available` = positive known balance; `exhausted` = known spent/below floor. */
  readonly quotaState: "available" | "exhausted" | "unknown";
  readonly quotaSource: "live_cache" | "snapshot" | "unsupported" | "none";
  /** Epoch ms of the observation, when one exists (used for freshness). */
  readonly quotaObservedAt: number | null;
  /** True when the observed quota is older than the freshness horizon. */
  readonly isStale: boolean;
  readonly usageFloorState: "above" | "below" | "unknown";
}

import type { ComboStrategy, PoolRoutingStrategy, ProviderRoutingStrategy } from "../../persistence/schema";
import { providerRoutingStrategy } from "../../persistence/schema";

export { type ProviderRoutingStrategy };

/** Provider-routing strategies, derived from the persisted enum so the console
 * body schema and the routing engine validate against one list. */
export const ROUTING_STRATEGIES = providerRoutingStrategy.enumValues;

export interface ComboDefinition {
  readonly members: readonly string[];
  readonly strategy: ComboStrategy;
}

export interface RouteSnapshot {
  readonly revision: RoutingRevision;
  readonly candidates: readonly RouteCandidate[];
  readonly aliases: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** CLI source→target mappings, enabled only for API keys with the feature scope. */
  readonly cli_aliases?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly combos: Readonly<Record<string, Readonly<Record<string, ComboDefinition>>>>;
  readonly created_at: number;
  /** Optional per-provider routing preferences keyed by tenant. */
  readonly providerRouting?: ProviderRoutingMap;
  /**
   * Tenants whose invoke switch is off, so `/v1/*` must be refused outright.
   *
   * Read from the cached snapshot rather than per request: it is a console
   * preference write, and the snapshot is already invalidated when one lands, so
   * the switch takes effect on the next request without adding a query to the
   * proxy path.
   */
  readonly invokeDisabledTenants?: ReadonlySet<string>;
}

export type EligibilityReason =
  | "healthy"
  | "slow"
  | "cooldown"
  | "cooldown_hard"
  | "model_cooldown"
  | "quota_exhausted"
  | "quota_unknown"
  | "plan_gate"
  | "capability_unsupported"
  | "disabled"

export interface EligibilityDecision {
  readonly eligible: boolean;
  readonly reason: EligibilityReason;
  readonly candidate: RouteCandidate;
  /**
   * Epoch milliseconds at which this candidate's cooling window ends, when the
   * exclusion that produced this decision carries one. Absent for a healthy
   * candidate and for every reason with no deadline (`disabled`,
   * `quota_exhausted` from spent windows or the usage floor). `plan()` takes the
   * minimum across the cooling set to report the earliest reset a client could
   * retry against.
   */
  readonly cooldown_until?: number;
}

export interface Reservation {
  readonly candidate: RouteCandidate;
  readonly lease_id: string;
  readonly expires_at: number;
  readonly acquired_at: number;
}

export interface RouteSnapshotService {
  getSnapshot(): Promise<RouteSnapshot>;
  invalidate(): Promise<RoutingRevision>;
  /**
   * Health/probe-triggered invalidation: a single account or pool flipping
   * state, a probe recovering an account, a quota refresh healing one.
   * These arrive continuously (~100/min of health churn) and almost never
   * change routing for any given request, so they rebuild on the
   * BACKGROUND tier — batched into one rebuild per background window
   * instead of one per event. The pending invalidation is never lost: the
   * background timer guarantees a rebuild, and an operator invalidate
   * pulls it forward. See InMemoryRouteSnapshotService below.
   */
  invalidateBackground(): Promise<RoutingRevision>;
}

/**
 * Which tier of invalidation a rebuild request belongs to.
 *
 * "operator" is a console write or anything a human did that must be
 * visible quickly; "background" is automatic health/probe churn. The
 * tiers differ only in scheduling delay — never in what gets built.
 * Alias of the notice tier in the shared cache, so the two stay one type.
 */
export type SnapshotInvalidationKind = RoutingInvalidationKind;

/** One admission decision: whether the candidate got a slot, and why not. */
export interface AdmissionDecision {
  readonly admitted: boolean;
  readonly reason?: string;
}

export interface AdmissionController {
  admit(candidate: RouteCandidate): Promise<AdmissionDecision>;
  release(reservation: Reservation): Promise<void>;
  /**
   * Current inflight counts for exactly the buckets the given candidates draw
   * from, keyed by the unprefixed admission bucket (`provider:model[:account]`).
   *
   * Required, not optional: the previous fleet-wide
   * `snapshotAccountInflight()` was the only reason `plan()` could issue a
   * Redis `KEYS` on the request path. Scoped reads make the ordering cost
   * proportional to the candidates being ordered, and an empty input must be
   * answerable with zero backend commands.
   */
  readAccountInflight(
    candidates: readonly RouteCandidate[],
  ): Promise<ReadonlyMap<string, number>> | ReadonlyMap<string, number>;
}

/**
 * Translates the evaluator's internal reason codes into operator English.
 *
 * These names are the vocabulary the routing layers use with each other —
 * `model_cooldown`, `cooldown_hard` — not something to print into the
 * public message, where the client would read an enum instead of an
 * explanation. The codes stay in the envelope's `reasons` field for anyone who
 * wants them; the sentence carries what they mean.
 *
 * Unmapped names are still readable: they fall through as themselves rather
 * than being dropped, so a new reason shows up in the message on the day it is
 * added instead of vanishing until someone remembers this map.
 */
const ELIGIBILITY_REASON_LABELS: Readonly<Record<string, string>> = {
  model_cooldown: "every account is cooling down for this model",
  cooldown_hard: "every account is in a hard cooldown",
  cooldown: "accounts are cooling down",
  disabled: "all accounts are disabled",
  credit_floor_reached: "credit or quota is exhausted",
  quota_exhausted: "every account has an exhausted quota window or is below its configured usage floor",
  quota_unknown: "accounts have no known quota state (unknown, unsupported, or stale)",
  plan_gate: "the plan explicitly proves these accounts cannot serve this model",
  capability_unsupported: "the accounts serving this model do not support the request's capabilities (e.g. images, tools, or reasoning)",
};

function explainEligibilityReasons(reasons: readonly string[]): string {
  if (reasons.length === 0) return "no eligible candidate";
  const parts = reasons.map((reason) => ELIGIBILITY_REASON_LABELS[reason] ?? reason);
  const distinct = [...new Set(parts)];
  return distinct.length === 1 ? distinct[0]! : distinct.join("; ");
}

export function ambiguousModelError(bare: string, owners: string[]): GatewayError {
  return new GatewayError(
    "ambiguous_model",
    400,
    `'${bare}' matches more than one provider (${owners.join(", ")}). Qualify it as '${owners[0]}/${bare}', or add an alias to pick one. Too popular for its own good — qualify it 🧩`,
    {
      model: bare,
      owners,
    },
  );
}

/**
 * The requested name resolves to nothing, or no candidate serves its resolved
 * target. `resolved` carries the post-alias/combo target(s) so an alias whose
 * model disappeared from the catalog is diagnosable from the error alone,
 * instead of reading like a typo in the client's own request.
 */
export function modelNotFoundError(requested: string, resolved: readonly string[] = []): GatewayError {
  const targets = resolved.filter((name) => name !== requested);
  const hint = targets.map((name) => `'${name}'`).join(", ");
  return new GatewayError(
    "model_not_found",
    404,
    `'${requested}' is not routed${
      targets.length > 0 ? ` — it resolved to ${hint}, which no account serves` : ""
    } (request {requestId}). Enable the model on an account, or point the alias at one that exists. Try another model — this one's off the menu 📚`,
    {
      model: requested,
      ...(targets.length > 0 ? { resolved_models: targets } : {}),
    },
  );
}

/**
 * Every candidate in the plan refused admission: each account is already
 * serving its configured max-inflight.
 *
 * Deliberately NOT `capacity_exhausted`. That code also belongs to the API-key
 * admission layer (`security/admission`, reason `concurrency-limit`), which
 * enforces a key's own `max_concurrent`. Sharing one code made the two
 * indistinguishable on the wire: an operator who raised the provider's
 * max-inflight saw no change because the rejection was the *key's* ceiling, and
 * vice versa. Distinct codes let each be read off the envelope alone.
 *
 * The counts are carried in `details` because the interesting question is never
 * "was it rejected" but "was every account really full, or did the plan only
 * carry one candidate" — the latter is a routing/eligibility problem that
 * raising the ceiling will not fix.
 */
export function capacityExhaustedError(context?: {
  readonly providerId?: string;
  readonly model?: string;
  readonly candidateCount?: number;
  readonly maxInflight?: number;
}): GatewayError {
  const onlyOne = context?.candidateCount === 1;
  return new GatewayError(
    "provider_capacity_exhausted",
    429,
    onlyOne
      ? "The only account routing this model is at its concurrency limit (request {requestId}). Retry shortly; if it persists, raise the provider's max-inflight or add another account. Even the machine needs a rest — chill 🦋"
      : "Every account is at its concurrency limit (request {requestId}). Retry shortly; if it persists, raise the provider's max-inflight or add an account. Even the machine needs a rest — chill 🦋",
    {
      ...(context?.providerId !== undefined ? { providerId: context.providerId } : {}),
      ...(context?.model !== undefined ? { model: context.model } : {}),
      ...(context?.candidateCount !== undefined
        ? { candidate_count: context.candidateCount }
        : {}),
      ...(context?.maxInflight !== undefined ? { maxInflight: context.maxInflight } : {}),
    },
  );
}

/**
 * The model exists and is routed, but every account serving it is currently
 * unusable (disabled). This is transient and
 * retry-able, so it must NOT surface as `model_not_found` — a 404 tells the
 * client to fix its request when the real fix is to wait or add capacity.
 *
 * The public message names only what the client asked and why it cannot be
 * served. Combo/alias resolution detail (which member lacked candidates)
 * stays server-side — the operator reads it in the server logs, never the
 * client envelope.
 */
export function accountsUnavailableError(
  requested: string,
  reasons: readonly string[],
): GatewayError {
  const distinct = [...new Set(reasons)].sort();
  const capabilityBlocked = distinct.includes("capability_unsupported");
  // When the blocker is a capability (the model exists and accounts exist, but
  // none can carry the request's images/tools/reasoning), telling the client to
  // "add an account" or wait out a coffee break is misleading — more accounts
  // cannot conjure a capability the model itself lacks. Name the real fix.
  const hint = capabilityBlocked
    ? "Request a model that supports this capability (or a vision-capable model for images), or drop the unsupported part of the request. The model is the limit, not the pool 🧰"
    : "Add an account, or wait for an operator to re-enable one. Every account is on a coffee break — try later ☕️";
  return new GatewayError(
    "accounts_unavailable",
    503,
    `No account in the pool can serve '${requested}' right now (request {requestId}) (${explainEligibilityReasons(distinct)}). ${hint}`,
    { model: requested, reasons: distinct, candidate_count: reasons.length, gateway_hint: "no_healthy_account" },
  );
}

/**
 * The model is routed, but every candidate that could serve it is currently
 * cooling down (rate limited, quota exhausted, or transiently failed).
 *
 * Distinct from {@link accountsUnavailableError}: that 503 means *no usable
 * account exists* (all disabled or model-cooling), where waiting does not help
 * until an operator acts. This 429 means accounts exist but every one is inside
 * a cooldown window — the correct answer is "rate limited, retry after the
 * reset", and dialing a cooling account can only reproduce the same refusal.
 * Returning 503 here told a client to keep retrying capacity that is merely
 * resting, and 404 would blame the request.
 */
export function accountsRateLimitedError(
  requested: string,
  routed: string = requested,
  /** Earliest epoch-ms instant any cooling candidate recovers, when known. */
  earliestResetMs?: number,
): GatewayError {
  const routeNote = routed === requested ? "" : ` (routed to '${routed}')`;
  // The reset rides as `retryAfterMs`, the same hint every other retryable
  // failure uses, so `error-lifecycle.ts` turns it into a real `retry-after`
  // header instead of the one-second floor it falls back to. Reporting the
  // actual earliest recovery is the difference between a client that waits out
  // the window and one that re-dials a resting account every second.
  const retryAfterMs =
    earliestResetMs !== undefined && earliestResetMs > Date.now()
      ? earliestResetMs - Date.now()
      : undefined;
  return new GatewayError(
    "accounts_rate_limited",
    429,
    `Every account serving '${requested}'${routeNote} is cooling down after hitting upstream limits (request {requestId}). The request is fine — retry once the cooldown resets. They're resting up 🌸`,
    {
      model: requested,
      routed_model: routed,
      reason: "all_accounts_cooling",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
  );
}



import {
  publishRoutingInvalidation,
  subscribeRoutingInvalidation,
  type RoutingInvalidationKind,
} from "../../persistence/shared-cache";

export type SnapshotBuilder = () => Promise<
  Omit<RouteSnapshot, "revision" | "created_at"> & { created_at?: number }
>;

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      if (v && typeof v === "object") deepFreeze(v as unknown as T);
    }
    Object.freeze(obj);
  }
  return obj;
}

/** Delays between boot warm-up retries of the first snapshot build. */
const WARMUP_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });

export class InMemoryRouteSnapshotService implements RouteSnapshotService {
  private revision: RoutingRevision = 0;
  private snapshot: RouteSnapshot | undefined;
  /**
   * Last successfully built snapshot, kept across invalidations. A lazy
   * rebuild that fails (a minute-burst of 500 internal_error across all
   * models on 2026-10-26, with nothing in the journal) falls back to it
   * instead of throwing to the data plane; the next invalidation retries
   * the build. Since the 2026-11-11 OOM fix it is also the snapshot
   * served while a debounced rebuild runs: invalidate() no longer drops
   * the cache, so requests keep getting the previous snapshot (stale by
   * at most one debounce window) instead of each paying a full rebuild.
   * Upstream 2.7.3 immediacy is relaxed by exactly that window — the
   * price of stopping the rebuild storm that OOM-killed the gateway on
   * 2026-11-11 (15.6 GB RSS, a build every ~20-40 s from health churn).
   */
  private lastGood: RouteSnapshot | undefined;
  /**
   * The in-flight build, tagged with the revision it is building.
   *
   * The tag is what keeps a mutation from being lost. A build reads the catalog
   * over ten Postgres round-trips, so a dashboard write can land while one is
   * in flight. Without the tag two things go wrong: a reader that arrives
   * *after* the mutation is handed the still-running pre-mutation build, and
   * that build then overwrites the cache the mutation has just cleared — so the
   * data plane serves stale routing until some later write invalidates it
   * again. A build may only be reused by readers at its own revision, and may
   * only populate the cache if no mutation happened while it ran.
   */
  private building: { revision: RoutingRevision; promise: Promise<RouteSnapshot> } | undefined;
  /**
   * Debounced background-rebuild timer (G-02). One invalidate schedules a
   * rebuild; a burst of invalidates within `rebuildDebounceMs` coalesces into
   * the single latest-revision rebuild. The timer is cleared on `stop()`.
   */
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * True when an invalidate landed while a build was in flight (SINGLEFLIGHT_XREV):
   * the settling build owes exactly one debounced follow-up at the latest
   * revision. Consumed only in rebuildNow()'s finally(), so an invalidation
   * can never be lost between a build finishing and its follow-up starting.
   */
  private rebuildPending = false;
  private stopped = false;

  constructor(
    private readonly builder: SnapshotBuilder,
    options: {
      readonly rebuildDebounceMs?: number;
      readonly backgroundDebounceMs?: number;
    } = {},
  ) {
    this.rebuildDebounceMs = options.rebuildDebounceMs ?? 30000;
    // The background tier defaults to the operator window: callers that do
    // not configure it (notably the test suite) keep today's behavior
    // exactly. Production passes a much longer window at the boot site.
    this.backgroundDebounceMs = options.backgroundDebounceMs ?? this.rebuildDebounceMs;
    // Peers' mutations arrive once per process, not per instance: the handler
    // schedules a background rebuild, which is the only one there is.
    // The notice carries the originating tier, so a peer rebuilds on the
    // same tier the origin did — an operator edit on one process does not
    // sit for the background window on the others.
    this.unsubscribe = subscribeRoutingInvalidation((kind) => {
      this.revision += 1;
      this.invalidationsSinceLastBuild += 1;
      this.scheduleRebuild(kind);
    });
  }

  /** Ends the peer-invalidation subscription and clears the rebuild timer. */
  readonly unsubscribe: () => void;

  /** Wall-clock debounce for coalescing invalidate bursts. */
  private readonly rebuildDebounceMs: number;
  /**
   * Wall-clock debounce for the background tier (health/probe
   * invalidations). Defaults to the operator window, so callers that do
   * not configure it — notably the test suite — keep today's behavior
   * exactly. Production passes a much longer window at the boot site:
   * health churn is continuous, so a 5-minute batching window caps
   * background rebuilds at 12/hour instead of one per ~35 s.
   */
  private readonly backgroundDebounceMs: number;
  /**
   * Which tier the pending rebuild timer belongs to. An operator
   * invalidation shortens a pending background timer to the operator
   * window (see scheduleRebuild); a background one never lengthens an
   * operator timer.
   */
  private rebuildTimerKind: SnapshotInvalidationKind | undefined;
  /**
   * Tier owed by an invalidation that landed while a build was in flight.
   * Operator wins: a background follow-up must not delay an operator
   * change that arrived during the same build.
   */
  private pendingKind: SnapshotInvalidationKind | undefined;
  /**
   * Invalidations (both tiers, local and peer) since the last build
   * started. Logged with each rebuild so the next storm shows its churn
   * per build, not only its build rate.
   */
  private invalidationsSinceLastBuild = 0;

  /**
   * Schedules a background rebuild at the current revision. Debounced: while a
   * timer is pending, further invalidates just bump the revision and the
   * pending rebuild picks up the latest. Single-flight by construction — the
   * rebuild itself reuses {@link building}, so concurrent callers share one
   * promise, whatever its revision tag.
   *
   * Two tiers share the one timer. A background invalidation is batched on
   * the long window; an operator invalidation shortens a pending
   * background timer to the operator window, so a console edit never waits
   * out a health batch. A background invalidation never lengthens a
   * pending operator timer.
   */
  private scheduleRebuild(kind: SnapshotInvalidationKind): void {
    if (this.stopped) return;
    // SINGLEFLIGHT_XREV: a build already in flight owns the next rebuild.
    // An invalidate landing mid-build only marks a follow-up as owed — it
    // must NOT start a timer here, or the timer would fire mid-build and
    // launch a second build on top of the running one (the overlap storm).
    // This check comes BEFORE the timer-pending guard: if a timer is
    // already pending, that timer will only join the running build, so
    // returning on the timer alone would swallow this invalidation.
    if (this.building !== undefined) {
      this.rebuildPending = true;
      if (kind === "operator" || this.pendingKind === undefined) {
        this.pendingKind = kind;
      }
      return;
    }
    if (this.rebuildTimer !== undefined) {
      if (kind === "operator" && this.rebuildTimerKind === "background") {
        // Pull the pending background rebuild forward: the operator's
        // change must be visible within the operator window, not the
        // background one. The background invalidation is not lost — the
        // rebuilt snapshot picks up the latest revision either way.
        clearTimeout(this.rebuildTimer);
        this.rebuildTimer = undefined;
        this.rebuildTimerKind = undefined;
      } else {
        return;
      }
    }
    const delayMs =
      kind === "operator" ? this.rebuildDebounceMs : this.backgroundDebounceMs;
    this.rebuildTimerKind = kind;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined;
      this.rebuildTimerKind = undefined;
      void this.rebuildNow().catch((error: unknown) => {
        // A background rebuild failure is a soft miss: requests served the
        // last-completed snapshot, and the next invalidation retries.
        log.warn("[route-snapshot] background rebuild failed", error as Error);
      });
    }, delayMs);
    if (typeof this.rebuildTimer.unref === "function") this.rebuildTimer.unref();
  }

  /** Starts (or joins) the single in-flight build. SINGLEFLIGHT_XREV:
   * joins ANY in-flight build regardless of its revision tag — at most one
   * build ever runs. Joining an older-revision build is safe: buildInner
   * only caches when the revision is still current, and invalidations that
   * landed mid-build are repaid by the follow-up in finally() below. */
  private rebuildNow(): Promise<RouteSnapshot> {
    const revision = this.revision;
    if (this.building) return this.building.promise;
    const promise = this.build(revision);
    this.building = { revision, promise };
    // The finally-chain is a separate promise: without this catch, a failed
    // build rejects it unhandled even when the caller handles the original
    // promise (getSnapshot's stale-serve fallback) — bun test / node report
    // that as a test failure / crash. The original promise is still returned
    // above, so callers see the real outcome.
    void promise
      .finally(() => {
        // Only the build that is still current may clear the slot; a build
        // started after a mutation must not be dropped by an older one finishing.
        if (this.building?.promise === promise) this.building = undefined;
        // SINGLEFLIGHT_XREV: repay exactly one follow-up for every
        // invalidate that landed while this build ran, at the latest
        // revision. Debounced via scheduleRebuild so a fresh burst still
        // coalesces instead of chaining builds. The follow-up keeps the
        // owed tier: a background-only burst is repaid on the background
        // window, an operator change that arrived mid-build on the
        // operator one.
        if (this.rebuildPending && !this.stopped) {
          this.rebuildPending = false;
          const kind = this.pendingKind ?? "operator";
          this.pendingKind = undefined;
          this.scheduleRebuild(kind);
        }
      })
      .catch(() => {});
    return promise;
  }

  async getSnapshot(): Promise<RouteSnapshot> {
    // Serve the current snapshot while a rebuild runs, so the request
    // path never pays the catalog build. Since the 2026-11-11 OOM fix,
    // invalidate() no longer drops the cache: this is also how a stale
    // (at most one debounce window old) snapshot is served while the
    // coalesced background rebuild is still in flight. Only a cold start
    // (no snapshot at all) falls through to a synchronous build here.
    if (this.snapshot) return this.snapshot;
    try {
      return await this.rebuildNow();
    } catch (error) {
      // A failed lazy rebuild must not 500 the data plane when a previous
      // snapshot exists: serve it stale instead. Only a boot-time build
      // with no snapshot yet can still reject to its waiters, and there is
      // nothing else to serve there.
      if (this.lastGood !== undefined) return this.lastGood;
      throw error;
    }
  }

  /**
   * Boot warm-up: retry the first snapshot build until it succeeds or the
   * attempts run out. The previous one-shot warm in main.ts left the
   * snapshot cold whenever the first build failed (2026-11-11: the
   * Postgres pool was saturated at boot, so the first /v1/models after a
   * restart paid a ~20 s synchronous build). Never throws: an exhausted
   * warm-up only logs, and the next request rebuilds as before.
   */
  async warmup(
    options: { attempts?: number; delaysMs?: readonly number[] } = {},
  ): Promise<void> {
    const delaysMs =
      options.delaysMs !== undefined && options.delaysMs.length > 0
        ? options.delaysMs
        : WARMUP_RETRY_DELAYS_MS;
    const attempts = Math.max(1, options.attempts ?? delaysMs.length + 1);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        await sleep(delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 5_000);
      }
      try {
        await this.getSnapshot();
        if (attempt > 0) {
          log.info(`[startup] route snapshot warmed on attempt ${attempt + 1}`);
        }
        return;
      } catch (error) {
        log.warn(
          `[startup] route snapshot warm failed (attempt ${attempt + 1}/${attempts})`,
          error as Error,
        );
      }
    }
    log.warn("[startup] route snapshot warm exhausted; the first request will build it");
  }

  async invalidate(): Promise<RoutingRevision> {
    this.revision += 1;
    this.invalidationsSinceLastBuild += 1;
    // Coalesced rebuild (2026-11-11 OOM fix): the cache is NOT dropped
    // here. The previous snapshot keeps serving (lastGood) until the
    // single debounced background rebuild at the latest revision lands,
    // so a burst of invalidates (health churn ~100/min, boot sweeps)
    // collapses into one build per window instead of one build per
    // event — the storm that grew RSS ~1.5 GB/min to a 15.6 GB OOM-kill.
    // Visibility is delayed by at most the debounce window plus one
    // build; an invalidation is never lost (scheduleRebuild repays a
    // mid-build invalidate via rebuildPending), and the snapshot is
    // never stale forever. Dashboard mutations only need the new
    // revision token — they must not pay a dozen Postgres round-trips
    // inside the mutating request — and the rebuild itself is now
    // deferred, not lazy-immediate.
    this.scheduleRebuild("operator");
    // Broadcast, because `reusePort` runs several gateway processes and each
    // holds its own snapshot: a console write handled by one of them left the
    // others serving pre-write routing until something else invalidated them.
    // Peers drop their copy on receipt and rebuild lazily, same as here — the
    // notice carries the tier, so peers rebuild on the same tier.
    publishRoutingInvalidation("operator");
    return this.revision;
  }

  /**
   * Background-tier invalidation, for automatic health/probe churn: one
   * account recovering or cooling, one pool flipping status, a quota
   * refresh healing or parking an account. These arrive at ~100/min and
   * each one alone almost never changes routing — a single account
   * joining or leaving a provider that still has hundreds usable — so
   * they batch into one rebuild per background window (5 min in
   * production) instead of one per event.
   *
   * Why time-batching, not content-based "materiality": there is no cheap
   * oracle for whether a health event changes routing — the only way to
   * know is the rebuild itself, which reads the whole catalog. The
   * batching bound is what matters: at most 12 background rebuilds/hour
   * no matter how hard health flaps, and a pending one is never lost —
   * the timer guarantees the rebuild, an operator invalidate pulls it
   * forward, and a mid-build one is repaid as a follow-up. Staleness is
   * bounded by the background window plus one build: a recovered account
   * stays invisible for at most that long (it only costs a little
   * capacity), and a newly-dead account stays listed for at most that
   * long (the dispatcher already fails over within a request when an
   * attempt against it fails, so it costs latency, not failures).
   */
  async invalidateBackground(): Promise<RoutingRevision> {
    this.revision += 1;
    this.invalidationsSinceLastBuild += 1;
    this.scheduleRebuild("background");
    publishRoutingInvalidation("background");
    return this.revision;
  }

  /** Stops background rebuilds. Test/teardown helper. */
  stop(): void {
    this.stopped = true;
    this.rebuildPending = false;
    this.pendingKind = undefined;
    this.rebuildTimerKind = undefined;
    if (this.rebuildTimer !== undefined) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = undefined;
    }
  }

  private async build(revision: RoutingRevision): Promise<RouteSnapshot> {
    const startedAt = Date.now();
    const before = process.memoryUsage();
    // Churn since the last build started: how many invalidations this one
    // build is absorbing. Reset here (not on completion) so a burst that
    // lands mid-build is counted against the follow-up, not this build.
    const invalidations = this.invalidationsSinceLastBuild;
    this.invalidationsSinceLastBuild = 0;
    const memMb = (usage: NodeJS.MemoryUsage): { rssMb: number; heapUsedMb: number; heapTotalMb: number } => ({
      rssMb: Math.round(usage.rss / 1048576),
      heapUsedMb: Math.round(usage.heapUsed / 1048576),
      heapTotalMb: Math.round(usage.heapTotal / 1048576),
    });
    // Rebuilds are logged start-to-finish: before the 2026-11-11 OOM fix
    // they were 100% silent in the journal, so a rebuild storm (a build
    // every ~20-40 s, ~1 GB per snapshot) was invisible until the kernel
    // killed the process. Duration, candidate count, and RSS/heap on both
    // sides make the next storm visible in the first minute.
    log.info("[snapshot] rebuild started", { revision, invalidations, ...memMb(before) });
    try {
      const snapshot = await this.buildInner(revision);
      const after = process.memoryUsage();
      // Revisions that landed while this build ran: they are what the
      // follow-up rebuild (if any) still owes. A large number here with a
      // small invalidations count means the churn arrived mid-build, not
      // in the batching window — the signature of a storm the gate did
      // not absorb.
      const revisionsSkipped = this.revision - revision;
      log.info("[snapshot] rebuild completed", {
        revision,
        durationMs: Date.now() - startedAt,
        candidates: snapshot.candidates.length,
        invalidations,
        revisionsSkipped,
        ...memMb(after),
      });
      // Retention tripwire, not an auto-capture: writing a heap snapshot
      // from inside the process that is already over 6 GB risks pushing
      // it over the edge (a V8 heap snapshot is itself a multi-GB
      // allocation + serialization). Log the manual capture command
      // instead — an operator runs it via the Bun inspector on the live
      // process, or restarts with the profiler attached.
      if (after.rss > 6 * 1024 * 1024 * 1024) {
        log.warn(
          "[snapshot] RSS over 6 GB after rebuild — capture a heap snapshot " +
            "via the Bun inspector before restarting (see docs), then stop the gateway",
          { revision, ...memMb(after) },
        );
      }
      return snapshot;
    } catch (error) {
      log.error(
        "[snapshot] rebuild failed",
        error instanceof Error ? error : undefined,
        { revision, durationMs: Date.now() - startedAt, thrownType: typeof error, invalidations, ...memMb(process.memoryUsage()) },
      );
      throw error;
    }
  }

  private async buildInner(revision: RoutingRevision): Promise<RouteSnapshot> {
    const built = await this.builder();
    const providerRouting: ProviderRoutingMap | undefined = built.providerRouting
      ? Object.fromEntries(
          Object.entries(built.providerRouting).map(([tenantId, settings]) => [
            tenantId,
            Object.fromEntries(
              Object.entries(settings).map(([providerId, setting]) => [
                providerId,
                { ...setting, rotateCount: setting.rotateCount ?? 1 },
              ]),
            ),
          ]),
        )
      : undefined;
    // One literal for both routing modes: two verbatim copies differing only by
    // the `providerRouting` key would mean a snapshot field added to one branch
    // silently vanishes on the other.
    const snapshot = deepFreeze({
      revision,
      candidates: Object.freeze([...built.candidates]) as readonly RouteCandidate[],
      aliases: Object.freeze({ ...built.aliases }),
      ...(built.cli_aliases ? { cli_aliases: Object.freeze({ ...built.cli_aliases }) } : {}),
      combos: Object.freeze({ ...built.combos }),
      ...(providerRouting ? { providerRouting } : {}),
      created_at: built.created_at ?? Date.now(),
    });
    // A mutation during the build means this snapshot describes a catalog that
    // has already been superseded. Returning it is fine — the caller asked
    // before the mutation — but caching it would strand the data plane on stale
    // routing until the next write.
    if (revision === this.revision) {
      this.snapshot = snapshot;
      this.lastGood = snapshot;
    }
    return snapshot;
  }
}
