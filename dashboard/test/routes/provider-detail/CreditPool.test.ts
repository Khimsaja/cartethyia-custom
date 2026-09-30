import { describe, expect, test } from "bun:test";
import { aggregateCreditPool } from "../../../src/routes/provider-detail/CreditPool";
import type { QuotaEntry, QuotaWindow } from "../../../src/hooks/quota";

/** Minimal QuotaEntry carrying only what the aggregation reads. */
function entry(id: string, windows: readonly QuotaWindow[], provider = "workbuddy"): QuotaEntry {
  return {
    id,
    provider,
    name: id,
    credentialHint: "",
    active: true,
    quota: {
      source: "billing",
      status: "ready",
      plan: null,
      windows: [...windows],
      fetchedAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      error: null,
    },
    health: null,
    providerName: provider,
    providerIcon: provider,
  } as QuotaEntry;
}

function window(overrides: Partial<QuotaWindow>): QuotaWindow {
  return {
    label: "Daily",
    remainingPercent: null,
    resetsAt: null,
    ...overrides,
  };
}

describe("aggregateCreditPool", () => {
  test("sums used and limit across every account and window", () => {
    const pool = aggregateCreditPool([
      entry("a", [window({ limit: 1000, used: 250 }), window({ label: "Weekly", limit: 5000, used: 1000 })]),
      entry("b", [window({ limit: 1000, used: 750 })]),
    ]);
    expect(pool).toEqual({ used: 2000, limit: 7000, accounts: 2 });
  });

  test("falls back to usedPercent when the absolute used figure is absent", () => {
    const pool = aggregateCreditPool([
      entry("a", [window({ limit: 2000, usedPercent: 25 })]),
    ]);
    expect(pool?.used).toBe(500);
    expect(pool?.limit).toBe(2000);
  });

  test("falls back to remaining when neither used nor a percentage is reported", () => {
    const pool = aggregateCreditPool([
      entry("a", [window({ limit: 2000, remaining: 1500 })]),
    ]);
    expect(pool?.used).toBe(500);
  });

  test("ignores windows without a positive limit (rate limits are not credits)", () => {
    const pool = aggregateCreditPool([
      entry("a", [window({ limit: null, used: 999 }), window({ limit: 0, used: 5 })]),
      entry("b", [window({ limit: 400, used: 100 })]),
    ]);
    expect(pool).toEqual({ used: 100, limit: 400, accounts: 1 });
  });

  test("clamps a window's used figure so one over-report cannot inflate the pool", () => {
    const pool = aggregateCreditPool([entry("a", [window({ limit: 100, used: 500 })])]);
    expect(pool?.used).toBe(100);
    expect(pool?.limit).toBe(100);
  });

  test("returns null when no account reports a credit window", () => {
    expect(aggregateCreditPool([])).toBeNull();
    expect(aggregateCreditPool([entry("a", [window({ limit: null, used: 10 })])])).toBeNull();
    // A provider whose only accounts carry no quota at all opts out too.
    const noQuota = { ...entry("a", []), quota: null } as QuotaEntry;
    expect(aggregateCreditPool([noQuota])).toBeNull();
  });

  test("counts only the accounts that actually contributed", () => {
    const pool = aggregateCreditPool([
      entry("a", [window({ limit: 100, used: 10 })]),
      entry("b", [window({ limit: null, used: 10 })]),
      entry("c", []),
    ]);
    expect(pool?.accounts).toBe(1);
  });
});
