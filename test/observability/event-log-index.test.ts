/**
 * The dashboard polls its usage endpoints every few seconds over a window that
 * can hold millions of retained events. Before the index, every poll re-read
 * and re-parsed the whole window from the hourly files, on the same event loop
 * that serves the requests — so traffic slowed the console that reports it.
 *
 * These lock the two properties that separate the read cost from the traffic:
 * a poll reads only the bytes appended since the last one, and a line a writer
 * is still appending is never consumed early.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  queryTelemetryEvents,
  resetTelemetryIndex,
  telemetryIndexStats,
  TELEMETRY_EVENT_DIR,
} from "../../src/observability/event-log";

const FILE = "event-log-index-test.jsonl";
const PATH = join(TELEMETRY_EVENT_DIR, FILE);
const TENANT = "event-log-index-test-tenant";

function event(requestId: string, createdAt: string): string {
  return JSON.stringify({
    id: requestId,
    requestId,
    tenantId: TENANT,
    createdAt,
    status: "completed",
    httpStatus: 200,
  });
}

/** Long enough to outlive the index's refresh TTL, so the next read re-tails. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

function bytesRead(): number {
  return telemetryIndexStats().bytesRead;
}

describe("telemetry event index", () => {
  beforeAll(async () => {
    await mkdir(TELEMETRY_EVENT_DIR, { recursive: true });
    await rm(PATH, { force: true });
    resetTelemetryIndex();
    const first = `${[
      event("a", "2026-01-01T00:00:01.000Z"),
      event("b", "2026-01-01T00:00:02.000Z"),
      event("c", "2026-01-01T00:00:03.000Z"),
    ].join("\n")}\n`;
    await appendFile(PATH, first, "utf8");
  });

  afterAll(async () => {
    await rm(PATH, { force: true });
    resetTelemetryIndex();
  });

  test("reads the file once, then only the bytes appended since", async () => {
    const cold = await queryTelemetryEvents({ tenantId: TENANT });
    expect(cold.map((row) => row.requestId)).toEqual(["c", "b", "a"]);
    const afterCold = bytesRead();

    await settle();
    const appended = `${event("d", "2026-01-01T00:00:04.000Z")}\n`;
    await appendFile(PATH, appended, "utf8");

    await settle();
    const warm = await queryTelemetryEvents({ tenantId: TENANT });
    expect(warm.map((row) => row.requestId)).toEqual(["d", "c", "b", "a"]);

    // The whole point: the second poll paid for the appended line, not for the
    // file it had already parsed — a full re-parse would add the file's size.
    const afterWarm = bytesRead();
    const fileSize = (await stat(PATH)).size;
    expect(afterWarm - afterCold).toBeGreaterThanOrEqual(Buffer.byteLength(appended, "utf8"));
    expect(afterWarm - afterCold).toBeLessThan(fileSize);
  });

  test("does not consume a line a writer is still appending", async () => {
    const before = (await queryTelemetryEvents({ tenantId: TENANT })).length;

    await settle();
    const torn = event("e", "2026-01-01T00:00:05.000Z");
    await appendFile(PATH, torn.slice(0, torn.length - 12), "utf8");

    await settle();
    const during = await queryTelemetryEvents({ tenantId: TENANT });
    expect(during).toHaveLength(before);
    expect(during.some((row) => row.requestId === "e")).toBe(false);

    // Completing the line makes it readable; the offset was never advanced
    // past the partial bytes, so nothing was lost.
    await settle();
    await appendFile(PATH, `${torn.slice(torn.length - 12)}\n`, "utf8");
    await settle();
    const after = await queryTelemetryEvents({ tenantId: TENANT });
    expect(after.map((row) => row.requestId)).toContain("e");
    expect(after).toHaveLength(before + 1);
  });
});
