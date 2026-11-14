/**
 * A transient credential-store failure retries once before failing.
 *
 * On 2026-11-14 a single pool connect timeout became bursts of 7–55
 * key-lookup failures in a second: the first failure engaged the 1s
 * store-unavailable cooldown, and every concurrent caller failed instantly
 * from it. One retry after a short pause rides a 1–2s stall out instead of
 * failing the request and cooling the store down for everyone.
 */
import { describe, expect, test } from "bun:test";
import {
  invalidateApiKeyCache,
  resolveApiKeyAuthorization,
} from "../../src/security/api-key-auth";
import { apiKeys } from "../../src/persistence/schema";

function fakeRow(): typeof apiKeys.$inferSelect {
  return {
    id: "key-retry-1",
    tenantId: "tenant-1",
    keyHash: "hash",
    keyMode: "personal",
    parentKeyId: null,
    issuedClientIp: null,
    issuedClientIpKey: null,
    label: "retry probe",
    scopes: ["routing:invoke"],
    requestsPerMinute: null,
    dailyTokenLimit: null,
    monthlyTokenLimit: null,
    lifetimeTokenBudget: null,
    lifetimeTokensConsumed: 0,
    maxConcurrentRequests: null,
    concurrencyScope: "family",
    modelAccessMode: "whitelist",
    modelList: null,
    clientRouterDenylist: null,
    modelPrefix: null,
    createdAt: new Date(),
    enabled: true,
    revokedAt: null,
    expiresAt: null,
    bannedAt: null,
    banReason: null,
    bannedUntil: null,
    keyPrefix: "tip_",
    keyEncrypted: null,
    notesTitle: null,
    notesSubtitle: null,
    notesBody: null,
    sortIndex: 0,
    maxChildren: null,
    modelTemplateId: null,
    isDefault: false,
  };
}

/** A db handle whose first `select()` throws (pool connect timeout), then works. */
function flakyDb(row: typeof apiKeys.$inferSelect): {
  selects: () => number;
  db: unknown;
} {
  let selects = 0;
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = async () => [row];
  return {
    selects: () => selects,
    db: {
      apiKeys,
      select: () => {
        selects += 1;
        if (selects === 1) throw new Error("timeout exceeded when trying to connect");
        return chain;
      },
    },
  };
}

describe("credential store transient failure", () => {
  test("one failed lookup retries and resolves instead of failing", async () => {
    invalidateApiKeyCache();
    const { db, selects } = flakyDb(fakeRow());
    const resolved = await resolveApiKeyAuthorization(db as never, "token-retry-1");
    expect(resolved?.id).toBe("key-retry-1");
    expect(selects()).toBe(2);
  });

  test("a retry success does not engage the store-unavailable cooldown", async () => {
    invalidateApiKeyCache();
    const { db } = flakyDb(fakeRow());
    await resolveApiKeyAuthorization(db as never, "token-retry-2");
    // A second token resolves through the store instead of throwing
    // ApiKeyStoreUnavailableError from the cooldown.
    const second = await resolveApiKeyAuthorization(db as never, "token-retry-3");
    expect(second?.id).toBe("key-retry-1");
  });
});
