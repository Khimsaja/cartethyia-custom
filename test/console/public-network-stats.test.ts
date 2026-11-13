/**
 * Public network statistics (buyer-facing /api/stats/public feed).
 *
 * Aggregates run in SQL against telemetry_events (never a JSONL scan):
 * totals and top models over 24h, per-model health over the last hour for
 * the buyer-template allowlist. 429 rate-limit rejections and 499 client
 * aborts are excluded everywhere; the response is aggregate-only.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import {
  apiKeys,
  modelTemplates,
  providers,
  telemetryEvents,
  tenants,
} from "../../src/persistence/schema";
import {
  BUYER_TEMPLATE_NAME,
  PUBLIC_STATS_CACHE_TTL_MS,
  clearPublicNetworkStatsCache,
  getPublicNetworkStats,
} from "../../src/console/public-network-stats";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "carte-public-stats-"));
  const sqlite = createSqliteDatabase(join(dir, "q.sqlite"));
  await applySqliteMigrations(sqlite);
  const { db } = buildSqliteHandle(sqlite);
  const [tenant] = await db
    .insert(tenants)
    .values({ name: "public-stats", status: "active" })
    .returning({ id: tenants.id });
  if (tenant === undefined) throw new Error("tenant insert returned no row");
  await db.insert(providers).values({ id: "p" });
  const [key] = await db
    .insert(apiKeys)
    .values({
      tenantId: tenant.id,
      keyMode: "personal",
      keyHash: "hash-ps",
      label: "k",
      scopes: ["routing:invoke"],
    })
    .returning({ id: apiKeys.id });
  return {
    db,
    tenantId: tenant.id,
    apiKeyId: key?.id ?? "",
    cleanup: () => {
      try {
        sqlite.close();
      } catch {
        /* already closed */
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          /* retry */
        }
      }
    },
  };
}

type SeedEvent = {
  model: string | null;
  minutesAgo: number;
  status: "completed" | "failed" | "cancelled" | "truncated";
  httpStatus?: number | null;
  inputTokens?: number;
  outputTokens?: number;
};

async function seedEvents(
  fx: Awaited<ReturnType<typeof fixture>>,
  events: SeedEvent[],
): Promise<void> {
  const now = Date.now();
  for (const e of events) {
    await fx.db.insert(telemetryEvents).values({
      id: crypto.randomUUID(),
      tenantId: fx.tenantId,
      requestId: crypto.randomUUID(),
      createdAt: new Date(now - e.minutesAgo * 60_000),
      sourceSurface: "chat",
      requestedModel: e.model,
      providerId: "p",
      apiKeyId: fx.apiKeyId,
      status: e.status,
      httpStatus: e.httpStatus ?? 200,
      inputTokens: e.inputTokens ?? 0,
      outputTokens: e.outputTokens ?? 0,
    });
  }
}

async function seedTemplate(
  fx: Awaited<ReturnType<typeof fixture>>,
  models: readonly string[],
): Promise<void> {
  await fx.db.insert(modelTemplates).values({
    tenantId: fx.tenantId,
    name: BUYER_TEMPLATE_NAME,
    models: [...models],
  });
}

