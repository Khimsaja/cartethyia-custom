import { describe, expect, test, beforeEach } from "bun:test";
import {
  getPublicNetworkStats,
  getBansosDeepseekStatus,
  BANSOS_DEEPSEEK_KEY_LABEL,
  clearPublicNetworkStatsCache,
  PUBLIC_STATS_CACHE_TTL_MS,
} from "../../src/console/public-network-stats";

function fakeDb(
  totalsRow: Record<string, unknown>,
  topRows: Record<string, unknown>[],
  healthRows: Record<string, unknown>[] = topRows,
  templateModels: string[] = healthRows.map((r) => String(r.model)),
) {
  return {
    query: async (sql: string) => {
      if (sql.includes("GROUP BY")) {
        // The 1-hour health query feeds the public status page; the 24h
        // query feeds the top-models table. The health query filters to the
        // buyer template — simulate that filter here.
        if (sql.includes("1 hour")) {
          if (!sql.includes("api_keys")) throw new Error("health query must filter to buyer key whitelists");
          return { rows: healthRows.filter((r) => templateModels.includes(String(r.model))) };
        }
        return { rows: topRows };
      }
      return { rows: [totalsRow] };
    },
  } as never;
}

describe("public-network-stats", () => {
  beforeEach(() => clearPublicNetworkStatsCache());
  test("aggregates totals and top models, never leaks per-key data", async () => {
    const db = fakeDb(
      { requests: "100", ok: "96", input_tokens: "123456", output_tokens: "7890" },
      [
        { model: "deepseek-v4.1-flash", hits: "60", ok: "58" },
        { model: "glm-5-3-flash", hits: "40", ok: "38" },
      ],
    );
    const stats = await getPublicNetworkStats(db);
    expect(stats.window).toBe("24h");
    expect(stats.requests).toBe(100);
    expect(stats.ok).toBe(96);
    expect(stats.success_rate).toBeCloseTo(0.96, 5);
    expect(stats.input_tokens).toBe(123456);
    expect(stats.output_tokens).toBe(7890);
    expect(stats.top_models).toHaveLength(2);
    expect(stats.top_models[0]).toEqual({ model: "deepseek-v4.1-flash", hits: 60, ok: 58, tokens: 0 });
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
    const db = fakeDb({ requests: "0", ok: "0", input_tokens: "0", output_tokens: "0" }, []);
    const stats = await getPublicNetworkStats(db);
    expect(stats.success_rate).toBe(0);
    expect(stats.top_models).toEqual([]);
    expect(stats.model_health_1h).toEqual([]);
  });

  test("model_health_1h covers all models with 1h traffic for the status page", async () => {
    const db = fakeDb(
      { requests: "100", ok: "96", input_tokens: "1", output_tokens: "1" },
      [{ model: "a", hits: "60", ok: "58", tokens: "10" }],
      [
        { model: "a", hits: "60", ok: "58" },
        { model: "b", hits: "5", ok: "1" },
        { model: "c", hits: "0", ok: "0" },
      ],
    );
    const stats = await getPublicNetworkStats(db);
    // No top-N cut: even the quiet/broken models show up on /status.
    expect(stats.model_health_1h).toEqual([
      { model: "a", hits: 60, ok: 58 },
      { model: "b", hits: 5, ok: 1 },
      { model: "c", hits: 0, ok: 0 },
    ]);
    // Health carries no token/cost data — hits and ok only.
    expect(JSON.stringify(stats.model_health_1h)).not.toMatch(/tokens|cost/i);
  });

  test("model_health_1h only includes buyer-template models", async () => {
    const db = fakeDb(
      { requests: "10", ok: "9", input_tokens: "1", output_tokens: "1" },
      [{ model: "a", hits: "6", ok: "6", tokens: "1" }],
      [
        { model: "a", hits: "6", ok: "6" },
        { model: "infra-only-model", hits: "4", ok: "4" },
      ],
      ["a"],
    );
    const stats = await getPublicNetworkStats(db);
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
