import { describe, expect, test } from "bun:test";
import { totalRemainingCredit, type ProviderQuotaWindow } from "../../../src/providers/quota/quota-contracts";

const window = (overrides: Partial<ProviderQuotaWindow>): ProviderQuotaWindow => ({
  kind: "credit",
  label: "Monthly",
  usedPercent: null,
  remainingPercent: null,
  resetsAt: null,
  ...overrides,
});

describe("totalRemainingCredit", () => {
  test("reads the stated remaining figure", () => {
    expect(totalRemainingCredit([window({ limit: 500, remaining: 120 })])).toBe(120);
  });

  test("derives remaining from used when the upstream omits it", () => {
    expect(totalRemainingCredit([window({ limit: 500, used: 470 })])).toBe(30);
  });

  test("derives remaining from usedPercent when only a percentage is reported", () => {
    expect(totalRemainingCredit([window({ limit: 500, usedPercent: 94 })])).toBe(30);
  });

  test("sums across credit windows — a spent sub-bucket is not the whole account", () => {
    // The buddy family reports a recurring allowance plus several bonus packs.
    // A spent bonus pack (0 remaining) must not read as "account has 0": the
    // total is what the Credit Pool card shows and what the floor compares.
    const result = totalRemainingCredit([
      window({ kind: "quota:monthly", limit: 100, used: 0 }),
      window({ kind: "bonus:1", limit: 250, used: 250 }),
      window({ kind: "bonus:2", limit: 30, used: 20.86 }),
      window({ kind: "bonus:3", limit: 30, used: 0 }),
    ]);
    // 100 + 0 + 9.14 + 30
    expect(result).toBeCloseTo(139.14, 2);
  });

  test("ignores rate-limit windows (no positive limit is not a credit)", () => {
    // A window without a positive limit is a rate limit or unbounded bucket —
    // folding it in would shrink the pool, so it contributes nothing.
    const result = totalRemainingCredit([
      window({ limit: null, remaining: 5 }),
      window({ limit: 0, remaining: 5 }),
      window({ limit: 500, remaining: 120 }),
    ]);
    expect(result).toBe(120);
  });

  test("returns null when no window reports credit", () => {
    expect(totalRemainingCredit([])).toBeNull();
    expect(totalRemainingCredit([window({ limit: null })])).toBeNull();
  });

  test("clamps an over-reported used figure to zero, never negative", () => {
    // One window overspent must not subtract from another window's credit.
    expect(totalRemainingCredit([window({ limit: 100, used: 250 })])).toBe(0);
    expect(
      totalRemainingCredit([
        window({ limit: 100, used: 250 }),
        window({ limit: 30, used: 0 }),
      ]),
    ).toBe(30);
  });

  test("never counts a window's remaining above its own limit", () => {
    // A stated `remaining` larger than `limit` is upstream noise; cap it so one
    // bad window cannot inflate the pool.
    expect(totalRemainingCredit([window({ limit: 100, remaining: 999 })])).toBe(100);
  });
});
