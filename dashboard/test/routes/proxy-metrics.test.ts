import { describe, expect, test } from "bun:test";
import type { NetworkPoolResponse } from "../../src/data/contracts";
import { formatBytes, sortPools, summarizePools } from "../../src/shared/proxy-metrics";

function pool(overrides: Partial<NetworkPoolResponse> = {}): NetworkPoolResponse {
  return {
    id: "p1",
    kind: "http",
    endpoint: "proxy-1",
    maxInflight: 10,
    status: "active",
    inflight: 0,
    consecutiveFailures: 0,
    tenantId: "tenant-1",
    ...overrides,
  } as NetworkPoolResponse;
}

describe("proxy pool overview metrics", () => {
  test("aggregates routable capacity and health split", () => {
    const pools = [
      pool({ id: "a", status: "active", maxInflight: 10, inflight: 4 }),
      pool({ id: "b", status: "active", maxInflight: 5, inflight: 1 }),
      pool({ id: "c", status: "cooldown", maxInflight: 8 }),
      pool({ id: "d", status: "cooldown", maxInflight: 4 }),
      pool({ id: "e", status: "disabled", maxInflight: 2 }),
    ];
    expect(summarizePools(pools)).toEqual({
      totalPools: 5,
      active: 2,
      cooldown: 2,
      totalMaxConcurrency: 15,
      usedInflight: 5,
      availableCapacity: 10,
      // Both active pools have a free slot; the cooldown pools are not counted.
      routablePools: 2,
      saturatedPools: 0,
      soonestCooldownMs: null,
      avgLatencyMs: null,
      measuredPools: 0,
    });
  });

  test("handles an empty pool list", () => {
    expect(summarizePools([])).toEqual({
      totalPools: 0,
      active: 0,
      cooldown: 0,
      totalMaxConcurrency: 0,
      usedInflight: 0,
      availableCapacity: 0,
      routablePools: 0,
      saturatedPools: 0,
      soonestCooldownMs: null,
      avgLatencyMs: null,
      measuredPools: 0,
    });
  });
});

describe("summarizePools with live usage", () => {
  test("live SSE rows override the polled inflight snapshot", () => {
    const pools = [
      pool({ id: "a", status: "active", maxInflight: 10, inflight: 1 }),
      pool({ id: "b", status: "active", maxInflight: 10, inflight: 1 }),
    ];
    const live = new Map([
      ["a", 7],
      ["b", 0],
    ]);
    expect(summarizePools(pools, live)).toEqual({
      totalPools: 2,
      active: 2,
      cooldown: 0,
      totalMaxConcurrency: 20,
      usedInflight: 7,
      availableCapacity: 13,
      routablePools: 2,
      saturatedPools: 0,
      soonestCooldownMs: null,
      avgLatencyMs: null,
      measuredPools: 0,
    });
  });

  test("a pool missing from the live map reads as zero", () => {
    const pools = [pool({ id: "a", status: "active", maxInflight: 10, inflight: 9 })];
    expect(summarizePools(pools, new Map()).usedInflight).toBe(0);
  });
});

describe("latency aggregate", () => {
  test("averages only the pools that have a measurement", () => {
    const pools = [
      pool({ id: "a", lastLatencyMs: 100 }),
      pool({ id: "b", lastLatencyMs: 300 }),
      // Never measured: excluded, not counted as zero.
      pool({ id: "c" }),
    ];
    const summary = summarizePools(pools);
    expect(summary.avgLatencyMs).toBe(200);
    expect(summary.measuredPools).toBe(2);
  });

  test("reports no average when nothing has been measured", () => {
    const summary = summarizePools([pool({ id: "a" }), pool({ id: "b" })]);
    expect(summary.avgLatencyMs).toBeNull();
    expect(summary.measuredPools).toBe(0);
  });

  test("ignores disabled pools, even measured ones", () => {
    const pools = [
      pool({ id: "a", status: "active", lastLatencyMs: 100 }),
      pool({ id: "b", status: "disabled", lastLatencyMs: 5000 }),
    ];
    const summary = summarizePools(pools);
    expect(summary.avgLatencyMs).toBe(100);
    expect(summary.measuredPools).toBe(1);
  });

  test("an unmeasured pool does not understate the average", () => {
    const measured = [pool({ id: "a", lastLatencyMs: 500 })];
    expect(summarizePools(measured).avgLatencyMs).toBe(500);
    const withUnmeasured = summarizePools([...measured, pool({ id: "b" })]);
    expect(withUnmeasured.avgLatencyMs).toBe(500);
    expect(withUnmeasured.measuredPools).toBe(1);
  });

  test("rounds the average to whole milliseconds", () => {
    const pools = [pool({ id: "a", lastLatencyMs: 100 }), pool({ id: "b", lastLatencyMs: 101 })];
    expect(summarizePools(pools).avgLatencyMs).toBe(101);
  });
});

