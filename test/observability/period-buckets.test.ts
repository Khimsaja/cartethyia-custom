/**
 * The minute buckets have to agree with the fold they replace.
 *
 * The dashboard's counters used to be recomputed by walking every event in the
 * window on every poll. They are now folded once per minute, so the numbers an
 * operator reads must be identical to folding the window from zero — a bucket
 * that is cleared before it is re-folded, or a minute that is aged out, is
 * exactly where a double count or a silently dropped event would hide.
 *
 * `foldFromScratch` below is the original inline fold kept as the reference.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  queryTelemetryEvents,
  resetTelemetryIndex,
  TELEMETRY_EVENT_DIR,
  type TelemetryEventRecord,
} from "../../src/observability/event-log";
import { resetUsageBuckets, usageCounters } from "../../src/console/observability/period-buckets";
import { isGatewayError } from "../../src/observability/telemetry-status";

const FILE = "period-buckets-test.jsonl";
const PATH = join(TELEMETRY_EVENT_DIR, FILE);
const TENANT = "period-buckets-test-tenant";

interface Folded {
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
  statusCounts: Map<number, number>;
  models: Map<string, number>;
  providers: Map<string, number>;
}

/** The store's original inline fold, kept here as the independent reference. */
function foldFromScratch(events: readonly TelemetryEventRecord[]): Folded {
  const folded: Folded = {
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
    statusCounts: new Map(),
    models: new Map(),
    providers: new Map(),
  };
  for (const event of events) {
    folded.requests += 1;
    if (event.status === "completed") folded.completed += 1;
    folded.inputTokens += event.inputTokens ?? 0;
    folded.outputTokens += event.outputTokens ?? 0;
    if (event.cachedInputTokens !== null && event.cachedInputTokens > 0) {
      folded.cachedTokens += event.inputTokens ?? 0;
    }
    if (isGatewayError(event.status, event.httpStatus)) folded.errors += 1;
    if (event.status === "cancelled") folded.cancelled += 1;
    if (event.status === "truncated") folded.truncated += 1;
    if (event.estimatedCostUsd !== null) folded.estimatedCostUsd += event.estimatedCostUsd;
    else if (event.status === "completed") folded.unpriced += 1;
    const status =
      event.httpStatus ??
      (event.status === "completed" ? 200 : event.status === "cancelled" ? 499 : event.status === "truncated" ? 502 : 500);
    folded.statusCounts.set(status, (folded.statusCounts.get(status) ?? 0) + 1);
    if (event.requestedModel) {
      folded.models.set(event.requestedModel, (folded.models.get(event.requestedModel) ?? 0) + 1);
    }
    if (event.providerId) {
      folded.providers.set(event.providerId, (folded.providers.get(event.providerId) ?? 0) + 1);
    }
  }
  return folded;
}

function line(input: {
  id: string;
  createdAt: string;
  status: string;
  httpStatus: number | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number | null;
  estimatedCostUsd?: number | null;
  requestedModel?: string;
  providerId?: string;
}): string {
  return JSON.stringify({ tenantId: TENANT, requestId: input.id, ...input });
}

const RECENT = new Date(Date.now() - 30_000);
const APPENDED = new Date(Date.now() - 10_000);
const OLD = new Date(Date.now() - 5 * 60_000);

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

function expectSameAsFold(counts: Awaited<ReturnType<typeof usageCounters>>, folded: Folded): void {
  expect(counts.requests).toBe(folded.requests);
  expect(counts.completed).toBe(folded.completed);
  expect(counts.inputTokens).toBe(folded.inputTokens);
  expect(counts.cachedTokens).toBe(folded.cachedTokens);
  expect(counts.outputTokens).toBe(folded.outputTokens);
  expect(counts.errors).toBe(folded.errors);
  expect(counts.cancelled).toBe(folded.cancelled);
  expect(counts.truncated).toBe(folded.truncated);
  expect(counts.estimatedCostUsd).toBeCloseTo(folded.estimatedCostUsd, 10);
  expect(counts.unpriced).toBe(folded.unpriced);
  expect([...counts.statusCounts].sort(([a], [b]) => a - b)).toEqual(
    [...folded.statusCounts].sort(([a], [b]) => a - b),
  );
  expect([...counts.models].sort()).toEqual([...folded.models].sort());
  expect([...counts.providers].sort()).toEqual([...folded.providers].sort());
}

describe("usage minute buckets", () => {
  beforeAll(async () => {
    await mkdir(TELEMETRY_EVENT_DIR, { recursive: true });
    await rm(PATH, { force: true });
    resetTelemetryIndex();
    resetUsageBuckets();
    const lines = [
      // Chronological, because that is the order the writer appends in:
      // `createdAt` is stamped at flush time. Older than the window below, and
      // in its own minute, so the window must exclude it by whole minutes
      // rather than by event.
      line({
        id: "old",
        createdAt: OLD.toISOString(),
        status: "completed",
        httpStatus: 200,
        inputTokens: 9_999,
        outputTokens: 9_999,
        estimatedCostUsd: 9.99,
      }),
      line({
        id: "a",
        createdAt: RECENT.toISOString(),
        status: "completed",
        httpStatus: 200,
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 20,
        estimatedCostUsd: 0.01,
        requestedModel: "m1",
        providerId: "p1",
      }),
      line({
        id: "b",
        createdAt: RECENT.toISOString(),
        status: "completed",
        httpStatus: 200,
        inputTokens: 200,
        outputTokens: 20,
        cachedInputTokens: 0,
        estimatedCostUsd: 0.02,
        requestedModel: "m1",
        providerId: "p2",
      }),
      line({
        id: "c",
        createdAt: RECENT.toISOString(),
        status: "failed",
        httpStatus: 500,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: null,
        providerId: "p1",
      }),
      line({
        id: "d",
        createdAt: RECENT.toISOString(),
        status: "cancelled",
        httpStatus: null,
        inputTokens: 5,
        outputTokens: 0,
        cachedInputTokens: null,
      }),
    ];
    await appendFile(PATH, `${lines.join("\n")}\n`, "utf8");
  });

  afterAll(async () => {
    await rm(PATH, { force: true });
    resetTelemetryIndex();
    resetUsageBuckets();
  });

  test("agrees with a fold from scratch over the window", async () => {
    const since = new Date(Date.now() - 60_000);
    const events = await queryTelemetryEvents({ tenantId: TENANT, since });
    expectSameAsFold(await usageCounters(TENANT, since), foldFromScratch(events));
  });

  test("keeps agreeing after an event is appended", async () => {
    await settle();
    const since = new Date(Date.now() - 60_000);
    await appendFile(
      PATH,
      `${line({
        id: "e",
        createdAt: APPENDED.toISOString(),
        status: "completed",
        httpStatus: 200,
        inputTokens: 7,
        outputTokens: 3,
        cachedInputTokens: 7,
        estimatedCostUsd: 0.5,
        requestedModel: "m2",
        providerId: "p1",
      })}\n`,
      "utf8",
    );
    await settle();

    const events = await queryTelemetryEvents({ tenantId: TENANT, since });
    expect(events.some((event) => event.requestId === "e")).toBe(true);
    expectSameAsFold(await usageCounters(TENANT, since), foldFromScratch(events));
  });
});
