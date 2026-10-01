import { describe, expect, test } from "bun:test";
import {
  createProviderDetailOperations,
  createProviderDetailRoutes,
} from "../../../src/console/providers/detail/routes";
import type { ProviderDetailStore } from "../../../src/console/providers/detail/contracts";
import type { ProviderRoutingResponse, UpdateProviderRoutingRequest } from "../../../src/console/providers/catalog/contracts";
import type { AccessDecision } from "../../../src/security/access-control";
import { ConsoleDomainError } from "../../../src/console/shared/errors";

describe("provider-detail operations", () => {
const access: AccessDecision = {
  id: "key-1",
  tenantId: "tenant-1",
  scopes: ["dashboard:read", "dashboard:write", "providers:read", "providers:write", "models:read", "models:write"],
    admissionIdentity: "key-1",
};

const readOnly: AccessDecision = {
  ...access,
  scopes: ["dashboard:read", "providers:read", "models:read"],
};

const platformAccess: AccessDecision = {
  ...access,
  tenantId: null,
  scopes: ["platform:admin", "dashboard:read", "dashboard:write", "providers:read", "providers:write", "models:read", "models:write"],
};

interface Row {
  tenantId: string | null;
  response: ProviderRoutingResponse;
}

/** In-memory store mirroring the Drizzle tenant-scoped lookup behaviour. */
function makeStore(): {
  store: ProviderDetailStore;
  rows: Row[];
} {
  const rows: Row[] = [];
  const resolve = (
    providerId: string,
    tenantId: string | null,
  ): ProviderRoutingResponse | undefined => {
    if (tenantId !== null) {
      const specific = rows.find(
        (r) => r.response.providerId === providerId && r.tenantId === tenantId,
      );
      if (specific) return specific.response;
    }
    const global = rows.find((r) => r.response.providerId === providerId && r.tenantId === null);
    if (global) return { ...global.response, tenantId };
    return undefined;
  };
  const store: ProviderDetailStore = {
    async getRouting(providerId, tenantId) {
      return (
        resolve(providerId, tenantId) ?? {
          providerId,
          tenantId,
          strategy: "fallback",
          rotateCount: 1,
          maxInflight: null,
          creditFloor: null,
          enabled: false,
          bypassProxy: false,
          userAgent: "codex_cli_rs/0.156.1",
        }
      );
    },
    async updateRouting(providerId, tenantId, patch: UpdateProviderRoutingRequest) {
      const existing = resolve(providerId, tenantId);
      if (!existing) {
        const created: ProviderRoutingResponse = {
          providerId,
          tenantId,
          strategy: patch.strategy ?? "fallback",
          rotateCount: patch.rotateCount ?? 1,
          maxInflight: patch.maxInflight ?? null,
          creditFloor: patch.creditFloor ?? null,
          enabled: patch.enabled ?? false,
          bypassProxy: patch.bypassProxy ?? false,
          userAgent: patch.userAgent ?? "codex_cli_rs/0.156.1",
        };
        rows.push({ tenantId, response: { ...created, tenantId } });
        return created;
      }
      const updated: ProviderRoutingResponse = {
        ...existing,
        ...(patch.strategy !== undefined ? { strategy: patch.strategy } : {}),
        ...(patch.rotateCount !== undefined ? { rotateCount: patch.rotateCount } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.bypassProxy !== undefined ? { bypassProxy: patch.bypassProxy } : {}),
        ...(patch.maxInflight !== undefined ? { maxInflight: patch.maxInflight } : {}),
        ...(patch.userAgent !== undefined ? { userAgent: patch.userAgent } : {}),
      };
      const idx = rows.findIndex(
        (r) => r.response.providerId === providerId && r.tenantId === tenantId,
      );
      if (idx >= 0) rows[idx] = { tenantId, response: updated };
      else rows.push({ tenantId, response: updated });
      return updated;
    },
  };
  return { store, rows };
}

describe("ProviderDetailOperations.getRouting", () => {
  test("defaults to fallback/disabled/TTL 120 when no settings row exists", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    const result = await factory.getRouting(access, "openai");
    expect(result).toEqual({
      providerId: "openai",
      tenantId: "tenant-1",
      strategy: "fallback",
      rotateCount: 1,
      maxInflight: null,
      creditFloor: null,
      enabled: false,
      bypassProxy: false,
      userAgent: "codex_cli_rs/0.156.1",
    });
  });

  test("requires dashboard:read scope", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    const limited: AccessDecision = { ...access, scopes: [] };
    await expect(factory.getRouting(limited, "openai")).rejects.toBeInstanceOf(ConsoleDomainError);
  });

  test("rejects platform-level access without tenant", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    await expect(factory.getRouting(platformAccess, "openai")).rejects.toMatchObject({
      code: "tenant_required",
    });
  });

  test("read-only access can read routing", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    const result = await factory.getRouting(readOnly, "openai");
    expect(result.strategy).toBe("fallback");
  });
});

