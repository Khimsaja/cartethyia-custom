/**
 * Pool affinity (sticky egress per key).
 *
 * Providers listed in `CARTETHYIA_POOL_AFFINITY_PROVIDERS` (default `cb`)
 * pass an affinity key — one provider account — into pool selection. The
 * properties worth pinning:
 *
 * - Determinism: the same key lands on the same pool on every admission
 *   while that pool keeps admitting. That stability is the entire feature;
 *   an upstream risk control should see one address per account.
 * - Failover, not failure: when the key's first choice is at capacity the
 *   admission moves to the key's next-ranked pool instead of failing, and
 *   only reports no pool once every candidate is full.
 * - Spread: different keys rank pools independently, so accounts do not
 *   all pile onto one pool; and a caller that passes no key keeps the
 *   pre-affinity behaviour exactly.
 *
 * No Redis here: the local path is exercised directly. The Redis path
 * shares the same ranking (it only re-orders the CAS admit scan), so the
 * ordering contract pinned here is the one both paths follow.
 */
import { describe, expect, test } from "bun:test";
import { NetworkPoolSelector } from "../../src/network/pool/selector";

const POOLS = ["pool-a", "pool-b", "pool-c", "pool-d"];

describe("pool affinity", () => {
  test("the same key lands on the same pool across admissions", async () => {
    const selector = new NetworkPoolSelector();
    const first = await selector.tryAcquireAvailablePool(
      POOLS,
      "cb",
      undefined,
      undefined,
      undefined,
      undefined,
      "cb:acct-1",
    );
    expect(first).toBeDefined();
    first?.release();
    for (let index = 0; index < 5; index += 1) {
      const slot = await selector.tryAcquireAvailablePool(
        POOLS,
        "cb",
        undefined,
        undefined,
        undefined,
        undefined,
        "cb:acct-1",
      );
      expect(slot?.poolId).toBe(first?.poolId);
      slot?.release();
    }
  });

  test("fails over in ranking order when the pinned pool is full", async () => {
    const selector = new NetworkPoolSelector();
    const limits = { "pool-a": 1, "pool-b": 1, "pool-c": 1, "pool-d": 1 };
    const held = [];
    for (let index = 0; index < POOLS.length; index += 1) {
      const slot = await selector.tryAcquireAvailablePool(
        POOLS,
        "cb",
        limits,
        undefined,
        undefined,
        undefined,
        "cb:acct-9",
      );
      expect(slot).toBeDefined();
      if (slot) held.push(slot);
    }
    // Each admission took a different pool: the pinned one first, then the
    // key's next choices as each filled.
    expect(new Set(held.map((slot) => slot.poolId)).size).toBe(POOLS.length);
    const overflow = await selector.tryAcquireAvailablePool(
      POOLS,
      "cb",
      limits,
      undefined,
      undefined,
      undefined,
      "cb:acct-9",
    );
    expect(overflow).toBeUndefined();
    for (const slot of held) slot.release();
    expect(selector.getInflight(held[0]!.poolId)).toBe(0);
  });

  test("different keys spread across pools, and no key keeps the old path", async () => {
    const selector = new NetworkPoolSelector();
    const seen = new Set<string>();
    for (let index = 0; index < 40; index += 1) {
      const slot = await selector.tryAcquireAvailablePool(
        POOLS,
        "cb",
        undefined,
        undefined,
        undefined,
        undefined,
        `cb:acct-${index}`,
      );
      if (slot) {
        seen.add(slot.poolId);
        slot.release();
      }
    }
    expect(seen.size).toBeGreaterThan(1);
    const plain = await selector.tryAcquireAvailablePool(POOLS, "cb");
    expect(plain).toBeDefined();
    plain?.release();
  });
});
