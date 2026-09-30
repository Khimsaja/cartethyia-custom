import { describe, expect, test } from "bun:test";
import { parseEgressIp } from "../../../../src/console/routing/pools/probe-result";
import {
  createNetworkPoolOperations,
  createNetworkPoolRoutes,
  sanitizePoolResponse,
  validateTransportConfig,
  DEFAULT_POOL_STRATEGY,
  type NetworkPoolRecord,
  type NetworkPoolStore,
  type PoolStrategySetting,
} from "../../../../src/console/routing/pools/contracts";
import { ConsoleDomainError } from "../../../../src/console/shared/errors";
import type { AccessDecision } from "../../../../src/security/access-control";

describe("parseEgressIp", () => {
  const trace = [
    "fl=123abc",
    "h=www.cloudflare.com",
    "ip=203.0.113.42",
    "ts=1700000000.000",
    "warp=off",
  ].join("\n");

  test("reads the address out of a trace response", () => {
    expect(parseEgressIp(trace)).toBe("203.0.113.42");
  });

  test("accepts an IPv6 address", () => {
    expect(parseEgressIp("ip=2001:db8::1\nwarp=off")).toBe("2001:db8::1");
  });

  test("does not match a key that merely ends in ip", () => {
    expect(parseEgressIp("clientip=198.51.100.7")).toBeUndefined();
  });

  test("returns undefined for a body that is not a trace response", () => {
    expect(parseEgressIp("")).toBeUndefined();
    expect(parseEgressIp("<html>nope</html>")).toBeUndefined();
  });

  test("rejects a non-address value", () => {
    expect(parseEgressIp("ip=not-an-address")).toBeUndefined();
  });
});

