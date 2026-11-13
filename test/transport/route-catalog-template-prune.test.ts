/**
 * Global route catalog (template-only pruning disabled).
 *
 * The snapshot keeps candidates for every enabled model row, regardless of
 * whether a model template names it. Template-only pruning used to drop
 * non-template models from the snapshot, which made them unroutable even
 * with an enabled catalog row and a live account (e.g.
 * deepai/deepseek-v4.1-flash). The heap-leak root cause was the Bun
 * --cpu-prof flag, not catalog size, so the operator disabled the prune
 * (2026-11-13): the catalog is global again.
 *
 * These tests pin that behavior: templates, aliases and combos no longer
 * restrict which models get candidates.
 */
import { describe, expect, test } from "bun:test";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import {
  cliToolMappings,
  cliToolSettings,
  consoleSettings,
  modelAliases,
  modelCombos,
  modelTemplates,
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

function baseRows(overrides: {
  models: readonly unknown[];
  aliases?: readonly unknown[];
  combos?: readonly unknown[];
  templates?: readonly unknown[];
}): Map<unknown, readonly unknown[]> {
  const providerIds = new Set(
    (overrides.models as { providerId: string }[]).map((row) => row.providerId),
  );
  return new Map<unknown, readonly unknown[]>([
    [
      providers,
      [...providerIds].map((id) => ({ id, tenantId: null, requiresAccount: true })),
    ],
    [models, overrides.models],
    [
      providerAccounts,
      [...providerIds].map((id) => accountRow(`acc-${id}`, id)),
    ],
    [modelAliases, overrides.aliases ?? []],
    [modelCombos, overrides.combos ?? []],
    [modelTemplates, overrides.templates ?? []],
    [providerRoutingSettings, []],
    [networkPools, []],
    [tenantDisabledModels, []],
    [cliToolMappings, []],
    [cliToolSettings, []],
    [poolRoutingSettings, []],
    [consoleSettings, []],
  ]);
}

function candidatePairs(snap: { candidates: readonly { provider_id: string; model_id: string }[] }): string[] {
  return snap.candidates.map((c) => `${c.provider_id}/${c.model_id}`).sort();
}

describe("route-catalog global catalog (template prune disabled)", () => {
  test("keeps every model even when templates name a subset", async () => {
    const build = createDatabaseSnapshotBuilder(
      fakeDb(
        baseRows({
          models: [
            modelRow("p1", "m-a"),
            modelRow("p1", "m-b"),
            modelRow("p1", "m-junk"),
            modelRow("p2", "m-c"),
            modelRow("p2", "m-junk"),
          ],
          aliases: [{ tenantId: "t1", alias: "fast", targetModel: "p1/m-a" }],
          combos: [
            { tenantId: "t1", name: "duo", members: ["p1/m-a", "p2/m-c"], strategy: "fallback" },
          ],
          templates: [{ tenantId: "t1", models: ["duo", "p1/m-b"] }],
        }),
      ),
    );
    const snap = await build();
    expect(candidatePairs(snap)).toEqual(["p1/m-a", "p1/m-b", "p1/m-junk", "p2/m-c", "p2/m-junk"]);
  });

  test("alias chains do not restrict the catalog", async () => {
    const build = createDatabaseSnapshotBuilder(
      fakeDb(
        baseRows({
          models: [modelRow("p1", "m-a"), modelRow("p1", "m-junk")],
          aliases: [
            { tenantId: "t1", alias: "quick", targetModel: "fast" },
            { tenantId: "t1", alias: "fast", targetModel: "p1/m-a" },
          ],
          templates: [{ tenantId: "t1", models: ["quick"] }],
        }),
      ),
    );
    const snap = await build();
    expect(candidatePairs(snap)).toEqual(["p1/m-a", "p1/m-junk"]);
  });

  test("bare template model does not restrict other models", async () => {
    const build = createDatabaseSnapshotBuilder(
      fakeDb(
        baseRows({
          models: [modelRow("p1", "shared"), modelRow("p2", "shared"), modelRow("p1", "other")],
          templates: [{ tenantId: "t1", models: ["shared"] }],
        }),
      ),
    );
    const snap = await build();
    expect(candidatePairs(snap)).toEqual(["p1/other", "p1/shared", "p2/shared"]);
  });

  test("qualified pair with no catalog row keeps every row", async () => {
    const build = createDatabaseSnapshotBuilder(
      fakeDb(
        baseRows({
          models: [modelRow("trae", "other"), modelRow("trae", "unused")],
          templates: [{ tenantId: "t1", models: ["trae/kimi-k2.5"] }],
        }),
      ),
    );
    const snap = await build();
    expect(candidatePairs(snap)).toEqual(["trae/other", "trae/unused"]);
  });

  test("no templates keeps the full catalog", async () => {
    const build = createDatabaseSnapshotBuilder(
      fakeDb(
        baseRows({
          models: [modelRow("p1", "m-a"), modelRow("p1", "m-b"), modelRow("p2", "m-c")],
          templates: [],
        }),
      ),
    );
    const snap = await build();
    expect(candidatePairs(snap)).toEqual(["p1/m-a", "p1/m-b", "p2/m-c"]);
  });
});
