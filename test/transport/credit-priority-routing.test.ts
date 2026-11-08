/**
 * Credit-priority routing: within the same rank group, accounts with remaining
 * pooled credit are ordered ahead of unknown-quota accounts. Free-tier models
 * skip the preference — a free model routes to any account. The rank
 * (fresh → slow → cooling → saturated) stays the primary sort key; credit only
 * breaks ties inside one rank. Quota is not an eligibility exclusion: known-zero
 * accounts stay routed and are only ordered after unknown/positive.
 */
import { expect, test } from "bun:test";
import { RoutingEngine } from "../../src/transport/routing/router";
import { sharedClaudeSlowLanes } from "../../src/providers/integrations/claude/claude-slow-lane";
import type { RouteCandidate, RouteSnapshot } from "../../src/transport/routing/route-model";
import type { ProviderQuotaWindow } from "../../src/providers/quota/quota-contracts";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";

function candidate(id: string, extra: Record<string, unknown> = {}): RouteCandidate {
  return {
    provider_id: "qoder",
    model_id: "qoder-model",
    wire_family: "chat",
    endpoint: "/v1/chat",
    capability_profile: {},
    provider_account_id: id,
    tenant_id: null,
    ...extra,
  } as unknown as RouteCandidate;
}

function creditWindow(remaining: number): ProviderQuotaWindow {
  return {
    kind: "credits",
    label: "credits",
    accounting: "pooled",
    usedPercent: null,
    remainingPercent: null,
    resetsAt: null,
    remaining,
    limit: null,
  };
}

function snapshot(candidates: readonly RouteCandidate[]): RouteSnapshot {
  return {
    revision: 1,
    candidates,
    aliases: {},
    combos: {},
    created_at: Date.now(),
  };
}

async function plannedOrder(snapshot: RouteSnapshot, requested: string): Promise<string[]> {
  const engine = new RoutingEngine();
  const plan = await engine.plan(requested, snapshot);
  if (plan.candidates.length === 0) return [];
  return plan.candidates.map((candidate) => candidate.provider_account_id ?? candidate.provider_id);
}

test("accounts with remaining credit are ordered before unknown-quota accounts", async () => {
  const order = await plannedOrder(
    snapshot([
      candidate("a-unknown"),
      candidate("a-credit", { quota_windows: [creditWindow(42)] }),
    ]),
    "qoder-model",
  );
  expect(order).toEqual(["a-credit", "a-unknown"]);
});

test("a known-zero credit account is ordered after unknown, never excluded", async () => {
  const order = await plannedOrder(
    snapshot([
      candidate("a-zero", { quota_windows: [creditWindow(0)] }),
      candidate("a-unknown"),
    ]),
    "qoder-model",
  );
  // Quota is not an eligibility exclusion anymore: the zero-credit account is
  // still routed, but credit priority puts the unknown (neutral) account first.
  expect(order).toEqual(["a-unknown", "a-zero"]);
});

test("a free-tier model routes even when its own quota window is exhausted", async () => {
  const order = await plannedOrder(
    snapshot([
      candidate("a-exhausted-free", { free_tier: true, quota_windows: [creditWindow(0)] }),
      candidate("a-unknown-free", { free_tier: true }),
    ]),
    "qoder-model",
  );
  // Exhausted windows no longer exclude; both accounts route, original order
  // preserved (free tier skips credit preference).
  expect(order).toEqual(["a-exhausted-free", "a-unknown-free"]);
});

test("a free-tier model ignores the operator floor threshold entirely", async () => {
  const order = await plannedOrder(
    snapshot([
      candidate("a-above-floor-free", { free_tier: true, quota_windows: [creditWindow(42)] }),
      candidate("a-exhausted-free", { free_tier: true, quota_windows: [creditWindow(0)] }),
    ]),
    "qoder-model",
  );
  // Neither account is excluded by quota; free tier skips credit preference, so
  // original order is preserved.
  expect(order).toEqual(["a-above-floor-free", "a-exhausted-free"]);
});

test("a free-tier model routes to any account (no credit preference)", async () => {
  const order = await plannedOrder(
    snapshot([
      candidate("a-unknown", { free_tier: true }),
      candidate("a-credit", { free_tier: true, quota_windows: [creditWindow(42)] }),
    ]),
    "qoder-model",
  );
  // Credit would put a-credit first; a free model keeps the original order.
  expect(order).toEqual(["a-unknown", "a-credit"]);
});

test("credit only breaks ties inside a rank; slow-lane still orders after fresh", async () => {
  const coolingId = "a-slow-credit";
  sharedClaudeSlowLanes.observe(coolingId, {
    offer: "treatment",
    status: "active",
    unifiedLimitClaim: false,
    overageInUse: false,
    unifiedResetAtSec: Math.floor(Date.now() / 1000) + 3600,
  });
  try {
    const order = await plannedOrder(
      snapshot([
        candidate(coolingId, { quota_windows: [creditWindow(99)] }),
        candidate("a-fresh-unknown"),
      ]),
      "qoder-model",
    );
    expect(order).toEqual(["a-fresh-unknown", coolingId]);
  } finally {
    // Observing with a fresh marker clears the lane state for the next test.
    sharedClaudeSlowLanes.observe(coolingId, {
      offer: "control",
      status: "active",
      unifiedLimitClaim: false,
      overageInUse: false,
      unifiedResetAtSec: Math.floor(Date.now() / 1000) + 3600,
    });
  }
});

interface FakeChain {
  from: (table: unknown) => FakeChain;
  where: (...args: unknown[]) => FakeChain;
  limit: (...args: unknown[]) => FakeChain;
  then: <T1 = readonly unknown[], T2 = never>(
    onfulfilled?: ((value: readonly unknown[]) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ) => PromiseLike<T1 | T2>;
}

/**
 * Regression test for the 2026-11-05 pool starvation: `plan()` evaluated
 * every matching candidate via unbounded `Promise.all`, and each candidate's
 * quota fallback issued its own `SELECT quota_snapshot ... WHERE id = $1`
 * whenever the quota cache missed — which was ~99% of accounts (Redis held
 * 44 `quota:v5:*` keys for ~5.7k routable accounts). One request therefore
 * fired hundreds of concurrent pool acquires; the 40-connection pool sat at
 * `waiting` 10k–41k, idle 0, ~75% of the time, and a 5-token probe took
 * 34.7 s. The batch preload must turn the whole evaluation into a single
 * batched SELECT, with identical ordering (no quota anywhere → input order).
 */
test("plan() batch-loads quota once for all candidates instead of one DB read per candidate", async () => {
  let selects = 0;
  const makeChain = (): FakeChain => {
    const chain: FakeChain = {
      from: () => chain,
      where: () => chain,
      limit: () => chain,
      then: (onfulfilled, onrejected) => Promise.resolve([]).then(onfulfilled, onrejected),
    };
    return chain;
  };
  const countingDb = {
    select: (_fields: unknown) => {
      selects += 1;
      return makeChain();
    },
  } as unknown as CartethyiaDatabase;
  const ids = Array.from({ length: 60 }, (_, i) => `a-${i}`);
  const engine = new RoutingEngine(undefined, undefined, countingDb);
  const plan = await engine.plan(
    "qoder-model",
    snapshot(ids.map((id) => candidate(id))),
  );
  expect(selects).toBe(1);
  expect(plan.candidates.map((entry) => entry.provider_account_id)).toEqual(ids);
});
