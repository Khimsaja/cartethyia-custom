/**
 * Maritaca per-request input cap.
 *
 * The cap is an operator policy (32,768 estimated input tokens per request
 * for every Maritaca model), not the model's 1M-token window: one 90k-token
 * request ate 35% of an account's 256k input TPM on 12 Nov 2026 and
 * rate-limited 80 accounts. These tests pin the policy table and its
 * boundary; the live deploy check proves the preparer enforces it.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_INPUT_TOKENS_BY_PROVIDER,
  inputLimitExceeded,
  maxInputTokensFor,
} from "../../src/transport/request/input-limits";

describe("maritaca input cap", () => {
  test("maritaca is capped at 32,768 estimated input tokens", () => {
    expect(maxInputTokensFor("maritaca")).toBe(32_768);
    expect(MAX_INPUT_TOKENS_BY_PROVIDER["maritaca"]).toBe(32_768);
  });

  test("other providers are uncapped", () => {
    for (const provider of ["deepai", "coarena", "qoder", "plamo", "inferhub"]) {
      expect(maxInputTokensFor(provider)).toBeUndefined();
      expect(inputLimitExceeded(200_000, provider)).toBeNull();
    }
  });

  test("exactly at the cap passes, one token over is rejected", () => {
    expect(inputLimitExceeded(32_768, "maritaca")).toBeNull();
    expect(inputLimitExceeded(32_769, "maritaca")).toBe(32_768);
  });

  test("the observed abuse shapes are rejected", () => {
    // 12 Nov 2026 burst: ~90k-token requests every ~15s.
    expect(inputLimitExceeded(90_292, "maritaca")).toBe(32_768);
    // The operator's example error: 146,367 input tokens requested.
    expect(inputLimitExceeded(146_367, "maritaca")).toBe(32_768);
  });

  test("normal traffic passes", () => {
    expect(inputLimitExceeded(226, "maritaca")).toBeNull();
    expect(inputLimitExceeded(20_000, "maritaca")).toBeNull();
  });
});
