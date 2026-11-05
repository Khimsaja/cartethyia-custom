/**
 * Auth-escalation streak (2026-11-04, user-approved policy change).
 *
 * Policy: a static-token account that collects N consecutive upstream auth
 * rejections within 24 h (env CARTETHYIA_AUTH_ESCALATION_THRESHOLD, default
 * 0 = off; recommended activation value 3) is disabled operator-style
 * (status disabled, cooldownUntil NULL, sweep never recovers it) with a
 * health-event reason `auto_escalation:auth_invalidated_x<N>`. The streak
 * counts only auth_invalidated verdicts for static tokens of in-scope
 * providers (default qoder,qodercn); it resets on any success and on any
 * non-auth verdict, and probe-surface failures never count.
 *
 * These are pure unit tests against a narrow in-memory double of the
 * database handle: no database, no network, no gateway boot. The double
 * implements exactly the drizzle chain the writers use (select/from/where/
 * limit, update/set/where, insert/values, transaction) for a single row.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import { resetCooldownCacheForTests } from "../../src/config/cooldowns";
import {
  recordAccountFailure,
  recordAccountSuccess,
} from "../../src/providers/operations/account-health-service";
import type { AccountFailureEvidence } from "../../src/providers/operations/account-health-service";

const ACCOUNT_ID = "00000000-0000-0000-0000-000000000001";

type Row = {
  status: string;
  staticToken: boolean;
  providerId: string;
  consecutiveFailures: number;
  consecutiveAuthRejections: number;
  lastAuthRejectionAt: Date | null;
  cooldownUntil: Date | null;
  modelCooldowns: Record<string, string>;
  modelBlockHits: Record<string, number> | null;
  lastSuccessAt: Date | null;
  lastError?: string | null;
  lastErrorCategory?: string | null;
  lastErrorAt?: Date | null;
  lastRecoveredAt?: Date | null;
};

function createDb(seed: Partial<Row> = {}) {
  const row: Row = {
    status: "active",
    staticToken: true,
    providerId: "qoder",
    consecutiveFailures: 0,
    consecutiveAuthRejections: 0,
    lastAuthRejectionAt: null,
    cooldownUntil: null,
    modelCooldowns: {},
    modelBlockHits: null,
    lastSuccessAt: null,
    ...seed,
  };
  const events: Array<Record<string, unknown>> = [];
  const applySet = (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) {
      if (key === "consecutiveFailures" && typeof value !== "number") {
        // A drizzle `sql` increment expression: the double counts it as +1.
        row.consecutiveFailures += 1;
      } else {
        (row as Record<string, unknown>)[key] = value;
      }
    }
  };
  const client: any = {
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (_n: number) => Promise.resolve([{ ...row }]),
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          applySet(values);
          return Promise.resolve();
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: (v: unknown) => {
        events.push(...(Array.isArray(v) ? v : [v]));
        return Promise.resolve();
      },
    }),
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  return { db: client, row, events };
}

function authError(): GatewayError {
  return new GatewayError("authentication_failed" as never, 401, "personal token is invalid", {
    providerId: "qoder",
    providerStatus: 401,
    providerCode: "authentication_failed",
  }, "upstream");
}

function rateLimitError(): GatewayError {
  return new GatewayError("rate_limit_transient" as never, 429, "rate limit exceeded", {
    providerId: "qoder",
    providerStatus: 429,
    providerCode: "rate_limit_exceeded",
  }, "upstream");
}

function evidence(extra: Partial<AccountFailureEvidence> = {}): AccountFailureEvidence {
  return {
    origin: "upstream",
    scope: "account",
    credentialEvidence: true,
    providerId: "qoder",
    ...extra,
  };
}

function setEnv(threshold: string | undefined, providers: string | undefined) {
  if (threshold === undefined) delete process.env.CARTETHYIA_AUTH_ESCALATION_THRESHOLD;
  else process.env.CARTETHYIA_AUTH_ESCALATION_THRESHOLD = threshold;
  if (providers === undefined) delete process.env.CARTETHYIA_AUTH_ESCALATION_PROVIDERS;
  else process.env.CARTETHYIA_AUTH_ESCALATION_PROVIDERS = providers;
  resetCooldownCacheForTests();
}

beforeEach(() => {
  // Default per test: threshold 3, providers default (qoder,qodercn).
  setEnv("3", undefined);
});

afterEach(() => {
  setEnv(undefined, undefined);
});

describe("auth-escalation streak", () => {
  test("three consecutive auth rejections disable the account operator-style", async () => {
    const { db, row, events } = createDb();
    await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    expect(row.status).toBe("cooldown");
    expect(row.consecutiveAuthRejections).toBe(1);
    await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    expect(row.status).toBe("cooldown");
    expect(row.consecutiveAuthRejections).toBe(2);
    const classification = await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    expect(row.status).toBe("disabled");
    expect(row.cooldownUntil).toBeNull();
    expect(row.consecutiveAuthRejections).toBe(3);
    expect(row.lastErrorCategory).toBe("auth_invalidated");
    expect(classification?.routesVisible).toBe(true);
    const escalation = events.find((e) => e.reason === "auto_escalation:auth_invalidated_x3");
    expect(escalation).toBeDefined();
    expect(escalation?.toStatus).toBe("disabled");
    expect(escalation?.errorCategory).toBe("auth_invalidated");
    // A fourth failure against the disabled row writes nothing.
    const eventsBefore = events.length;
    const fourth = await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    expect(fourth).toBeNull();
    expect(events.length).toBe(eventsBefore);
  });

  test("a streak older than 24 h restarts at 1", async () => {
    const { db, row } = createDb({
      consecutiveAuthRejections: 2,
      lastAuthRejectionAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    expect(row.consecutiveAuthRejections).toBe(1);
    expect(row.status).not.toBe("disabled");
  });

  test("a success resets the streak", async () => {
    const { db, row } = createDb({ consecutiveAuthRejections: 2 });
    const recovered = await recordAccountSuccess(db, ACCOUNT_ID);
    expect(row.consecutiveAuthRejections).toBe(0);
    expect(row.lastAuthRejectionAt).toBeNull();
    expect(row.status).toBe("active");
    expect(recovered).toBe(false);
  });

  test("a non-auth verdict resets the streak", async () => {
    const { db, row } = createDb({ consecutiveAuthRejections: 2 });
    await recordAccountFailure(db, ACCOUNT_ID, rateLimitError(), evidence());
    expect(row.consecutiveAuthRejections).toBe(0);
    expect(row.lastAuthRejectionAt).toBeNull();
  });

  test("a model-scoped throttle resets the streak", async () => {
    const { db, row } = createDb({ consecutiveAuthRejections: 2 });
    await recordAccountFailure(db, ACCOUNT_ID, rateLimitError(), evidence({ modelId: "qwen3.8-flash" }));
    expect(row.consecutiveAuthRejections).toBe(0);
    expect(row.lastAuthRejectionAt).toBeNull();
  });

  test("an out-of-scope provider never counts", async () => {
    const { db, row, events } = createDb({ providerId: "otherprovider" });
    await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    expect(row.consecutiveAuthRejections).toBe(0);
    expect(row.status).not.toBe("disabled");
    expect(events.some((e) => typeof e.reason === "string" && e.reason.startsWith("auto_escalation:"))).toBe(false);
  });

  test("a non-static token never counts", async () => {
    const { db, row, events } = createDb({ staticToken: false });
    await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    expect(row.consecutiveAuthRejections).toBe(0);
    expect(events.some((e) => typeof e.reason === "string" && e.reason.startsWith("auto_escalation:"))).toBe(false);
  });

  test("probe-surface failures never count", async () => {
    const { db, row, events } = createDb();
    const probeEvidence = evidence({ sourceSurface: "probe" });
    await recordAccountFailure(db, ACCOUNT_ID, authError(), probeEvidence);
    await recordAccountFailure(db, ACCOUNT_ID, authError(), probeEvidence);
    await recordAccountFailure(db, ACCOUNT_ID, authError(), probeEvidence);
    expect(row.consecutiveAuthRejections).toBe(0);
    expect(row.status).not.toBe("disabled");
    expect(events.some((e) => typeof e.reason === "string" && e.reason.startsWith("auto_escalation:"))).toBe(false);
  });

  test("threshold 0 (feature off) counts nothing and disables nothing", async () => {
    setEnv("0", undefined);
    const { db, row } = createDb();
    for (let i = 0; i < 5; i++) {
      await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    }
    expect(row.consecutiveAuthRejections).toBe(0);
    expect(row.status).not.toBe("disabled");
  });

  test("an already-disabled row is untouched", async () => {
    const { db, row, events } = createDb({ status: "disabled", consecutiveAuthRejections: 2 });
    const result = await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    expect(result).toBeNull();
    expect(row.consecutiveAuthRejections).toBe(2);
    expect(events.length).toBe(0);
  });

  test("the default provider allowlist covers qodercn", async () => {
    const { db, row } = createDb({ providerId: "qodercn" });
    await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    expect(row.status).toBe("disabled");
    expect(row.consecutiveAuthRejections).toBe(3);
  });

  test("an explicit provider allowlist excludes the rest", async () => {
    setEnv("3", "qoder");
    const { db, row } = createDb({ providerId: "qodercn" });
    await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    await recordAccountFailure(db, ACCOUNT_ID, authError(), evidence());
    expect(row.consecutiveAuthRejections).toBe(0);
    expect(row.status).not.toBe("disabled");
  });
});
