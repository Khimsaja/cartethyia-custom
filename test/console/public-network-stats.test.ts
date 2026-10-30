import { describe, expect, test, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The telemetry directory resolves at import time, so the sandbox must be
// set before importing the module under test (repo meta-test rule:
// every test that uses TELEMETRY_EVENT_DIR sandboxes CARTETHYIA_DATA_DIR).
const sandbox = await mkdtemp(join(tmpdir(), "carte-public-stats-"));
const previousDataDir = process.env.CARTETHYIA_DATA_DIR;
process.env.CARTETHYIA_DATA_DIR = sandbox;

const {
  getPublicNetworkStats,
  getBansosDeepseekStatus,
  BANSOS_DEEPSEEK_KEY_LABEL,
  clearPublicNetworkStatsCache,
  PUBLIC_STATS_CACHE_TTL_MS,
} = await import("../../src/console/public-network-stats");
const { TELEMETRY_EVENT_DIR } = await import("../../src/observability/event-log");

afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.CARTETHYIA_DATA_DIR;
  else process.env.CARTETHYIA_DATA_DIR = previousDataDir;
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * The module no longer aggregates SQL rows: since 2026-10-19 it reads the
 * hourly JSONL telemetry files and filters the 1h health list through the
 * 'tiprouter new' template's model list. The old fakeDb below simulated the
 * retired GROUP BY queries, so every test that asserted on seeded rows
 * failed with empty results. These tests now seed real event files in the
 * directory the module actually reads, and stub only the template query.
 */

function hourFile(): string {
  const stamp = new Date().toISOString().slice(0, 13).replaceAll(":", "-");
  return join(TELEMETRY_EVENT_DIR, `${stamp}-00.jsonl`);
}

type SeedEvent = {
  model: string;
  minutesAgo: number;
  status: string;
  httpStatus?: number;
  inputTokens?: number;
  outputTokens?: number;
};

let seedCounter = 0;
async function seedEvents(events: SeedEvent[]): Promise<void> {
  await mkdir(TELEMETRY_EVENT_DIR, { recursive: true });
  const now = Date.now();
  const lines = events.map((e) => {
    seedCounter++;
    return JSON.stringify({
      tenantId: "test-tenant",
      requestId: `req-${seedCounter}`,
      createdAt: new Date(now - e.minutesAgo * 60_000).toISOString(),
      requestedModel: e.model,
      status: e.status,
      httpStatus: e.httpStatus ?? 200,
      inputTokens: e.inputTokens ?? 0,
      outputTokens: e.outputTokens ?? 0,
    });
  });
  await writeFile(hourFile(), `${lines.join("\n")}\n`, "utf8");
}

async function clearSeed(): Promise<void> {
  await rm(hourFile(), { force: true });
}

/** Stubs only the template allowlist query; telemetry comes from seeded files. */
function templateDb(models: string[]) {
  return {
    query: async (sql: string) => {
      if (sql.includes("model_templates")) return { rows: models.map((model) => ({ model })) };
      return { rows: [] };
    },
  } as never;
}

describe("public-network-stats", () => {
  beforeEach(async () => {
    clearPublicNetworkStatsCache();
    await clearSeed();
  });
  afterEach(async () => {
    await clearSeed();
  });

  test("aggregates totals and top models, never leaks per-key data", async () => {
    const events: SeedEvent[] = [];
    for (let i = 0; i < 58; i++) {
      events.push({ model: "deepseek-v4.1-flash", minutesAgo: 30, status: "completed", inputTokens: 100, outputTokens: 10 });
    }
    for (let i = 0; i < 2; i++) {
      events.push({ model: "deepseek-v4.1-flash", minutesAgo: 30, status: "failed", httpStatus: 500 });
    }
    // A 429 is client-side throttling, not an error: excluded everywhere.
    events.push({ model: "deepseek-v4.1-flash", minutesAgo: 30, status: "failed", httpStatus: 429 });
    for (let i = 0; i < 38; i++) {
      events.push({ model: "glm-5-3-flash", minutesAgo: 30, status: "completed", inputTokens: 100, outputTokens: 10 });
    }
    for (let i = 0; i < 2; i++) {
      events.push({ model: "glm-5-3-flash", minutesAgo: 30, status: "failed", httpStatus: 500 });
    }
    await seedEvents(events);
    const stats = await getPublicNetworkStats(templateDb(["deepseek-v4.1-flash", "glm-5-3-flash"]));
    expect(stats.window).toBe("24h");
    expect(stats.requests).toBe(100);
    expect(stats.ok).toBe(96);
    expect(stats.success_rate).toBeCloseTo(0.96, 5);
    expect(stats.input_tokens).toBe(9600);
    expect(stats.output_tokens).toBe(960);
    expect(stats.top_models).toHaveLength(2);
    expect(stats.top_models[0]).toEqual({ model: "deepseek-v4.1-flash", hits: 60, ok: 58, tokens: 6380 });
    expect(stats.top_models[1]).toEqual({ model: "glm-5-3-flash", hits: 40, ok: 38, tokens: 4180 });
    // Aggregate-only: no cost, key, ip, or client fields anywhere.
    const json = JSON.stringify(stats);
    expect(json).not.toMatch(/cost|api_key|client_ip|key_id/i);
  });

  test("caches for 30s: second call does not hit the db", async () => {
    let calls = 0;
    const db = {
      query: async () => {
        calls++;
        return { rows: [{ requests: "1", ok: "1", input_tokens: "1", output_tokens: "1" }] };
      },
    } as never;
    await getPublicNetworkStats(db);
    const firstCalls = calls;
    await getPublicNetworkStats(db);
    expect(calls).toBe(firstCalls);
    expect(PUBLIC_STATS_CACHE_TTL_MS).toBe(30_000);
  });

  test("zero requests yields zeroed stats without NaN", async () => {
    const stats = await getPublicNetworkStats(templateDb([]));
    expect(stats.success_rate).toBe(0);
    expect(stats.top_models).toEqual([]);
    expect(stats.model_health_1h).toEqual([]);
  });

  test("model_health_1h covers all models with 1h traffic for the status page", async () => {
    const events: SeedEvent[] = [];
    for (let i = 0; i < 58; i++) events.push({ model: "a", minutesAgo: 30, status: "completed" });
    for (let i = 0; i < 2; i++) events.push({ model: "a", minutesAgo: 30, status: "failed", httpStatus: 500 });
    // Older than the 1h window: counts toward 24h totals, not toward health.
    events.push({ model: "a", minutesAgo: 120, status: "completed" });
    events.push({ model: "b", minutesAgo: 30, status: "completed" });
    for (let i = 0; i < 4; i++) events.push({ model: "b", minutesAgo: 30, status: "failed", httpStatus: 500 });
    // A broken model (traffic, zero successes) still shows up: no top-N cut.
    for (let i = 0; i < 3; i++) events.push({ model: "c", minutesAgo: 30, status: "failed", httpStatus: 500 });
    await seedEvents(events);
    const stats = await getPublicNetworkStats(templateDb(["a", "b", "c"]));
    expect(stats.model_health_1h).toEqual([
      { model: "a", hits: 60, ok: 58 },
      { model: "b", hits: 5, ok: 1 },
      { model: "c", hits: 3, ok: 0 },
    ]);
    // Health carries no token/cost data — hits and ok only.
    expect(JSON.stringify(stats.model_health_1h)).not.toMatch(/tokens|cost/i);
  });

  test("model_health_1h only includes buyer-template models", async () => {
    const events: SeedEvent[] = [];
    for (let i = 0; i < 6; i++) events.push({ model: "a", minutesAgo: 30, status: "completed" });
    for (let i = 0; i < 4; i++) events.push({ model: "infra-only-model", minutesAgo: 30, status: "completed" });
    await seedEvents(events);
    const stats = await getPublicNetworkStats(templateDb(["a"]));
    // Traffic from infra keys / playground on other models must not leak
    // onto the buyer-facing status page.
    expect(stats.model_health_1h).toEqual([{ model: "a", hits: 6, ok: 6 }]);
  });
});

describe("bansos-deepseek status", () => {
  test("returns null when the shared key does not exist", async () => {
    const db = { query: async () => ({ rows: [] }) } as never;
    expect(await getBansosDeepseekStatus(db)).toBeNull();
  });

  test("queries the shared bansos key by its fixed label", async () => {
    let seenSql = "";
    const db = {
      query: async (sql: string) => {
        seenSql = sql;
        return { rows: [] };
      },
    } as never;
    await getBansosDeepseekStatus(db);
    expect(seenSql).toContain(BANSOS_DEEPSEEK_KEY_LABEL);
    expect(seenSql).toContain("lifetime_token_budget");
  });
});