describe("public-network-stats", () => {
  beforeEach(() => {
    clearPublicNetworkStatsCache();
  });

  test("aggregates totals and top models, never leaks per-key data", async () => {
    const fx = await fixture();
    try {
      await seedTemplate(fx, ["deepseek-v4.1-flash", "glm-5-3-flash"]);
      const events: SeedEvent[] = [];
      for (let i = 0; i < 58; i++) {
        events.push({ model: "deepseek-v4.1-flash", minutesAgo: 30, status: "completed", inputTokens: 100, outputTokens: 10 });
      }
      for (let i = 0; i < 2; i++) {
        events.push({ model: "deepseek-v4.1-flash", minutesAgo: 30, status: "failed", httpStatus: 500 });
      }
      // A 429 is client-side throttling, not an error: excluded everywhere.
      events.push({ model: "deepseek-v4.1-flash", minutesAgo: 30, status: "failed", httpStatus: 429 });
      // A 499 is a client abort (buyer closed the connection mid-stream),
      // also not a gateway/upstream error: excluded everywhere.
      events.push({ model: "deepseek-v4.1-flash", minutesAgo: 30, status: "cancelled", httpStatus: 499 });
      for (let i = 0; i < 38; i++) {
        events.push({ model: "glm-5-3-flash", minutesAgo: 30, status: "completed", inputTokens: 100, outputTokens: 10 });
      }
      for (let i = 0; i < 2; i++) {
        events.push({ model: "glm-5-3-flash", minutesAgo: 30, status: "failed", httpStatus: 500 });
      }
      await seedEvents(fx, events);
      const stats = await getPublicNetworkStats(fx.db, fx.tenantId);
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
    } finally {
      fx.cleanup();
    }
  });

  test("caches for 30s: second call serves the cached snapshot", async () => {
    const fx = await fixture();
    try {
      await seedTemplate(fx, ["a"]);
      await seedEvents(fx, [
        { model: "a", minutesAgo: 30, status: "completed", inputTokens: 10, outputTokens: 5 },
      ]);
      const first = await getPublicNetworkStats(fx.db, fx.tenantId);
      expect(first.requests).toBe(1);
      // New rows land after the first call: the cached snapshot must not move.
      await seedEvents(fx, [
        { model: "a", minutesAgo: 5, status: "completed", inputTokens: 10, outputTokens: 5 },
      ]);
      const second = await getPublicNetworkStats(fx.db, fx.tenantId);
      expect(second.requests).toBe(1);
      expect(second.generated_at).toBe(first.generated_at);
      // Clearing the cache re-reads: the new row shows up.
      clearPublicNetworkStatsCache();
      const third = await getPublicNetworkStats(fx.db, fx.tenantId);
      expect(third.requests).toBe(2);
      expect(PUBLIC_STATS_CACHE_TTL_MS).toBe(30_000);
    } finally {
      fx.cleanup();
    }
  });

  test("zero requests yields zeroed stats without NaN", async () => {
    const fx = await fixture();
    try {
      const stats = await getPublicNetworkStats(fx.db, fx.tenantId);
      expect(stats.requests).toBe(0);
      expect(stats.ok).toBe(0);
      expect(stats.success_rate).toBe(0);
      expect(stats.top_models).toEqual([]);
      expect(stats.model_health_1h).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  test("model_health_1h covers all models with 1h traffic for the status page", async () => {
    const fx = await fixture();
    try {
      await seedTemplate(fx, ["a", "b", "c"]);
      const events: SeedEvent[] = [];
      for (let i = 0; i < 58; i++) events.push({ model: "a", minutesAgo: 30, status: "completed" });
      for (let i = 0; i < 2; i++) events.push({ model: "a", minutesAgo: 30, status: "failed", httpStatus: 500 });
      // A 499 client abort inside the 1h window: excluded from health too.
      events.push({ model: "a", minutesAgo: 30, status: "cancelled", httpStatus: 499 });
      // Older than the 1h window: counts toward 24h totals, not toward health.
      events.push({ model: "a", minutesAgo: 120, status: "completed" });
      events.push({ model: "b", minutesAgo: 30, status: "completed" });
      for (let i = 0; i < 4; i++) events.push({ model: "b", minutesAgo: 30, status: "failed", httpStatus: 500 });
      // A broken model (traffic, zero successes) still shows up: no top-N cut.
      for (let i = 0; i < 3; i++) events.push({ model: "c", minutesAgo: 30, status: "failed", httpStatus: 500 });
      await seedEvents(fx, events);
      const stats = await getPublicNetworkStats(fx.db, fx.tenantId);
      expect(stats.model_health_1h).toEqual([
        { model: "a", hits: 60, ok: 58 },
        { model: "b", hits: 5, ok: 1 },
        { model: "c", hits: 3, ok: 0 },
      ]);
      // Health carries no token/cost data — hits and ok only.
      expect(JSON.stringify(stats.model_health_1h)).not.toMatch(/tokens|cost/i);
    } finally {
      fx.cleanup();
    }
  });

  test("model_health_1h only includes buyer-template models", async () => {
    const fx = await fixture();
    try {
      await seedTemplate(fx, ["a"]);
      const events: SeedEvent[] = [];
      for (let i = 0; i < 6; i++) events.push({ model: "a", minutesAgo: 30, status: "completed" });
      for (let i = 0; i < 4; i++) events.push({ model: "infra-only-model", minutesAgo: 30, status: "completed" });
      await seedEvents(fx, events);
      const stats = await getPublicNetworkStats(fx.db, fx.tenantId);
      // Traffic from infra keys / playground on other models must not leak
      // onto the buyer-facing status page.
      expect(stats.model_health_1h).toEqual([{ model: "a", hits: 6, ok: 6 }]);
    } finally {
      fx.cleanup();
    }
  });
});
