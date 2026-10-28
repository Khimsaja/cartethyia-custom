/**
 * Exact-name whitelist regression tests (TipRouter local patch).
 *
 * Ported from the deleted test/unit/api-key-auth.test.ts when upstream
 * 2.7.1 re-laid the test tree: the rule itself moved to
 * src/security/model-access-rule.ts, and these three cases pin the
 * exact-name behavior — a bare allowlist entry must not authorize a
 * caller-supplied qualified name whose final segment merely matches.
 */
import { describe, expect, test } from "bun:test";
import { modelRejectionReason } from "../../src/security/model-access-rule";

describe("modelRejectionReason exact-name whitelist", () => {
  test("a qualified request is not rescued by a bare entry", () => {
    // The leak this closes: the caller asked for a provider-qualified (or
    // multi-segment aggregator) name that is not listed; the resolved
    // target's final segment matching a bare entry must not authorize it.
    const policy = { model_access_mode: "whitelist" as const, model_list: ["model-x"] };
    expect(
      modelRejectionReason(policy, "provider/model-x", "provider", "provider/model-x"),
    ).toBe("model-not-allowed");
    expect(
      modelRejectionReason(policy, "agg/up/model-x", "agg", "agg/up/model-x"),
    ).toBe("model-not-allowed");
  });

  test("a listed bare request authorizes its qualified target", () => {
    const policy = { model_access_mode: "whitelist" as const, model_list: ["model-x"] };
    expect(modelRejectionReason(policy, "provider/model-x", "provider", "model-x")).toBeNull();
    expect(modelRejectionReason(policy, "agg/up/model-x", "agg", "model-x")).toBeNull();
  });

  test("a listed qualified request authorizes its target", () => {
    const policy = { model_access_mode: "whitelist" as const, model_list: ["provider/model-x"] };
    expect(
      modelRejectionReason(policy, "provider/model-x", "provider", "provider/model-x"),
    ).toBeNull();
  });
});
