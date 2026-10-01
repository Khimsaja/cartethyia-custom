/**
 * Integration coverage for `OAuthRefreshService`:
 * single-flight refresh, lease-fenced persistence, and definitive/transient
 * failure classification against a real Postgres instance.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { applySqlMigrations } from "../../src/persistence/postgres";
import { fullSchema as schema } from "../../src/persistence/postgres";
import {
  providers,
  providerAccounts,
  providerOauthStates,
} from "../../src/persistence/schema";
import { setCredentialEncryptionKeyForTesting, encryptCredential } from "../../src/security/crypto";
import {
  OAuthRefreshService,
  loadDueOAuthAccounts,
  type OAuthTokenRefresher,
} from "../../src/providers/authentication/oauth-refresh-service";
import { refreshAccountQuota } from "../../src/console/quota/refresh";
import { dbDescribe, testDatabaseUrl } from "../helpers/db-gate";

let pool: Pool | undefined;
let db: NodePgDatabase<typeof schema> | undefined;

/**
 * Accounts this suite created, so cleanup removes exactly those.
 *
 * A table-wide `delete(providerAccounts)` is what this replaced: DB-gated
 * suites share one isolated database and run as concurrent Bun worker
 * processes, so wiping the whole table deleted other suites' fixtures
 * mid-test and surfaced as unrelated failures elsewhere. These rows carry a
 * null `tenant_id` — they are the shared catalog's accounts, not a tenant's —
 * so the recorded account ids are the only correct ownership boundary.
 */
const createdAccountIds: string[] = [];

function requireDb(): NodePgDatabase<typeof schema> {
  if (!db) throw new Error("test database was not initialized");
  return db;
}

async function insertAccount(opts: {
  providerId: string;
  refreshToken: string | undefined;
  expiresAt: Date | undefined;
  status?: "active" | "cooldown" | "disabled";
  cooldownUntil?: Date;
  authState?: Record<string, unknown>;
  clientSecret?: string;
  staticToken?: boolean;
}): Promise<string> {
  await requireDb()
    .insert(providers)
    .values({ id: opts.providerId, enabled: true })
    .onConflictDoNothing();
  const [row] = await requireDb()
    .insert(providerAccounts)
    .values({
      providerId: opts.providerId,
      label: "test-account",
      credentialKind: "oauth",
      credentialCiphertext: encryptCredential("initial-access-token"),
      ...(opts.staticToken ? { staticToken: true } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.cooldownUntil ? { cooldownUntil: opts.cooldownUntil } : {}),
      ...(opts.authState ? { authState: opts.authState } : {}),
    })
    .returning({ id: providerAccounts.id });
  if (!row) throw new Error("failed to insert test account");
  createdAccountIds.push(row.id);
  // A state row exists whenever a refresh token is provided; the expiry may be
  // absent (an undated token reads as "always due"). `refreshToken: undefined`
  // means "no state row at all" — the shape an un-imported account had.
  if (opts.refreshToken !== undefined) {
    await requireDb()
      .insert(providerOauthStates)
      .values({
        providerAccountId: row.id,
        refreshCiphertext: encryptCredential(opts.refreshToken),
        expiresAt: opts.expiresAt ?? null,
        ...(opts.clientSecret === undefined
          ? {}
          : { clientSecretCiphertext: encryptCredential(opts.clientSecret) }),
      });
  }
  return row.id;
}

function fakeRefresher(result: OAuthTokenRefresher["refresh"]): OAuthTokenRefresher {
  return { refresh: result };
}

