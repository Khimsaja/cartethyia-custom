/**
 * Qoder agent-limit refusal is a verdict on the (account, model) pair, not
 * on the credential: the upstream answers
 * `{"code":"115","message":"{\"agentLimitResetTime\":<ms>}"}` when the
 * account's agent quota for the slot is exhausted. The named reset is
 * created_at + 30 days, so it must never become a cooldown — and the
 * failure is transient per-request (the same account answered the same
 * lite slot 7 seconds after a 115 on 2026-11-11), so the account must
 * never be parked as "Re-login required" (`auth_invalidated`) the way
 * ~141 OAuth accounts were during the 09:00 WIB wave.
 */
import { afterEach, expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import { resetCooldownCacheForTests } from "../../src/config/cooldowns";

const QODER = "qoder";
const UPSTREAM = { origin: "upstream" as const, scope: "provider" as const };
const LITE = "lite-qwen-3.7-plus";
const BODY_115 = '{"code":"115","message":"{\\"agentLimitResetTime\\":1795912905677}"}';

afterEach(() => {
  resetCooldownCacheForTests();
});

test("a qoder 115 agent-limit refusal cools only the model pair for 10 minutes", () => {
  const classification = classifyAccountError(new Error(BODY_115), {
    ...UPSTREAM,
    providerId: QODER,
    providerCode: "115",
    statusCode: 403,
    modelId: LITE,
  });
  expect(classification.category).toBe("rate_limit_transient");
  expect(classification.status).toBe("cooldown");
  expect(classification.cooldownMs).toBe(10 * 60_000);
  expect(classification.retryAt).not.toBeNull();
  expect(classification.mutatesAccount).toBe(true);
  expect(classification.modelScoped).toBe(true);
});

test("the 115 arm matches on the body text even without a provider code", () => {
  const classification = classifyAccountError(new Error(BODY_115), {
    ...UPSTREAM,
    providerId: QODER,
    statusCode: 403,
    modelId: LITE,
  });
  expect(classification.category).toBe("rate_limit_transient");
  expect(classification.modelScoped).toBe(true);
});

test("the same 115 body from another provider is not claimed by the qoder arm", () => {
  const classification = classifyAccountError(new Error(BODY_115), {
    ...UPSTREAM,
    providerId: "somebody-else",
    providerCode: "115",
    statusCode: 403,
    modelId: LITE,
  });
  expect(classification.category).not.toBe("rate_limit_transient");
});

test("a genuine qoder auth failure still invalidates the credential", () => {
  const classification = classifyAccountError(
    new Error('{"error":{"message":"Invalid API key","type":"invalid_request_error"}}'),
    {
      origin: "upstream" as const,
      scope: "account" as const,
      providerId: QODER,
      statusCode: 403,
      modelId: LITE,
    },
  );
  expect(classification.category).toBe("auth_invalidated");
});
