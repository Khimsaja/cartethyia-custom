import { describe, expect, test } from "bun:test";
import { raisedEffortOutputFloor } from "../../src/providers/provider-reasoning";

describe("raised effort output floor", () => {
  test("a raised effort earns a bigger budget", () => {
    expect(raisedEffortOutputFloor("low", "high", 64_000)).toBe(32_000);
  });

  test("an effort that was left alone earns nothing", () => {
    expect(raisedEffortOutputFloor("low", "low", 64_000)).toBeUndefined();
    expect(raisedEffortOutputFloor("high", "high", 64_000)).toBeUndefined();
  });

  test("an effort clamped downward earns nothing", () => {
    // A lower level spends less on reasoning, so the caller's own number
    // still fits.
    expect(raisedEffortOutputFloor("max", "high", 64_000)).toBeUndefined();
  });

  test("the floor is half the declared limit once that clears the minimum", () => {
    expect(raisedEffortOutputFloor("low", "high", 200_000)).toBe(100_000);
    expect(raisedEffortOutputFloor("low", "high", 1_000_000)).toBe(500_000);
    expect(raisedEffortOutputFloor("low", "high", 64_000)).toBe(32_000);
  });

  test("a small declared limit still yields a usable floor", () => {
    // Half of a tiny limit would still truncate; the floor is the useful
    // minimum instead.
    expect(raisedEffortOutputFloor("low", "high", 4_000)).toBe(16_384);
  });

  test("an unknown level or missing limit yields no floor", () => {
    expect(raisedEffortOutputFloor("low", "banana", 64_000)).toBeUndefined();
    expect(raisedEffortOutputFloor(undefined, "high", 64_000)).toBeUndefined();
    expect(raisedEffortOutputFloor("low", "high", undefined)).toBeUndefined();
    expect(raisedEffortOutputFloor("low", "high", 0)).toBeUndefined();
  });

  test("comparison is case and whitespace insensitive", () => {
    expect(raisedEffortOutputFloor(" LOW ", "High", 64_000)).toBe(32_000);
  });
});