describe("ProviderDetailOperations.updateRouting", () => {
  test("round_robin patch persists strategy", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    const updated = await factory.updateRouting(access, "openai", {
      enabled: true,
      strategy: "round_robin",
    });
    expect(updated.strategy).toBe("round_robin");
    expect(updated.enabled).toBe(true);
    const readBack = await factory.getRouting(access, "openai");
    expect(readBack.strategy).toBe("round_robin");
  });

  test("round_robin with rotateCount persists", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    const updated = await factory.updateRouting(access, "openai", {
      enabled: true,
      strategy: "round_robin",
      rotateCount: 3,
    });
    expect(updated.strategy).toBe("round_robin");
    expect(updated.rotateCount).toBe(3);
  });

  test("rotateCount below 1 is rejected", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    await expect(
      factory.updateRouting(access, "openai", { strategy: "round_robin", rotateCount: 0 }),
    ).rejects.toMatchObject({ code: "invalid_rotate_count" });
  });

  test("rotateCount above 1000 is rejected", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    await expect(
      factory.updateRouting(access, "openai", { strategy: "round_robin", rotateCount: 1001 }),
    ).rejects.toMatchObject({ code: "invalid_rotate_count" });
  });

  test("invalid strategy is rejected", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    const bad = { strategy: "chaos" } as unknown as UpdateProviderRoutingRequest;
    await expect(factory.updateRouting(access, "openai", bad)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  test("write requires dashboard:write scope", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    await expect(
      factory.updateRouting(readOnly, "openai", { enabled: true }),
    ).rejects.toMatchObject({ code: "insufficient_scope" });
  });

  test("updates are tenant-isolated", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    await factory.updateRouting(access, "openai", {
      enabled: true,
      strategy: "round_robin",
      rotateCount: 2,
    });
    const otherTenant: AccessDecision = { ...access, tenantId: "tenant-2" };
    const other = await factory.getRouting(otherTenant, "openai");
    expect(other.enabled).toBe(false);
    expect(other.strategy).toBe("fallback");
  });

  test("provider maxInflight patch persists and clears back to null", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    const set = await factory.updateRouting(access, "openai", {
      strategy: "round_robin",
      maxInflight: 8,
    });
    expect(set.maxInflight).toBe(8);
    expect((await factory.getRouting(access, "openai")).maxInflight).toBe(8);

    // Clearing the field means unlimited, so the persisted value must return
    // to null rather than keeping the old ceiling.
    const cleared = await factory.updateRouting(access, "openai", { maxInflight: null });
    expect(cleared.maxInflight).toBeNull();
    expect((await factory.getRouting(access, "openai")).maxInflight).toBeNull();
  });

  test("persists a custom User-Agent for a built-in API-key provider", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    const selected = await factory.updateRouting(access, "openai", {
      userAgent: "claude-cli/2.1.280 (external, cli)",
    });
    expect(selected.userAgent).toBe("claude-cli/2.1.280 (external, cli)");
    expect((await factory.getRouting(access, "openai")).userAgent).toBe(
      "claude-cli/2.1.280 (external, cli)",
    );
    await expect(
      factory.updateRouting(access, "openai", {
        userAgent: `bad${String.fromCharCode(1)}Injected`,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("account inflight normalizes readings and reports zero when unwired", async () => {
    const { store } = makeStore();
    const wired = createProviderDetailOperations({
      store,
      accessResolver: () => access,
      accountInflight: async () => [
        { accountId: "acct-1", inflight: 2.7 },
        { accountId: "acct-2", inflight: -1 },
      ],
    });
    await expect(wired.accountInflight(access, "openai")).resolves.toEqual([
      { accountId: "acct-1", inflight: 2 },
      { accountId: "acct-2", inflight: 0 },
    ]);
    const unwired = createProviderDetailOperations({ store, accessResolver: () => access });
    await expect(unwired.accountInflight(access, "openai")).resolves.toEqual([]);
  });

  test("bypassProxy toggles independently of strategy", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    const on = await factory.updateRouting(access, "openai", {
      strategy: "round_robin",
      bypassProxy: true,
    });
    expect(on.bypassProxy).toBe(true);
    expect(on.strategy).toBe("round_robin");

    const off = await factory.updateRouting(access, "openai", { bypassProxy: false });
    expect(off.bypassProxy).toBe(false);
    // The earlier strategy must survive a bypass-only patch.
    expect(off.strategy).toBe("round_robin");
  });
});

describe("PATCH /providers/:providerId/routing body schema", () => {
  test("accepts and applies enabled:true from the dashboard", async () => {
    const { store } = makeStore();
    const app = createProviderDetailRoutes({ store, accessResolver: () => access });
    const response = await app.handle(
      new Request("http://localhost/providers/openai/routing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: "round_robin", enabled: true }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { enabled: boolean; strategy: string };
    expect(body.enabled).toBe(true);
    expect(body.strategy).toBe("round_robin");
  });
});
});
