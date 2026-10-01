import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { getDb, type CartethyiaDatabase } from "../../../src/persistence/postgres";
import { telemetryEvents, tenants } from "../../../src/persistence/schema";
import { dbDescribe } from "../../helpers/db-gate";
import { createShareStatsPort } from "../../../src/console/share/share-stats";

/**
 * The family stats rollup answers the share page's top-models table, which now
 * carries an average throughput (tokens/sec) and time-to-first-byte per model.
 * Those averages must be taken over the rows that actually reported each metric:
 * a non-streaming request has no rate, and a request that never produced a first
 * byte has no TTFT, so a plain `avg` over all rows would drag a healthy model's
 * numbers down with unrelated ones.
 */
dbDescribe("share family stats — real DB", () => {
  let db: CartethyiaDatabase;
  const tenantId = randomUUID();
  const keyId = randomUUID();
  const otherTenantId = randomUUID();

  beforeAll(async () => {
    db = getDb();
    await db
      .insert(tenants)
      .values([
        { id: tenantId, name: `share-stats-${tenantId.slice(0, 8)}`, status: "active" },
        { id: otherTenantId, name: `share-stats-other-${otherTenantId.slice(0, 8)}`, status: "active" },
      ])
      .onConflictDoNothing();

    const now = new Date();
    const event = (over: {
      tenantId: string;
      apiKeyId: string;
      model: string;
      tokensPerSec: number | null;
      ttfbMs: number | null;
      inputTokens?: number;
      outputTokens?: number;
    }) => ({
      id: randomUUID(),
      tenantId: over.tenantId,
      requestId: randomUUID(),
      createdAt: now,
      requestedModel: over.model,
      providerId: "p",
      apiKeyId: over.apiKeyId,
      status: "completed" as const,
      inputTokens: over.inputTokens ?? 10,
      outputTokens: over.outputTokens ?? 5,
      tokensPerSec: over.tokensPerSec === null ? null : String(over.tokensPerSec),
      ttfbMs: over.ttfbMs,
    });
    await db.insert(telemetryEvents).values([
      // Two rows with a rate and a ttfb, one without either: the averages must
      // ignore the third row rather than counting it as zero.
      event({ tenantId, apiKeyId: keyId, model: "claude-sonnet", tokensPerSec: 40, ttfbMs: 800 }),
      event({ tenantId, apiKeyId: keyId, model: "claude-sonnet", tokensPerSec: 60, ttfbMs: 1200 }),
      event({ tenantId, apiKeyId: keyId, model: "claude-sonnet", tokensPerSec: null, ttfbMs: null }),
      // A different model, and a different tenant whose rows must not leak in.
      event({ tenantId, apiKeyId: keyId, model: "gpt-5", tokensPerSec: 10, ttfbMs: 300 }),
      // The same route logged under its provider-qualified spelling, plus the
      // bare name of a *qualified* grant — a refused probe that must not rank.
      event({ tenantId, apiKeyId: keyId, model: "openai/gpt-5", tokensPerSec: 20, ttfbMs: 400 }),
      event({ tenantId, apiKeyId: keyId, model: "deepseek-v4.1-flash", tokensPerSec: null, ttfbMs: null }),
      event({ tenantId: otherTenantId, apiKeyId: randomUUID(), model: "claude-sonnet", tokensPerSec: 999, ttfbMs: 1 }),
    ]);
  });

  afterAll(async () => {
    await db.delete(telemetryEvents).where(inArray(telemetryEvents.tenantId, [tenantId, otherTenantId]));
    await db.delete(tenants).where(inArray(tenants.id, [tenantId, otherTenantId]));
  });

  test("averages throughput and TTFT over the rows that reported each", async () => {
    const port = createShareStatsPort(db);
    const stats = await port.getFamilyStats(tenantId, [keyId], { total: 1, active: 1 });

    const sonnet = stats.models.find((m) => m.modelId === "claude-sonnet");
    expect(sonnet).toBeDefined();
    expect(sonnet?.requests).toBe(3);
    // (40 + 60) / 2 = 50, not (40 + 60 + 0) / 3 = 33.3.
    expect(sonnet?.avgTokensPerSec).toBe(50);
    // (800 + 1200) / 2 = 1000, not dragged toward zero by the null row.
    expect(sonnet?.avgTtfbMs).toBe(1000);

    const gpt = stats.models.find((m) => m.modelId === "gpt-5");
    expect(gpt?.avgTokensPerSec).toBe(10);
    expect(gpt?.avgTtfbMs).toBe(300);
  });

  test("a model whose rows reported nothing yields null metrics, not zero", async () => {
    const port = createShareStatsPort(db);
    const stats = await port.getFamilyStats(tenantId, [randomUUID()], { total: 0, active: 0 });
    // No keys in scope: no traffic at all.
    expect(stats.models).toEqual([]);
  });

  test("a bare grant ranks itself and any provider-qualified spelling of it", async () => {
    const port = createShareStatsPort(db);
    // The link grants `gpt-5` (bare). A refused request still wrote a row under
    // its requested name (`claude-sonnet`), which must not rank — otherwise the
    // top-models table advertises models the recipient can never use. A bare
    // grant also covers the qualified spelling of the same model.
    const stats = await port.getFamilyStats(tenantId, [keyId], { total: 1, active: 1 }, ["gpt-5"]);
    expect(stats.models.map((m) => m.modelId).sort()).toEqual(["gpt-5", "openai/gpt-5"]);
    expect(stats.models.find((m) => m.modelId === "claude-sonnet")).toBeUndefined();
  });

  test("a qualified grant ranks only itself, not the bare name it ends with", async () => {
    const port = createShareStatsPort(db);
    // The grant is `openai/gpt-5`. The bare `gpt-5` row is a *different*,
    // refused request (a qualified entry does not authorize the bare name), so
    // it must not rank — only the exact qualified spelling does.
    const stats = await port.getFamilyStats(tenantId, [keyId], { total: 1, active: 1 }, ["openai/gpt-5"]);
    expect(stats.models.map((m) => m.modelId)).toEqual(["openai/gpt-5"]);
    expect(stats.models.find((m) => m.modelId === "gpt-5")).toBeUndefined();
  });

  test("a bare grant ending a qualified grant's bare name still excludes refused probes", async () => {
    const port = createShareStatsPort(db);
    // Grants `deepseek-v4.1-flash` qualified. The bare row is a refused probe.
    const stats = await port.getFamilyStats(tenantId, [keyId], { total: 1, active: 1 }, [
      "opencode-go/deepseek-v4.1-flash",
    ]);
    expect(stats.models).toEqual([]);
  });

  test("an unrestricted link (no allowed list) ranks every model", async () => {
    const port = createShareStatsPort(db);
    const stats = await port.getFamilyStats(tenantId, [keyId], { total: 1, active: 1 });
    expect(stats.models.map((m) => m.modelId).sort()).toEqual([
      "claude-sonnet",
      "deepseek-v4.1-flash",
      "gpt-5",
      "openai/gpt-5",
    ]);
  });

  test("an empty allowed list ranks nothing", async () => {
    const port = createShareStatsPort(db);
    const stats = await port.getFamilyStats(tenantId, [keyId], { total: 1, active: 1 }, []);
    expect(stats.models).toEqual([]);
  });
});
