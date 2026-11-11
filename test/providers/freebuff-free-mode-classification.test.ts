/**
 * Freebuff free-mode shape refusal is a verdict on the request, not on the
 * account: the upstream answers `free_mode_client_check_failed` ("The
 * developer message role is not supported.") for any request carrying a
 * `developer` role message. The credential is fine, so the account must
 * never be parked as "Re-login required" (`auth_invalidated`) the way all
 * 10 freebuff accounts were on 2026-11-10/11.
 */
import { afterEach, expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import { resetCooldownCacheForTests } from "../../src/config/cooldowns";

const FREEBUFF = "freebuff";
const UPSTREAM = { origin: "upstream" as const, scope: "provider" as const };

afterEach(() => {
  resetCooldownCacheForTests();
});

test("a freebuff free-mode refusal does not mutate the account", () => {
  const classification = classifyAccountError(
    new Error('{"error":"free_mode_client_check_failed","message":"The developer message role is not supported."}'),
    {
      ...UPSTREAM,
      providerId: FREEBUFF,
      providerCode: "free_mode_client_check_failed",
      statusCode: 403,
    },
  );
  expect(classification.category).toBe("policy_blocked_invalid_request");
  expect(classification.status).toBe("cooldown");
  expect(classification.cooldownMs).toBe(0);
  expect(classification.retryAt).toBeNull();
  expect(classification.mutatesAccount).toBe(false);
});

test("the freebuff refusal matches on the message even without a provider code", () => {
  const classification = classifyAccountError(
    new Error("The developer message role is not supported."),
    {
      ...UPSTREAM,
      providerId: FREEBUFF,
      statusCode: 400,
    },
  );
  expect(classification.category).toBe("policy_blocked_invalid_request");
  expect(classification.mutatesAccount).toBe(false);
});

test("the same message from another provider is not claimed by the freebuff arm", () => {
  const classification = classifyAccountError(
    new Error("The developer message role is not supported."),
    {
      ...UPSTREAM,
      providerId: "somebody-else",
      statusCode: 400,
    },
  );
  expect(classification.category).not.toBe("policy_blocked_invalid_request");
});