dbDescribe("OAuthRefreshService", () => {
  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    setCredentialEncryptionKeyForTesting(Buffer.alloc(32, 7));
    pool = new Pool({ connectionString: testDatabaseUrl, max: 4 });
    db = drizzle(pool, { schema });
    await applySqlMigrations(pool, resolve(import.meta.dir, "../../migrations"));
  });

  afterAll(async () => {
    setCredentialEncryptionKeyForTesting(undefined);
    if (pool) await pool.end();
  });

  afterEach(async () => {
    // Deleting the account cascades to its `provider_oauth_states` row, so the
    // lease and refresh state go with it. Scoped to this suite's ids: see
    // `createdAccountIds` for why a table-wide delete is not safe here.
    for (const id of createdAccountIds.splice(0)) {
      await requireDb().delete(providerAccounts).where(eq(providerAccounts.id, id));
    }
  });

  test("does not refresh a token that is not yet within the provider lead", async () => {
    // `claude`'s lead is 4h, so a token with 8h left is not due. The window is
    // per provider now, not a shared 5-minute skew.
    const accountId = await insertAccount({
      providerId: "claude",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
    });
    const service = new OAuthRefreshService(requireDb());
    let called = false;
    const refresher = fakeRefresher(async () => {
      called = true;
      throw new Error("should not be called");
    });
    const token = await service.ensureFreshAccessToken(accountId, refresher);
    expect(called).toBe(false);
    expect(token).toBe("initial-access-token");
  });

  test("refreshes and persists a token within the skew window", async () => {
    const accountId = await insertAccount({
      providerId: "claude",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 60 * 1000),
    });
    const service = new OAuthRefreshService(requireDb());
    const refresher = fakeRefresher(async (refreshToken) => {
      expect(refreshToken).toBe("refresh-1");
      return {
        access: "new-access",
        refresh: "new-refresh",
        expiresAt: new Date(Date.now() + 3600_000),
      };
    });
    const token = await service.ensureFreshAccessToken(accountId, refresher);
    expect(token).toBe("new-access");

    const [account] = await requireDb()
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    const [oauthState] = await requireDb()
      .select()
      .from(providerOauthStates)
      .where(eq(providerOauthStates.providerAccountId, accountId));
    expect(oauthState?.leaseOwner).toBeNull();
    expect(account?.status).toBe("active");
  });

  test("hands the refresher the account's stored auth state and companion secret", async () => {
    const accountId = await insertAccount({
      providerId: "kiro",
      refreshToken: "refresh-kiro",
      expiresAt: new Date(Date.now() + 60 * 1000),
      authState: { authMethod: "idc", region: "eu-west-1" },
      clientSecret: "registered-client-secret",
    });
    const service = new OAuthRefreshService(requireDb());
    let seenContext: unknown;
    const token = await service.ensureFreshAccessToken(
      accountId,
      fakeRefresher(async (_refreshToken, _signal, context) => {
        seenContext = context;
        return { access: "kiro-access", expiresAt: new Date(Date.now() + 3600_000) };
      }),
    );
    expect(token).toBe("kiro-access");
    expect(seenContext).toEqual({
      account_id: accountId,
      auth_state: { authMethod: "idc", region: "eu-west-1" },
      client_secret: "registered-client-secret",
    });
  });

  test("provides the decrypted current access token only to opted-in refreshers", async () => {
    const accountId = await insertAccount({
      providerId: "openai",
      refreshToken: "refresh-provider",
      expiresAt: new Date(Date.now() + 60 * 1000),
    });
    const service = new OAuthRefreshService(requireDb());
    let seenContext: unknown;
    const refresher: OAuthTokenRefresher = {
      requiresAccessToken: true,
      refresh: async (_refreshToken, _signal, context) => {
        seenContext = context;
        return { access: "provider-access", expiresAt: new Date(Date.now() + 3600_000) };
      },
    };

    const token = await service.ensureFreshAccessToken(accountId, refresher);

    expect(token).toBe("provider-access");
    expect(seenContext).toEqual({
      account_id: accountId,
      access_token: "initial-access-token",
    });
  });

  test("persists an auth state a refresh reports and leaves the stored one alone otherwise", async () => {
    const accountId = await insertAccount({
      providerId: "kiro",
      refreshToken: "refresh-kiro-2",
      expiresAt: new Date(Date.now() + 60 * 1000),
      authState: { authMethod: "builder-id" },
    });
    const service = new OAuthRefreshService(requireDb());
    await service.ensureFreshAccessToken(
      accountId,
      fakeRefresher(async () => ({
        access: "kiro-access-2",
        expiresAt: new Date(Date.now() + 3600_000),
        auth_state: { authMethod: "builder-id", profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/AAA" },
      })),
    );
    const [account] = await requireDb()
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    expect(account?.authState).toEqual({
      authMethod: "builder-id",
      profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/AAA",
    });

    // A later refresh that reports nothing must not blank what is stored: the
    // account keeps the profile it resolved earlier.
    const service2 = new OAuthRefreshService(requireDb());
    await service2.ensureFreshAccessToken(
      accountId,
      fakeRefresher(async () => ({
        access: "kiro-access-3",
        expiresAt: new Date(Date.now() + 3600_000),
      })),
      { force: true },
    );
    const [after] = await requireDb()
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    expect(after?.authState).toEqual({
      authMethod: "builder-id",
      profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/AAA",
    });
  });

  test("adopts a refresh-reported identity only over a default label", async () => {
    const seeded = async (label: string): Promise<string> => {
      await requireDb().insert(providers).values({ id: "label-probe", enabled: true }).onConflictDoNothing();
      const [row] = await requireDb()
        .insert(providerAccounts)
        .values({
          providerId: "label-probe",
          label,
          credentialKind: "oauth",
          credentialCiphertext: encryptCredential("initial-access-token"),
        })
        .returning({ id: providerAccounts.id });
      if (!row) throw new Error("failed to insert test account");
      createdAccountIds.push(row.id);
      await requireDb().insert(providerOauthStates).values({
        providerAccountId: row.id,
        refreshCiphertext: encryptCredential("refresh-label"),
        expiresAt: new Date(Date.now() + 60 * 1000),
      });
      return row.id;
    };
    const readLabel = async (accountId: string): Promise<string | undefined> => {
      const [row] = await requireDb().select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
      return row?.label;
    };
    const refreshWithLabel = (label: string): OAuthTokenRefresher =>
      fakeRefresher(async () => ({ access: "fresh-access", expiresAt: new Date(Date.now() + 3600_000), accountLabel: label }));

    const defaulted = await seeded("label-probe");
    await new OAuthRefreshService(requireDb()).ensureFreshAccessToken(defaulted, refreshWithLabel("user@example.com"), { force: true });
    expect(await readLabel(defaulted)).toBe("user@example.com");

    const renamed = await seeded("My Work Account");
    await new OAuthRefreshService(requireDb()).ensureFreshAccessToken(renamed, refreshWithLabel("user@example.com"), { force: true });
    expect(await readLabel(renamed)).toBe("My Work Account");
  });

  test("adopts a quota-reported identity only over a default label", async () => {
    const fakeRedis = { get: async () => null, set: async () => undefined } as never;
    const seed = async (label: string): Promise<string> => {
      await requireDb().insert(providers).values({ id: "label-quota", enabled: true }).onConflictDoNothing();
      const [row] = await requireDb()
        .insert(providerAccounts)
        .values({
          providerId: "label-quota",
          label,
          credentialKind: "oauth",
          credentialCiphertext: encryptCredential("quota-access"),
        })
        .returning({ id: providerAccounts.id });
      if (!row) throw new Error("failed to insert test account");
      createdAccountIds.push(row.id);
      return row.id;
    };
    const registry = { resolveQuotaCollector: async () => (async () => ({
      source: "label-quota",
      plan: null,
      windows: [],
      error: null,
      accountLabel: "quota-user@example.com",
    })) } as never;
    const deps = {
      db: requireDb(),
      redis: fakeRedis,
      providerRegistry: registry,
      resolveCredential: async () => "quota-access",
    } as never;
    const defaulted = await seed("label-quota");
    const first = await refreshAccountQuota(deps, { accountId: defaulted, providerId: "label-quota", tenantId: null } as never, (async () => new Response("{}")) as never);
    expect(first.accountLabel).toBe("quota-user@example.com");
    const [adopted] = await requireDb().select().from(providerAccounts).where(eq(providerAccounts.id, defaulted));
    expect(adopted?.label).toBe("quota-user@example.com");

    const renamed = await seed("My Label");
    await refreshAccountQuota(deps, { accountId: renamed, providerId: "label-quota", tenantId: null } as never, (async () => new Response("{}")) as never);
    const [kept] = await requireDb().select().from(providerAccounts).where(eq(providerAccounts.id, renamed));
    expect(kept?.label).toBe("My Label");
  });

  test("refreshes disabled accounts without re-enabling or clearing cooldown health state", async () => {
    const cooldownUntil = new Date(Date.now() + 15 * 60 * 1000);
    const accountId = await insertAccount({
      providerId: "claude",
      refreshToken: "refresh-disabled",
      expiresAt: new Date(Date.now() + 60 * 1000),
      status: "disabled",
      cooldownUntil,
    });
    const service = new OAuthRefreshService(requireDb());
    const token = await service.ensureFreshAccessToken(
      accountId,
      fakeRefresher(async () => ({
        access: "refreshed-disabled",
        refresh: "refresh-disabled-2",
        expiresAt: new Date(Date.now() + 3600_000),
      })),
    );
    expect(token).toBe("refreshed-disabled");

    const [account] = await requireDb()
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    expect(account?.status).toBe("disabled");
    expect(account?.cooldownUntil?.getTime()).toBe(cooldownUntil.getTime());
    expect(account?.consecutiveFailures).toBe(0);
    expect(account?.lastSuccessAt).toBeNull();
  });

  test("in-process concurrent callers share a single upstream refresh call", async () => {
    const accountId = await insertAccount({
      providerId: "claude",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 60 * 1000),
    });
    const service = new OAuthRefreshService(requireDb());
    let callCount = 0;
    const refresher = fakeRefresher(async () => {
      callCount += 1;
      await new Promise((r) => setTimeout(r, 50));
      return {
        access: "new-access",
        refresh: "new-refresh",
        expiresAt: new Date(Date.now() + 3600_000),
      };
    });
    const [a, b, c] = await Promise.all([
      service.ensureFreshAccessToken(accountId, refresher),
      service.ensureFreshAccessToken(accountId, refresher),
      service.ensureFreshAccessToken(accountId, refresher),
    ]);
    expect(callCount).toBe(1);
    expect(a).toBe("new-access");
    expect(b).toBe("new-access");
    expect(c).toBe("new-access");
  });

  test("a definitive failure disables the account and clears the lease", async () => {
    const accountId = await insertAccount({
      providerId: "claude",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 60 * 1000),
    });
    const service = new OAuthRefreshService(requireDb());
    const refresher = fakeRefresher(async () => {
      throw new Error('{"error":"invalid_grant","error_description":"revoked"}');
    });
    const token = await service.ensureFreshAccessToken(accountId, refresher);
    expect(token).toBeNull();

    const [account] = await requireDb()
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    const [oauthState] = await requireDb()
      .select()
      .from(providerOauthStates)
      .where(eq(providerOauthStates.providerAccountId, accountId));
    expect(account?.status).toBe("disabled");
    expect(oauthState?.leaseOwner).toBeNull();
  });

  test("a transient failure releases the lease without disabling the account", async () => {
    const accountId = await insertAccount({
      providerId: "claude",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 60 * 1000),
    });
    const service = new OAuthRefreshService(requireDb());
    const refresher = fakeRefresher(async () => {
      throw new Error("upstream timed out");
    });
    const token = await service.ensureFreshAccessToken(accountId, refresher);
    expect(token).toBeNull();

    const [account] = await requireDb()
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    const [oauthState] = await requireDb()
      .select()
      .from(providerOauthStates)
      .where(eq(providerOauthStates.providerAccountId, accountId));
    expect(account?.status).toBe("active");
    expect(oauthState?.leaseOwner).toBeNull();
  });

  test("loadDueOAuthAccounts returns only active OAuth accounts within the provider lead", async () => {
    // `claude`'s refresh lead is 4h (`REFRESH_LEAD_MS`): a token expiring
    // inside that window is due, one beyond it is not. The lead is per
    // provider, so the window is the provider's, not a shared constant.
    const due = await insertAccount({
      providerId: "claude",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await insertAccount({
      providerId: "claude",
      refreshToken: "refresh-2",
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
    });
    // No recorded expiry reads as "always due" so an account the sweep cannot
    // date is still refreshed rather than left to expire unseen.
    const noExpiry = await insertAccount({
      providerId: "claude",
      refreshToken: "refresh-3",
      expiresAt: undefined,
    });

    const rows = await loadDueOAuthAccounts(requireDb());
    // Filtered to this suite's accounts: the shared isolated database also
    // holds other suites' OAuth accounts, and the query is deliberately
    // table-wide. Among the three rows inserted above, the in-window one and
    // the undated one are returned; the far-future one is not.
    expect(
      rows.map((r) => r.id).filter((id) => createdAccountIds.includes(id)).sort(),
    ).toEqual([due, noExpiry].sort());
  });

  test("a static-token account is never refreshed and is skipped by the sweep", async () => {
    // The regression this guards: a pasted JWT/access token with no refresh
    // token used to be stamped `oauth_reauth_required` and read as broken. It
    // is a normal, usable credential used exactly as issued — the sweep must
    // skip it and a refresh attempt must not reach the refresher at all.
    const accountId = await insertAccount({
      providerId: "claude",
      refreshToken: undefined,
      expiresAt: undefined,
      staticToken: true,
    });

    const due = await loadDueOAuthAccounts(requireDb());
    expect(due.some((r) => r.id === accountId)).toBe(false);

    const service = new OAuthRefreshService(requireDb());
    let called = false;
    const refresher = fakeRefresher(async () => {
      called = true;
      throw new Error("static token must never be refreshed");
    });
    // Even a forced refresh (the 401 retry path) never runs a grant: there is
    // nothing to re-mint, so it returns null — the same "cannot refresh" signal
    // a missing refresh token gives — and the caller keeps the stored token.
    const token = await service.ensureFreshAccessToken(accountId, refresher, { force: true });
    expect(called).toBe(false);
    expect(token).toBeNull();
  });
});
