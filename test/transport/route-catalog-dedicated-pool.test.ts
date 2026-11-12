/**
 * Exclusive proxy-pool assignment (`network_pools.dedicated_provider_id`).
 *
 * A pool with a dedicated provider serves ONLY that provider, and that
 * provider stops using shared pools. A provider without an assignment keeps
 * exactly the shared pools, so the filter is a no-op until the first
 * assignment exists. The snapshot is exercised through
 * `createDatabaseSnapshotBuilder` with a fake query chain (no database),
 * mirroring `routing-snapshot-rebuild.test.ts`.
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
import { createDatabaseSnapshotBuilder } from "../../src/transport/routing/route-catalog";

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

const modelRow = (providerId: string, modelId: string) => ({
  providerId,
  modelId,
  wireFamily: "openai",
  serviceKind: "llm",
  endpointPath: "/v1/chat/completions",
  modalities: null,
  outputLimit: null,
  reasoning: false,
  toolCall: false,
  enabled: true,
  proOnly: false,
  freeTier: false,
});

const accountRow = (id: string, providerId: string) => ({
  id,
  providerId,
  tenantId: "t1",
  label: id,
  status: "active",
  cooldownUntil: null,
  modelCooldowns: null,
  lastErrorCategory: null,
  quotaPlan: null,
});

function dedicatedRows(): Map<unknown, readonly unknown[]> {
  return new Map<unknown, readonly unknown[]>([
    [
      providers,
      [
        { id: "cb", tenantId: null, requiresAccount: true },
        { id: "dh", tenantId: "t1", requiresAccount: true },
      ],
    ],
    [
      models,
      [modelRow("cb", "m-cb"), modelRow("dh", "m-dh")],
    ],
    [providerAccounts, [accountRow("acc-cb", "cb"), accountRow("acc-dh", "dh")]],
    [modelAliases, []],
    [modelCombos, []],
    [providerRoutingSettings, []],
    [
      networkPools,
      [
        { id: "shared-1", tenantId: "t1", status: "active", maxInflight: 10, weight: 100 },
        { id: "shared-2", tenantId: "t1", status: "active", maxInflight: 10, weight: 100 },
        {
          id: "cb-only",
          tenantId: "t1",
          status: "active",
          maxInflight: 10,
          weight: 100,
          dedicatedProviderId: "cb",
        },
        {
          id: "cb-off",
          tenantId: "t1",
          status: "disabled",
          maxInflight: 10,
          weight: 100,
          dedicatedProviderId: "cb",
        },
      ],
    ],
    [tenantDisabledModels, []],
    [cliToolMappings, []],
    [cliToolSettings, []],
    [poolRoutingSettings, []],
    [consoleSettings, []],
  ]);
}

describe("route-catalog dedicated pools", () => {
  test("a provider with dedicated pools uses only those; others keep shared pools", async () => {
    const build = createDatabaseSnapshotBuilder(fakeDb(dedicatedRows()));
    const snap = await build();

    const cb = snap.candidates.filter((c) => c.provider_id === "cb");
    expect(cb.length).toBe(1);
    const cbFirst = cb[0];
    if (cbFirst === undefined) throw new Error("expected a cb candidate");
    // Shared pools are excluded, and the disabled dedicated pool is not active.
    expect(cbFirst.network_pool_ids).toEqual(["cb-only"]);
    expect(cbFirst.network_pool_required).toBe(true);

    const dh = snap.candidates.filter((c) => c.provider_id === "dh");
    expect(dh.length).toBe(1);
    const dhFirst = dh[0];
    if (dhFirst === undefined) throw new Error("expected a dh candidate");
    // The cb-dedicated pool never serves the shared group.
    expect(dhFirst.network_pool_ids).toEqual(["shared-1", "shared-2"]);
    expect(dhFirst.network_pool_required).toBe(true);
  });
});
