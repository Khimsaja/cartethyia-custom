import { describe, expect, test } from "bun:test";
import { formatModelTokens } from "../../src/shared/model-limits";

/**
 * The model-limit formatter shared by the provider catalog card and the public
 * share page. Both read the same catalog numbers, so the two surfaces must
 * render them identically — one owner is what makes that hold.
 */
describe("formatModelTokens", () => {
  test("scales to k above a thousand and to one decimal of M above a million", () => {
    expect(formatModelTokens(400_000)).toBe("400k");
    expect(formatModelTokens(128_000)).toBe("128k");
    expect(formatModelTokens(1_000)).toBe("1k");
    expect(formatModelTokens(1_000_000)).toBe("1.0M");
    expect(formatModelTokens(2_500_000)).toBe("2.5M");
  });

  test("a sub-thousand limit is the plain count", () => {
    expect(formatModelTokens(512)).toBe("512");
    expect(formatModelTokens(0)).toBe("0");
  });

  test("an absent or non-finite limit is an em dash, never a guessed number", () => {
    // A made-up limit looks measured and misleads capacity planning, so the
    // absent case must not borrow a plausible value.
    expect(formatModelTokens(null)).toBe("—");
    expect(formatModelTokens(undefined)).toBe("—");
    expect(formatModelTokens(Number.NaN)).toBe("—");
  });
});