describe("network.test.ts", () => {
const access: AccessDecision = {
  id: "key-1",
  tenantId: "tenant-1",
  scopes: ["dashboard:read", "dashboard:write"],
    admissionIdentity: "key-1",
};

function makeStore(): { store: NetworkPoolStore; created: NetworkPoolRecord[] } {
  const created: NetworkPoolRecord[] = [];
  let strategy: PoolStrategySetting = DEFAULT_POOL_STRATEGY;
  const store: NetworkPoolStore = {
    async list() {
      return created;
    },
    async get(_tenantId, poolId) {
      return created.find((r) => r.id === poolId);
    },
    async create(record) {
      created.push(record);
    },
    async update(_tenantId, poolId, patch) {
      const index = created.findIndex((r) => r.id === poolId);
      if (index === -1) return undefined;
      const updated = { ...created[index]!, ...patch };
      created[index] = updated;
      return updated;
    },
    async delete(_tenantId, poolId) {
      const index = created.findIndex((r) => r.id === poolId);
      if (index === -1) return false;
      created.splice(index, 1);
      return true;
    },
    async healthCheck(_tenantId, poolId) {
      return { poolId, status: "healthy" };
    },
    async listHealthEvents() {
      return [];
    },
    async recover() {
      return true;
    },
    async getStrategy() {
      return strategy;
    },
    async setStrategy(_tenantId, setting) {
      strategy = setting;
      return setting;
    },
  };
  return { store, created };
}

describe("network pool domain contract", () => {
  test("createPool forwards credential and config to the store instead of dropping them", async () => {
    const { store, created } = makeStore();
    const factory = createNetworkPoolOperations({ store, accessResolver: () => access });
    const response = await factory.createPool(access, {
      kind: "http",
      endpoint: "https://proxy.example.com:8080",
      credential: "super-secret-token",
      config: { timeout: 5000 },
    });

    expect(created).toHaveLength(1);
    expect(created[0]?.credential).toBe("super-secret-token");
    expect(created[0]?.config).toEqual({ timeout: 5000 });
    // The response never echoes the raw credential back.
    expect(response).not.toHaveProperty("credential");
  });

  test("updatePool and deletePool release the cached dial agent for the pool", async () => {
    const { store } = makeStore();
    const released: Array<{ poolId: string; tenantId: string }> = [];
    const poolAgentReleaser = {
      async releasePool(poolId: string, tenantId: string) {
        released.push({ poolId, tenantId });
      },
    };
    const factory = createNetworkPoolOperations({
      store,
      accessResolver: () => access,
      poolAgentReleaser,
    });
    const created = await factory.createPool(access, {
      kind: "http",
      endpoint: "https://proxy.example.com:8080",
    });
    if (access.tenantId === null) throw new Error("test access must be tenant-bound");
    const tenantId = access.tenantId;
    await factory.updatePool(access, created.id, { weight: 50 });
    expect(released).toEqual([{ poolId: created.id, tenantId }]);
    await factory.deletePool(access, created.id);
    expect(released).toEqual([
      { poolId: created.id, tenantId },
      { poolId: created.id, tenantId },
    ]);
  });
  test("updateStrategy persists a valid round robin setting and invalidates the snapshot", async () => {
    const { store } = makeStore();
    const invalidated: unknown[] = [];
    const factory = createNetworkPoolOperations({
      store,
      accessResolver: () => access,
      snapshotInvalidator: { async invalidate() { invalidated.push(true); return 1; } },
    });
    const saved = await factory.updateStrategy(access, { strategy: "round_robin", rotateCount: 3 });
    expect(saved).toEqual({ strategy: "round_robin", rotateCount: 3 });
    expect(invalidated).toHaveLength(1);
  });

  test("updateStrategy rejects an unknown strategy without touching the store", async () => {
    const { store } = makeStore();
    const factory = createNetworkPoolOperations({ store, accessResolver: () => access });
    await expect(
      factory.updateStrategy(access, { strategy: "mystery" as "least_loaded" }),
    ).rejects.toMatchObject({ code: "invalid_pool" });
    expect(await factory.getStrategy(access)).toEqual(DEFAULT_POOL_STRATEGY);
  });

  test("updateStrategy rejects an out-of-range rotateCount", async () => {
    const { store } = makeStore();
    const factory = createNetworkPoolOperations({ store, accessResolver: () => access });
    await expect(factory.updateStrategy(access, { rotateCount: 0 })).rejects.toMatchObject({
      code: "invalid_pool_limits",
    });
    await expect(factory.updateStrategy(access, { rotateCount: 1001 })).rejects.toMatchObject({
      code: "invalid_pool_limits",
    });
  });


  test("sanitizePoolResponse exposes hasCredential and config but never the secret", () => {
    const response = sanitizePoolResponse({
      id: "pool-1",
      kind: "http",
      endpoint: "https://proxy.example.com",
      weight: 1,
      maxInflight: 100,
      status: "active",
      inflight: 0,
      consecutiveFailures: 0,
      tenantId: "tenant-1",
      config: { timeout: 3000 },
      hasCredential: true,
      credential: "leaked-secret",
    });
    expect(response.config).toEqual({ timeout: 3000 });
    expect(response.hasCredential).toBe(true);
    expect(response).not.toHaveProperty("credential");
  });

  test("sanitizePoolResponse carries a positive quota and drops a useless one", () => {
    const base = {
      id: "pool-1",
      kind: "http" as const,
      endpoint: "https://proxy.example.com",
      weight: 1,
      maxInflight: 100,
      status: "active" as const,
      inflight: 0,
      consecutiveFailures: 0,
      tenantId: "tenant-1",
      hasCredential: false,
    };
    expect(sanitizePoolResponse({ ...base, quotaBytes: 5_000_000 }).quotaBytes).toBe(5_000_000);
    // Zero and negatives are not a quota, and absent means unmetered.
    expect(sanitizePoolResponse({ ...base, quotaBytes: 0 })).not.toHaveProperty("quotaBytes");
    expect(sanitizePoolResponse({ ...base, quotaBytes: -1 })).not.toHaveProperty("quotaBytes");
    expect(sanitizePoolResponse(base)).not.toHaveProperty("quotaBytes");
  });

  test("createPool persists a quota and leaves it unset when omitted", async () => {
    const { store, created } = makeStore();
    const factory = createNetworkPoolOperations({ store, accessResolver: () => access });
    await factory.createPool(access, {
      kind: "http",
      endpoint: "http://proxy.example.com:8080",
      quotaBytes: 3_000_000_000,
    });
    expect(created[0]?.quotaBytes).toBe(3_000_000_000);
    await factory.createPool(access, { kind: "http", endpoint: "http://proxy2.example.com:8080" });
    expect(created[1]).not.toHaveProperty("quotaBytes");
  });

  test("updatePool clears a quota with an explicit null", async () => {
    const { store } = makeStore();
    const factory = createNetworkPoolOperations({ store, accessResolver: () => access });
    const pool = await factory.createPool(access, {
      kind: "http",
      endpoint: "http://proxy.example.com:8080",
      quotaBytes: 5_000,
    });
    const cleared = await factory.updatePool(access, pool.id, { quotaBytes: null });
    expect(cleared).not.toHaveProperty("quotaBytes");
  });

  test("createPool rejects a literal private IPv4 endpoint as SSRF", async () => {
    const { store } = makeStore();
    const factory = createNetworkPoolOperations({ store, accessResolver: () => access });
    await expect(
      factory.createPool(access, { kind: "http", endpoint: "http://192.168.1.10:8080" }),
    ).rejects.toBeInstanceOf(ConsoleDomainError);
  });

  test("createPool rejects a loopback literal IP endpoint", async () => {
    const { store } = makeStore();
    const factory = createNetworkPoolOperations({ store, accessResolver: () => access });
    await expect(
      factory.createPool(access, { kind: "http", endpoint: "http://127.0.0.1:9000" }),
    ).rejects.toBeInstanceOf(ConsoleDomainError);
  });

  test("createPool accepts a bare host:port socks5 endpoint", async () => {
    const { store } = makeStore();
    const factory = createNetworkPoolOperations({ store, accessResolver: () => access });
    const pool = await factory.createPool(access, {
      kind: "socks5",
      endpoint: "proxy.example:1080",
    });
    expect(pool.endpoint).toBe("proxy.example:1080");
  });

  test("createPool rejects a private-IP socks5 endpoint as SSRF", async () => {
    const { store } = makeStore();
    const factory = createNetworkPoolOperations({ store, accessResolver: () => access });
    await expect(
      factory.createPool(access, { kind: "socks5", endpoint: "10.0.0.5:1080" }),
    ).rejects.toBeInstanceOf(ConsoleDomainError);
  });
  test("updatePool re-validates endpoint against the pool's existing kind when kind is omitted", async () => {
    const { store } = makeStore();
    const factory = createNetworkPoolOperations({ store, accessResolver: () => access });
    const created = await factory.createPool(access, {
      kind: "socks5",
      endpoint: "proxy.example:1080",
    });
    await expect(
      factory.updatePool(access, created.id, { endpoint: "http://not-a-socks-authority" }),
    ).rejects.toBeInstanceOf(ConsoleDomainError);
  });
});

describe("network pool routes — real Elysia schema validation", () => {
  test("rejects a POST body missing the required endpoint field with 422, never reaching the store", async () => {
    const { store, created } = makeStore();
    const app = createNetworkPoolRoutes({ store, accessResolver: () => access });
    const response = await app.handle(
      new Request("http://localhost/network/pools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "http" }),
      }),
    );
    expect(response.status).toBe(422);
    expect(created).toHaveLength(0);
  });

  test("rejects an invalid kind literal before reaching the domain layer", async () => {
    const { store, created } = makeStore();
    const app = createNetworkPoolRoutes({ store, accessResolver: () => access });
    const response = await app.handle(
      new Request("http://localhost/network/pools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "ftp", endpoint: "ftp.example.com:21" }),
      }),
    );
    expect(response.status).toBe(422);
    expect(created).toHaveLength(0);
  });

  test("rejects a non-object body", async () => {
    const { store, created } = makeStore();
    const app = createNetworkPoolRoutes({ store, accessResolver: () => access });
    const response = await app.handle(
      new Request("http://localhost/network/pools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify("not an object"),
      }),
    );
    expect(response.status).toBe(422);
    expect(created).toHaveLength(0);
  });

  test("accepts a well-formed body and reaches the real store", async () => {
    const { store, created } = makeStore();
    const app = createNetworkPoolRoutes({ store, accessResolver: () => access });
    const response = await app.handle(
      new Request("http://localhost/network/pools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "http", endpoint: "https://proxy.example.com:8080" }),
      }),
    );
    expect(response.status).toBe(201);
    expect(created).toHaveLength(1);
  });

  test("batch probe returns one verdict per target and never saves a pool", async () => {
    const { store, created } = makeStore();
    let inFlight = 0;
    let peak = 0;
    store.probeAdHoc = async (_tenantId, request) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { poolId: request.endpoint, status: "healthy", latencyMs: 12 };
    };
    const app = createNetworkPoolRoutes({ store, accessResolver: () => access });
    const targets = Array.from({ length: 25 }, (_, i) => ({
      kind: "http",
      endpoint: `proxy-${i}.example.com:8080`,
    }));
    const response = await app.handle(
      new Request("http://localhost/network/pools/test-batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targets }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ endpoint: string; result: { status: string } }>;
    expect(body).toHaveLength(25);
    // Order matches the request so the dashboard can line results up by row.
    expect(body[0]?.endpoint).toBe("proxy-0.example.com:8080");
    expect(body[24]?.endpoint).toBe("proxy-24.example.com:8080");
    expect(body.every((r) => r.result.status === "healthy")).toBe(true);
    // Dials are bounded, not one socket per target at once.
    expect(peak).toBeLessThanOrEqual(10);
    // Probing never persists anything.
    expect(created).toHaveLength(0);
  });

  test("a single failing probe does not fail the batch", async () => {
    const { store } = makeStore();
    store.probeAdHoc = async (_tenantId, request) => {
      if (request.endpoint.startsWith("bad")) throw new Error("dial refused");
      return { poolId: request.endpoint, status: "healthy" };
    };
    const app = createNetworkPoolRoutes({ store, accessResolver: () => access });
    const response = await app.handle(
      new Request("http://localhost/network/pools/test-batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targets: [
            { kind: "http", endpoint: "ok.example.com:8080" },
            { kind: "http", endpoint: "bad.example.com:8080" },
          ],
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ endpoint: string; result: { status: string; errorMessage?: string } }>;
    expect(body[0]?.result.status).toBe("healthy");
    expect(body[1]?.result.status).toBe("unhealthy");
    expect(body[1]?.result.errorMessage).toContain("dial refused");
  });

  test("rejects a batch above the 100-target cap", async () => {
    const { store } = makeStore();
    const app = createNetworkPoolRoutes({ store, accessResolver: () => access });
    const targets = Array.from({ length: 101 }, (_, i) => ({
      kind: "http",
      endpoint: `proxy-${i}.example.com:8080`,
    }));
    const response = await app.handle(
      new Request("http://localhost/network/pools/test-batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targets }),
      }),
    );
    expect(response.status).toBe(422);
  });
});
});