describe("pool table sorting", () => {
  // The table reads latency the same way the row does: last-known measurement.
  const latency = (pool: NetworkPoolResponse): number | undefined => pool.lastLatencyMs;

  test("sorts by name in both directions without mutating the input", () => {
    const pools = [pool({ id: "b", label: "beta" }), pool({ id: "a", label: "alpha" })];
    const snapshot = pools.map((p) => p.id);
    expect(sortPools(pools, "name", "asc", latency).map((p) => p.id)).toEqual(["a", "b"]);
    expect(sortPools(pools, "name", "desc", latency).map((p) => p.id)).toEqual(["b", "a"]);
    expect(pools.map((p) => p.id)).toEqual(snapshot);
  });

  test("sorts by load numerically, not lexically", () => {
    const pools = [
      pool({ id: "slow", lastLatencyMs: 900 }),
      pool({ id: "fast", lastLatencyMs: 40 }),
      pool({ id: "mid", lastLatencyMs: 150 }),
    ];
    expect(sortPools(pools, "load", "asc", latency).map((p) => p.id)).toEqual([
      "fast",
      "mid",
      "slow",
    ]);
  });

  test("unprobed pools sort last in both directions", () => {
    const pools = [
      pool({ id: "unprobed" }),
      pool({ id: "measured", lastLatencyMs: 120 }),
      pool({ id: "other" }),
    ];
    expect(sortPools(pools, "load", "asc", latency).map((p) => p.id)).toEqual([
      "measured",
      "unprobed",
      "other",
    ]);
    expect(sortPools(pools, "load", "desc", latency).map((p) => p.id)).toEqual([
      "measured",
      "unprobed",
      "other",
    ]);
  });

  test("pools without an egress address sort last by address", () => {
    const pools = [
      pool({ id: "none" }),
      pool({ id: "b", egressIp: "203.0.113.9" }),
      pool({ id: "a", egressIp: "198.51.100.4" }),
    ];
    expect(sortPools(pools, "address", "asc", latency).map((p) => p.id)).toEqual([
      "a",
      "b",
      "none",
    ]);
  });

  test("falls back to the endpoint when a pool has no label", () => {
    const pools = [pool({ id: "b", endpoint: "zeta" }), pool({ id: "a", endpoint: "alpha" })];
    expect(sortPools(pools, "name", "asc", latency).map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("routable split and cooldown timing", () => {
  test("a saturated active pool is not routable", () => {
    const pools = [
      pool({ id: "a", status: "active", maxInflight: 10, inflight: 10 }),
      pool({ id: "b", status: "active", maxInflight: 10, inflight: 3 }),
    ];
    const summary = summarizePools(pools);
    expect(summary.routablePools).toBe(1);
    expect(summary.saturatedPools).toBe(1);
    expect(summary.availableCapacity).toBe(7);
  });

  test("live usage can saturate a pool the polled snapshot showed as free", () => {
    const pools = [pool({ id: "a", status: "active", maxInflight: 5, inflight: 0 })];
    expect(summarizePools(pools).saturatedPools).toBe(0);
    expect(summarizePools(pools, new Map([["a", 5]])).saturatedPools).toBe(1);
  });

  test("reports the nearest future cooldown across pools and providers", () => {
    const now = Date.now();
    const pools = [
      pool({
        id: "a",
        status: "cooldown",
        cooldownUntil: new Date(now + 60_000).toISOString(),
      }),
      pool({
        id: "b",
        status: "active",
        providerCooldowns: [
          { providerId: "p", until: new Date(now + 5_000).toISOString(), reason: "rate limit" },
        ],
      }),
    ];
    const summary = summarizePools(pools);
    expect(summary.cooldown).toBe(1);
    expect(summary.soonestCooldownMs).toBeGreaterThan(0);
    expect(summary.soonestCooldownMs).toBeLessThanOrEqual(5_000);
  });

  test("an expired or unparseable cooldown does not count as waiting", () => {
    const now = Date.now();
    const pools = [
      pool({ id: "a", status: "active", cooldownUntil: new Date(now - 1_000).toISOString() }),
      pool({ id: "b", status: "active", cooldownUntil: "not-a-date" }),
    ];
    expect(summarizePools(pools).soonestCooldownMs).toBeNull();
  });
});

describe("formatBytes", () => {
  test("prints whole bytes and kilobytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("2 KB");
  });

  test("keeps one decimal for small values in larger units", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5.5 * 1024 * 1024)).toBe("5.5 MB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
  });

  test("scales up to gigabytes and terabytes", () => {
    expect(formatBytes(2.5 * 1024 ** 3)).toBe("2.5 GB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
  });

  test("treats negative and non-finite input as zero", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});
