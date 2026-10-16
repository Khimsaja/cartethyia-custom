/**
 * Minute-bucketed usage aggregates, one set of minutes per tenant.
 *
 * Every console usage endpoint used to fold the whole retained window on each
 * poll, on the same event loop that serves the requests — so the busier the
 * gateway, the slower the page that reports on it. The counts those endpoints
 * need are additive, so each event is folded once into the minute it belongs
 * to and a window is the sum of its minutes: a poll re-reads the current
 * minute and leaves the settled ones alone, and a period is a range over the
 * same minutes rather than its own copy.
 *
 * Only the open minutes are ever recomputed, and they are cleared before they
 * are folded again, so nothing is counted twice. Ageing out drops a whole
 * minute, which is why a window's oldest edge can cover up to one extra
 * minute — the alternative is undoing per-event contributions, and an unfold
 * that drifts from its fold is a wrong number nobody can see.
 */
import type { TelemetryEventRecord } from "../../observability/event-log";
import { indexedEventsSince } from "../../observability/event-log";
import { isGatewayError } from "../../observability/telemetry-status";

const MINUTE_MS = 60_000;

/**
 * Ceiling on retained minutes per tenant, so a long `all` window cannot grow
 * without bound. 21 600 minutes is 15 days.
 */
const MAX_MINUTES = 21_600;

/** The HTTP status a row renders as when the wire status was never recorded. */
export function effectiveHttpStatus(event: TelemetryEventRecord): number {
  if (event.httpStatus !== null) return event.httpStatus;
  if (event.status === "completed") return 200;
  if (event.status === "cancelled") return 499;
  if (event.status === "truncated") return 502;
  return 500;
}

/** Additive counters for one minute or one summed window. */
export interface UsageCounters {
  requests: number;
  completed: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  errors: number;
  cancelled: number;
  truncated: number;
  estimatedCostUsd: number;
  unpriced: number;
  tokensPerSecSum: number;
  tokensPerSecCount: number;
  latencySum: number;
  latencyCount: number;
  resolveSum: number;
  resolveCount: number;
  statusCounts: Map<number, number>;
  models: Map<string, number>;
  providers: Map<string, number>;
}

/** One chart bucket's additive totals. */
export interface ChartCounts {
  requests: number;
  input: number;
  cached: number;
  output: number;
}

function emptyCounters(): UsageCounters {
  return {
    requests: 0,
    completed: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    errors: 0,
    cancelled: 0,
    truncated: 0,
    estimatedCostUsd: 0,
    unpriced: 0,
    tokensPerSecSum: 0,
    tokensPerSecCount: 0,
    latencySum: 0,
    latencyCount: 0,
    resolveSum: 0,
    resolveCount: 0,
    statusCounts: new Map(),
    models: new Map(),
    providers: new Map(),
  };
}