describe("validateTransportConfig", () => {
  test("accepts valid per-kind configs", () => {
    expect(validateTransportConfig("http", { timeout: 5000 })).toBeUndefined();
    expect(validateTransportConfig("https", {})).toBeUndefined();
    expect(validateTransportConfig("socks5", { anything: true })).toBeUndefined();
  });

  test("rejects a non-numeric HTTP timeout", () => {
    expect(() => validateTransportConfig("http", { timeout: "fast" })).toThrow(
      expect.objectContaining({ code: "invalid_config" }),
    );
  });

  test("rejects an unknown transport kind", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      validateTransportConfig("grpc" as any, {}),
    ).toThrow(expect.objectContaining({ code: "invalid_config" }));
  });
});

describe("pool operations — CRUD paths (coverage)", () => {
  const opsAccess: AccessDecision = {
    id: "key-1",
    tenantId: "tenant-1",
    scopes: ["dashboard:read", "dashboard:write"],
    admissionIdentity: "key-1",
  };

  function opsStore(): { store: NetworkPoolStore; created: NetworkPoolRecord[] } {
    const created: NetworkPoolRecord[] = [];
    let strategy: PoolStrategySetting = DEFAULT_POOL_STRATEGY;
    const store: NetworkPoolStore = {
      async list() {
        return created;
      },
      async get(_tenantId, poolId) {
        return created.find((r) => r.id === poolId);
      },
      async create(record) {
        created.push(record);
      },
      async update(_tenantId, poolId, patch) {
        const index = created.findIndex((r) => r.id === poolId);
        if (index === -1) return undefined;
        const updated = { ...created[index]!, ...patch };
        created[index] = updated;
        return updated;
      },
      async delete(_tenantId, poolId) {
        const index = created.findIndex((r) => r.id === poolId);
        if (index === -1) return false;
        created.splice(index, 1);
        return true;
      },
      async healthCheck(_tenantId, poolId) {
        return { poolId, status: "healthy" };
      },
      async listHealthEvents() {
        return [];
      },
      async recover() {
        return true;
      },
      async getStrategy() {
        return strategy;
      },
      async setStrategy(_tenantId, setting) {
        strategy = setting;
        return setting;
      },
    };
    return { store, created };
  }

  function opsWith(store: NetworkPoolStore, extra: Record<string, unknown> = {}) {
    return createNetworkPoolOperations({
      store,
      accessResolver: () => opsAccess,
      ...extra,
    });
  }

  test("createPool persists defaults and returns a sanitized response", async () => {
    const { store } = opsStore();
    const audited: unknown[] = [];
    const factory = opsWith(store, {
      auditSink: { record: async (e: unknown) => { audited.push(e); } },
      snapshotInvalidator: { invalidate: async () => 1 },
    });
    const created = await factory.createPool(opsAccess, {
      kind: "http",
      endpoint: "https://proxy.example.com:8080",
    } as never);
    expect(created.maxInflight).toBe(10);
    expect(created.weight).toBe(100);
    expect(created.status).toBe("active");
    expect(audited).toHaveLength(1);
  });

  test("createPool rejects bad limits and bad endpoints before the store", async () => {
    const { store } = opsStore();
    const factory = opsWith(store);
    await expect(
      factory.createPool(opsAccess, { kind: "http", endpoint: "https://p.example.com", maxInflight: 0 } as never),
    ).rejects.toThrow(expect.objectContaining({ code: "invalid_pool_limits" }));
    await expect(
      factory.createPool(opsAccess, { kind: "http", endpoint: "http://localhost:8080" } as never),
    ).rejects.toThrow(expect.objectContaining({ code: "ssrf_rejected" }));
  });

  test("updatePool merges config and releases the cached agent", async () => {
    const { store } = opsStore();
    const released: unknown[] = [];
    const factory = opsWith(store, {
      poolAgentReleaser: { releasePool: async (p: string, t: string) => { released.push([p, t]); } },
    });
    const created = await factory.createPool(opsAccess, {
      kind: "socks5",
      endpoint: "proxy.example.com:1080",
    } as never);
    const updated = await factory.updatePool(opsAccess, created.id, { weight: 200 });
    expect(updated.weight).toBe(200);
    expect(released).toHaveLength(1);
  });

  test("updatePool and getPoolDetail throw pool_not_found for unknown ids", async () => {
    const { store } = opsStore();
    const factory = opsWith(store);
    await expect(factory.updatePool(opsAccess, "missing", { weight: 5 })).rejects.toThrow(
      expect.objectContaining({ code: "pool_not_found" }),
    );
    await expect(factory.getPoolDetail(opsAccess, "missing")).rejects.toThrow(
      expect.objectContaining({ code: "pool_not_found" }),
    );
  });

  test("listPools reports live inflight and cooldowns from the selector", async () => {
    const { store } = opsStore();
    const factory = opsWith(store);
    await factory.createPool(opsAccess, { kind: "http", endpoint: "https://p.example.com:8080" } as never);
    const listed = await factory.listPools(opsAccess);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.available).toBe(listed[0]?.maxInflight);
  });

  test("clearPoolCooldown succeeds with and without a provider id", async () => {
    const { store } = opsStore();
    const factory = opsWith(store);
    await expect(factory.clearPoolCooldown(opsAccess, "any-pool", "openai")).resolves.toEqual({
      success: true,
    });
    await expect(factory.clearPoolCooldown(opsAccess, "any-pool")).resolves.toEqual({
      success: true,
    });
  });

  test("pool health events and recovery are tenant-scoped operations", async () => {
    const { store } = opsStore();
    const factory = opsWith(store);
    await expect(factory.listPoolHealthEvents(opsAccess, "pool-1")).resolves.toEqual([]);
    await expect(factory.recoverPool(opsAccess, "pool-1")).resolves.toEqual({ success: true });
  });

  test("getStrategy returns the stored setting", async () => {
    const { store } = opsStore();
    const factory = opsWith(store);
    await expect(factory.getStrategy(opsAccess)).resolves.toEqual(DEFAULT_POOL_STRATEGY);
  });
});
