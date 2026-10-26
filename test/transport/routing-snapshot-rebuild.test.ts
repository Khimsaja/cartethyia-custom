/**
 * Route-catalog rebuilds must not stall request handling.
 *
 * Regression lock for the 2026-10-26 buyer connection-test timeouts: the
 * /v1/models 401 path stalled 2-16s during rebuilds because the snapshot
 * fan-out re-resolved per-(provider, tenant) pool/limit/agent data for
 * every candidate (measured: 137x slower fan-out at 50k candidates) and
 * ran the whole fan-out synchronously. The fan-out now memoizes those
 * resolutions per build and yields to the event loop every 8192
 * candidates, so a timer scheduled before a large build fires while the
 * build is still running — on the old sync fan-out it could not.
 *
 * The repository is exercised through createDatabaseSnapshotBuilder with
 * a fake query chain (no database): every .from() resolves canned rows,
 * .where()/.orderBy() are accepted and ignored, and the chain itself is
 * thenable so the Promise.all in the loader resolves it.
 */
import { describe, expect, test } from "bun:test";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import {
  cliToolMappings,
  cliToolSettings,
  consoleSettings,
  modelAliases,
  modelCombos,
  models,
  networkPools,
  poolRoutingSettings,
  providerAccounts,
  providerRoutingSettings,
  providers,
  tenantDisabledModels,
} from "../../src/persistence/schema";
import {
  createDatabaseSnapshotBuilder,
  memoizePair,
} from "../../src/transport/routing/route-catalog";

interface FakeChain {
  from: (table: unknown) => FakeChain;
  where: (...args: unknown[]) => FakeChain;
  orderBy: (...args: unknown[]) => FakeChain;
  then: <T1 = readonly unknown[], T2 = never>(
    onfulfilled?: ((value: readonly unknown[]) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ) => PromiseLike<T1 | T2>;
}

function fakeDb(rowsByTable: Map<unknown, readonly unknown[]>): CartethyiaDatabase {
  const makeChain = (): FakeChain => {
    let rows: readonly unknown[] = [];
    const chain: FakeChain = {
      from(table: unknown) {
        rows = rowsByTable.get(table) ?? [];
        return chain;
      },
      where() {
        return chain;
      },
      orderBy() {
        return chain;
      },
      then(onfulfilled, onrejected) {
        return Promise.resolve(rows).then(onfulfilled, onrejected);
      },
    };
    return chain;
  };
  return { select: (_fields: unknown) => makeChain() } as unknown as CartethyiaDatabase;
}

function cannedRows(accountCount: number): Map<unknown, readonly unknown[]> {
  const accounts = Array.from({ length: accountCount }, (_, i) => ({
    id: `acc-${i}`,
    providerId: "p1",
    tenantId: "t1",
    label: `acc-${i}`,
    status: "active",
    cooldownUntil: null,
    modelCooldowns: null,
    lastErrorCategory: null,
    quotaPlan: null,
  }));
  const modelRow = (providerId: string, modelId: string, enabled: boolean) => ({
    providerId,
    modelId,
    wireFamily: "openai",
    serviceKind: "llm",
    endpointPath: "/v1/chat/completions",
    modalities: null,
    outputLimit: null,
    reasoning: false,
    toolCall: false,
    enabled,
    proOnly: false,
    freeTier: false,
  });
  return new Map<unknown, readonly unknown[]>([
    [
      providers,
      [
        { id: "p1", tenantId: "t1", requiresAccount: true },
        { id: "p2", tenantId: "t1", requiresAccount: true },
      ],
    ],
    [models, [modelRow("p1", "m1", true), modelRow("p2", "m2", true), modelRow("p2", "m-dead", false)]],
    [providerAccounts, accounts],
    [modelAliases, []],
    [modelCombos, []],
    [providerRoutingSettings, []],
    [
      networkPools,
      [
        { id: "pool-1", tenantId: "t1", status: "active", maxInflight: 10, weight: 50 },
        { id: "pool-2", tenantId: "t1", status: "active", maxInflight: 20, weight: 50 },
        { id: "pool-off", tenantId: "t1", status: "disabled", maxInflight: 10, weight: 50 },
      ],
    ],
    [tenantDisabledModels, []],
    [cliToolMappings, []],
    [cliToolSettings, []],
    [poolRoutingSettings, []],
    [consoleSettings, []],
  ]);
}

describe("route-catalog rebuild", () => {
  test(
    "a large fan-out yields to the event loop and shares pool resolutions",
    async () => {
      const build = createDatabaseSnapshotBuilder(fakeDb(cannedRows(20_000)));
      let timerFired = false;
      setTimeout(() => {
        timerFired = true;
      }, 0);
      const snap = await build();
      expect(timerFired).toBe(true);
      expect(snap.candidates.length).toBe(20_001);

      const p1 = snap.candidates.filter((c) => c.provider_id === "p1");
      expect(p1.length).toBe(20_000);
      const [first, second] = p1;
      const last = p1[p1.length - 1];
      if (first === undefined || second === undefined || last === undefined) {
        throw new Error("expected p1 candidates");
      }
      expect(first.model_id).toBe("m1");
      expect(first.tenant_id).toBe("t1");
      // Memoization: every p1 candidate shares one pool resolution object.
      for (const c of [first, second, last]) {
        expect(c.network_pool_ids).toBe(first.network_pool_ids);
        expect(c.network_pool_limits).toBe(first.network_pool_limits);
        expect(c.network_pool_weights).toBe(first.network_pool_weights);
      }
      expect(first.network_pool_ids).toEqual(["pool-1", "pool-2"]);
      expect(first.network_pool_required).toBe(true);

      const p2 = snap.candidates.filter((c) => c.provider_id === "p2");
      expect(p2.length).toBe(1);
      const p2first = p2[0];
      if (p2first === undefined) {
        throw new Error("expected p2 candidate");
      }
      expect((p2first as unknown as { health_status?: string }).health_status).toBe("disabled");
      expect(snap.candidates.some((c) => c.model_id === "m-dead")).toBe(false);
    },
    30000,
  );
});

describe("memoizePair", () => {
  test("caches per pair, including undefined results", () => {
    let calls = 0;
    const fn = (providerId: string, tenantId: string | null): string | undefined => {
      calls += 1;
      return providerId === "x" ? undefined : `${providerId}:${tenantId ?? ""}`;
    };
    const m = memoizePair(fn);
    expect(m("x", "t1")).toBeUndefined();
    expect(m("x", "t1")).toBeUndefined();
    expect(calls).toBe(1);
    expect(m("a", "t1")).toBe("a:t1");
    expect(m("a", "t1")).toBe("a:t1");
    expect(m("a", "t2")).toBe("a:t2");
    expect(calls).toBe(3);
  });
});
