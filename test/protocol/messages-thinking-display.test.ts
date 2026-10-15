/**
 * `thinking.display` on the Messages surface.
 *
 * `updates` asks the upstream to stream raw thinking increments instead of a
 * summary, under a beta (`thinking-display-updates-2026-08-18`) this gateway
 * does not negotiate. Those increments are a different response shape with no
 * decoder here, so the choice was between refusing the request and answering
 * with thinking content that arrives broken.
 *
 * Refusing was right while the caller could change its request. A CLI that
 * sends this value unconditionally simply cannot use the endpoint at all —
 * which is how this surfaced: every request from one client failed at parse
 * with a 400, in under a second, before any provider was dialed.
 *
 * So a beta-only value now degrades to `summarized`: the caller gets readable
 * thinking rather than an error or an empty block. Two things are deliberately
 * preserved — an explicit `omitted` is still honored (degrading it to a summary
 * would show thinking the caller asked not to see), and a value that is merely
 * unknown is still rejected (degrading a typo would hide it).
 */
import { describe, expect, test } from "bun:test";
import { parseThinking } from "../../src/transport/surface/messages/parse";

const MODEL = "bansos/deepseek-v4.1-flash";

function displayOf(thinking: unknown): string | null {
  const parsed = parseThinking(thinking, MODEL, {}, 32000);
  return parsed?.display ?? null;
}

describe("thinking.display degradation", () => {
  test("updates degrades to summarized instead of failing", () => {
    // The reported failure: adaptive + updates + effort was refused outright.
    expect(displayOf({ type: "adaptive", display: "updates" })).toBe("summarized");
  });

  test("degrading keeps the requested thinking type", () => {
    // Only the display policy degrades; adaptive must not become budget-era.
    const parsed = parseThinking({ type: "adaptive", display: "updates" }, MODEL, {}, 32000);
    expect(parsed?.thinking_type).toBe("adaptive");
  });

  test("an explicit omitted is still honored", () => {
    // Not inverted: `updates` asks for more thinking, so it must not degrade
    // to the value that hides thinking.
    expect(displayOf({ type: "adaptive", display: "omitted" })).toBe("omitted");
  });

  test("an explicit summarized is left alone", () => {
    expect(displayOf({ type: "adaptive", display: "summarized" })).toBe("summarized");
  });

  test("no display stays absent", () => {
    // Left to the encoder's default rather than invented here.
    expect(displayOf({ type: "adaptive" })).toBeNull();
  });

  test("a disabled intent that names updates still parses", () => {
    expect(displayOf({ type: "disabled", display: "updates" })).toBe("summarized");
  });
});

describe("thinking.display rejection", () => {
  test("an unknown value is still refused", () => {
    // Degrading a typo would hide the caller's mistake.
    expect(() => parseThinking({ type: "adaptive", display: "bogus" }, MODEL, {}, 32000)).toThrow(
      /must be summarized or omitted/,
    );
  });

  test("the rejection names the value the caller sent", () => {
    // An operator needs to know what arrived, not just which two are allowed.
    let message = "";
    try {
      parseThinking({ type: "adaptive", display: "bogus" }, MODEL, {}, 32000);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("bogus");
  });

  test("an unknown value is not silently coerced", () => {
    // The regression that matters: only the known beta-only value degrades.
    expect(() => parseThinking({ type: "adaptive", display: "Updates" }, MODEL, {}, 32000)).toThrow();
  });
});