function bump(map: Map<number, number> | Map<string, number>, key: number | string): void {
  const counts = map as Map<number | string, number>;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Folds one event into a minute's counters. Linear by construction. */
function addEvent(counts: UsageCounters, event: TelemetryEventRecord): void {
  counts.requests += 1;
  if (event.status === "completed") counts.completed += 1;
  counts.inputTokens += event.inputTokens ?? 0;
  counts.outputTokens += event.outputTokens ?? 0;
  if (event.cachedInputTokens !== null && event.cachedInputTokens > 0) {
    counts.cachedTokens += event.inputTokens ?? 0;
  }
  if (isGatewayError(event.status, event.httpStatus)) counts.errors += 1;
  if (event.status === "cancelled") counts.cancelled += 1;
  if (event.status === "truncated") counts.truncated += 1;
  if (event.estimatedCostUsd !== null) counts.estimatedCostUsd += event.estimatedCostUsd;
  else if (event.status === "completed") counts.unpriced += 1;
  if (event.tokensPerSec !== null) {
    counts.tokensPerSecSum += event.tokensPerSec;
    counts.tokensPerSecCount += 1;
  }
  if (event.latencyMs !== null) {
    counts.latencySum += event.latencyMs;
    counts.latencyCount += 1;
  }
  if (event.resolveMs !== null) {
    counts.resolveSum += event.resolveMs;
    counts.resolveCount += 1;
  }
  bump(counts.statusCounts, effectiveHttpStatus(event));
  if (event.requestedModel) bump(counts.models, event.requestedModel);
  if (event.providerId) bump(counts.providers, event.providerId);
}

/** Adds one counter set into another. Used to sum minutes into a window. */
function mergeCounters(target: UsageCounters, source: UsageCounters): void {
  target.requests += source.requests;
  target.completed += source.completed;
  target.inputTokens += source.inputTokens;
  target.cachedTokens += source.cachedTokens;
  target.outputTokens += source.outputTokens;
  target.errors += source.errors;
  target.cancelled += source.cancelled;
  target.truncated += source.truncated;
  target.estimatedCostUsd += source.estimatedCostUsd;
  target.unpriced += source.unpriced;
  target.tokensPerSecSum += source.tokensPerSecSum;
  target.tokensPerSecCount += source.tokensPerSecCount;
  target.latencySum += source.latencySum;
  target.latencyCount += source.latencyCount;
  target.resolveSum += source.resolveSum;
  target.resolveCount += source.resolveCount;
  for (const [status, count] of source.statusCounts) {
    target.statusCounts.set(status, (target.statusCounts.get(status) ?? 0) + count);
  }
  for (const [model, count] of source.models) {
    target.models.set(model, (target.models.get(model) ?? 0) + count);
  }
  for (const [provider, count] of source.providers) {
    target.providers.set(provider, (target.providers.get(provider) ?? 0) + count);
  }
}

interface TenantMinutes {
  minutes: Map<number, UsageCounters>;
  /** Minute boundary at or after which minutes are recomputed on the next poll. */
  settledUntil: number;
  /** Oldest window edge any caller has asked for; minutes before it are dropped. */
  horizon: number;
  seeded: boolean;
}

const minutesByTenant = new Map<string, TenantMinutes>();

/** Drops the bucket state. Tests use it; nothing on the request path does. */
export function resetUsageBuckets(): void {
  minutesByTenant.clear();
}

function minuteStart(at: number): number {
  return Math.floor(at / MINUTE_MS) * MINUTE_MS;
}

async function refresh(tenantId: string, since: number | undefined): Promise<TenantMinutes> {
  const state = minutesByTenant.get(tenantId) ?? {
    minutes: new Map<number, UsageCounters>(),
    settledUntil: 0,
    horizon: since ?? 0,
    seeded: false,
  };
  minutesByTenant.set(tenantId, state);
  if (since !== undefined) state.horizon = state.horizon === 0 ? since : Math.min(state.horizon, since);

  const boundary = minuteStart(Date.now());
  // First fold: the whole window the caller asked for. Afterwards: only the
  // minutes that are still open, which is the current one at most.
  const from = state.seeded ? Math.max(state.settledUntil, boundary) : (since ?? 0);
  for (const [start] of state.minutes) {
    if (start >= from) state.minutes.delete(start);
  }
  const events = await indexedEventsSince(from === 0 ? undefined : new Date(from), tenantId);
  for (const event of events) {
    const at = new Date(event.createdAt).getTime();
    if (!Number.isFinite(at)) continue;
    if (from !== 0 && at < from) continue;
    const start = minuteStart(at);
    const counts = state.minutes.get(start) ?? emptyCounters();
    addEvent(counts, event);
    state.minutes.set(start, counts);
  }
  state.settledUntil = Math.max(state.settledUntil, boundary);
  state.seeded = true;

  const floor = state.horizon === 0 ? 0 : minuteStart(state.horizon);
  while (state.minutes.size > MAX_MINUTES) {
    const oldest = Math.min(...state.minutes.keys());
    state.minutes.delete(oldest);
  }
  for (const start of state.minutes.keys()) {
    if (start < floor) state.minutes.delete(start);
  }
  return state;
}

/** Walks minutes oldest-first while a window is summed, so order is never assumed. */
function minutesFrom(state: TenantMinutes, since: number | undefined): number[] {
  const floor = since === undefined ? Number.NEGATIVE_INFINITY : minuteStart(since);
  return [...state.minutes.keys()].filter((start) => start >= floor).sort((a, b) => a - b);
}

/** The summed counters for one window. */
export async function usageCounters(
  tenantId: string,
  since: Date | undefined,
): Promise<UsageCounters> {
  const state = await refresh(tenantId, since?.getTime());
  const total = emptyCounters();
  for (const start of minutesFrom(state, since?.getTime())) {
    const counts = state.minutes.get(start);
    if (counts) mergeCounters(total, counts);
  }
  return total;
}

/** The chart's per-bucket totals for one window. */
export async function usageChartCounters(
  tenantId: string,
  since: Date | undefined,
  stepMs: number,
): Promise<Map<number, ChartCounts>> {
  const state = await refresh(tenantId, since?.getTime());
  const buckets = new Map<number, ChartCounts>();
  for (const start of minutesFrom(state, since?.getTime())) {
    const counts = state.minutes.get(start);
    if (counts === undefined) continue;
    const bucketStart = Math.floor(start / stepMs) * stepMs;
    const bucket = buckets.get(bucketStart) ?? { requests: 0, input: 0, cached: 0, output: 0 };
    bucket.requests += counts.requests;
    bucket.input += counts.inputTokens;
    bucket.cached += counts.cachedTokens;
    bucket.output += counts.outputTokens;
    buckets.set(bucketStart, bucket);
  }
  return buckets;
}
