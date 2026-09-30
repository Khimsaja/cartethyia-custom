import { describe, expect, test } from "bun:test";
import {
  budgetToLevel,
  clampReasoningEffort,
  claudeUsesAdaptiveThinking,
  formatThinkingSuffix,
  LEVEL_TO_BUDGET,
  normalizeThinkingConfig,
  parseThinkingSuffix,
  resolveSupportedReasoningEfforts,
  RESPONSES_WIRE_SUPPORTED_EFFORTS,
  EXTENDED_SUPPORTED_EFFORTS,
  withThinkingSuffixIntent,
} from "../../../src/transport/translation/thinking";
import type { CanonicalMessage, CanonicalRequest } from "../../../src/transport/canonical-model";

function requestWith(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "test-model",
    messages: [],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...overrides,
  } as CanonicalRequest;
}

const userTurn: CanonicalMessage = { role: "user", content: [{ kind: "text", text: "hi" }] };
const assistantTurn: CanonicalMessage = {
  role: "assistant",
  content: [{ kind: "text", text: "ok" }],
};
const toolTurn: CanonicalMessage = {
  role: "tool",
  content: [{ kind: "toolResult", call_id: "call_1", content: "done" }],
};

describe("normalizeThinkingConfig", () => {
  test("drops native thinking config when the last message is not user", () => {
    const request = requestWith({
      messages: [userTurn, assistantTurn],
      reasoning: { thinking_type: "enabled", budget_tokens: 5000, effort: "high" },
    });
    const next = normalizeThinkingConfig(request);
    expect(next.reasoning?.thinking_type).toBeUndefined();
    expect(next.reasoning?.budget_tokens).toBeUndefined();
    // Request-level effort survives a tool-result turn.
    expect(next.reasoning?.effort).toBe("high");
    // Input untouched.
    expect(request.reasoning?.thinking_type).toBe("enabled");
    expect(request.reasoning?.budget_tokens).toBe(5000);
  });

  test("preserves native thinking config when history replays thinking blocks", () => {
    const assistantWithThinking: CanonicalMessage = {
      role: "assistant",
      content: [
        { kind: "reasoning", payload: null, signature: "sig_abc", opaque: true },
        { kind: "text", text: "ok" },
      ],
    };
    const request = requestWith({
      messages: [userTurn, assistantWithThinking, toolTurn],
      reasoning: { thinking_type: "enabled", budget_tokens: 5000 },
    });
    // Signed blocks cannot be replayed without the thinking config, so the
    // drop is suppressed even on a tool-result turn.
    expect(normalizeThinkingConfig(request)).toBe(request);
  });

  test("preserves thinking config when the last message is user", () => {
    const request = requestWith({
      messages: [userTurn],
      reasoning: { thinking_type: "enabled", budget_tokens: 5000 },
    });
    expect(normalizeThinkingConfig(request)).toBe(request);
  });

  test("returns the same reference when only effort is present", () => {
    const request = requestWith({
      messages: [assistantTurn],
      reasoning: { effort: "medium" },
    });
    expect(normalizeThinkingConfig(request)).toBe(request);
  });

  test("returns the same reference when there is no reasoning intent", () => {
    const request = requestWith({ messages: [assistantTurn] });
    expect(normalizeThinkingConfig(request)).toBe(request);
  });

  test("keeps unrelated reasoning fields", () => {
    const request = requestWith({
      messages: [toolTurn],
      reasoning: { thinking_type: "adaptive", budget_tokens: 1000, context: "all_turns" },
    });
    const next = normalizeThinkingConfig(request);
    expect(next.reasoning?.context).toBe("all_turns");
    expect(next.reasoning?.thinking_type).toBeUndefined();
  });

  test("normalizes effort when target options are provided", () => {
    const request = requestWith({
      model: "muse-spark-1.3-contributor-free",
      messages: [userTurn],
      reasoning: { effort: "max" },
    });
    const next = normalizeThinkingConfig(request, { wireFamily: "responses" });
    expect(next.reasoning?.effort).toBe("xhigh");
  });
});

describe("clampReasoningEffort", () => {
  test("returns undefined when requested effort is undefined or empty", () => {
    expect(clampReasoningEffort(undefined, RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBeUndefined();
    expect(clampReasoningEffort("", RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBeUndefined();
  });

  test("normalizes off and none to undefined", () => {
    expect(clampReasoningEffort("none", RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBeUndefined();
    expect(clampReasoningEffort("off", RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBeUndefined();
  });

  test("leaves supported effort untouched", () => {
    expect(clampReasoningEffort("high", RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBe("high");
    expect(clampReasoningEffort("xhigh", RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBe("xhigh");
    expect(clampReasoningEffort("low", RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBe("low");
  });

  test("clamps max down to xhigh when max is not supported", () => {
    expect(clampReasoningEffort("max", RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBe("xhigh");
  });

  test("allows max when max is in the supported ladder", () => {
    expect(clampReasoningEffort("max", EXTENDED_SUPPORTED_EFFORTS)).toBe("max");
  });

  test("normalizes ultra to max or clamped ceiling", () => {
    expect(clampReasoningEffort("ultra", EXTENDED_SUPPORTED_EFFORTS)).toBe("max");
    expect(clampReasoningEffort("ultra", RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBe("xhigh");
  });

  test("floors up to model minimum if requested effort is below supported minimum", () => {
    const highOnlyLadder = ["high", "max"] as const;
    expect(clampReasoningEffort("low", highOnlyLadder)).toBe("high");
  });
});

describe("resolveSupportedReasoningEfforts", () => {
  test("explicitly declared catalog efforts take precedence", () => {
    const custom = ["low", "high"] as const;
    expect(resolveSupportedReasoningEfforts("any-model", "chat", custom)).toEqual(["low", "high"]);
  });

  test("responses wire defaults to 5-tier scale without max", () => {
    expect(resolveSupportedReasoningEfforts("some-model", "responses")).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("frontier models on responses wire keep max support", () => {
    expect(resolveSupportedReasoningEfforts("gpt-5.6-sol", "responses")).toContain("max");
    expect(resolveSupportedReasoningEfforts("gpt-6-astra", "responses")).toContain("max");
  });

  test("gemini models resolve to 4-tier base scale", () => {
    expect(resolveSupportedReasoningEfforts("gemini-3-flash", "chat")).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  test("claude / mimo / deepseek resolve to extended scale with max", () => {
    expect(resolveSupportedReasoningEfforts("", "chat")).toContain("max");
    expect(resolveSupportedReasoningEfforts("mimo-v2.5-free", "chat")).toContain("max");
    expect(resolveSupportedReasoningEfforts("deepseek-v4-flash", "chat")).toContain("max");
  });

  test("mimo-v2.6 excludes the tiers upstream answers with an opaque 500", () => {
    // Regression: the generic default handed this family `xhigh`, and OpenCode's
    // /zen/v1 answers `xhigh`, `max`, and `minimal` with a bare
    // `500 Internal server error` that names no parameter — the request simply
    // died. Its siblings on the same endpoint accept the full ladder, so the
    // narrowing is per model.
    const supported = resolveSupportedReasoningEfforts("mimo-v2.6-flash-free", "chat");
    expect(supported).toEqual(["low", "medium", "high"]);
    expect(supported).not.toContain("xhigh");
    expect(supported).not.toContain("max");
    expect(supported).not.toContain("minimal");
  });

  test("a caller-requested xhigh on mimo-v2.6 lands on an accepted tier", () => {
    const supported = resolveSupportedReasoningEfforts("mimo-v2.6-flash-free", "chat");
    expect(clampReasoningEffort("xhigh", supported)).toBe("high");
    expect(clampReasoningEffort("minimal", supported)).toBe("low");
    // Every value the clamp can return must itself be accepted upstream.
    for (const requested of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      const clamped = clampReasoningEffort(requested, supported);
      if (clamped === undefined) throw new Error(`clamp returned undefined for ${requested}`);
      expect(supported).toContain(clamped);
    }
  });

  test("gpt-5.5 has neither minimal nor max on responses (OMP openai-codex)", () => {
    expect(resolveSupportedReasoningEfforts("gpt-5.5", "responses")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("OpenAI 5.6/6/6.1 rows take max without minimal (OMP catalog)", () => {
    for (const id of [
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-6.1-sol",
    ]) {
      expect(resolveSupportedReasoningEfforts(id, "responses")).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    }
  });

  test("Claude ladders follow the published anthropic catalog", () => {
    // The 4.6 adaptive pair stops at high.
    expect(resolveSupportedReasoningEfforts("claude-sonnet-4-6", "chat")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    // Budget-era rows keep minimal and stop at xhigh.
    const budget = resolveSupportedReasoningEfforts("claude-sonnet-4-5", "chat");
    expect(budget).toContain("minimal");
    expect(budget).not.toContain("max");
    // New-gen adaptive rows take max without minimal.
    const modern = resolveSupportedReasoningEfforts("claude-mythos-5", "chat");
    expect(modern).toContain("max");
    expect(modern).not.toContain("minimal");
    // Gateway-prefixed dot form resolves to the same ladder.
    expect(resolveSupportedReasoningEfforts("cb/claude-opus-4.6", "chat")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("parseThinkingSuffix", () => {
  test("leaves a plain model name untouched", () => {
    expect(parseThinkingSuffix("claude-opus-4-6")).toEqual({
      model: "claude-opus-4-6",
      intent: null,
    });
  });

  test("reads each ladder level off the model name", () => {
    const levels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
    for (const level of levels) {
      expect(parseThinkingSuffix(`m(${level})`)).toEqual({
        model: "m",
        intent: { mode: "level", level },
      });
    }
  });

  test("is case-insensitive and tolerates whitespace", () => {
    expect(parseThinkingSuffix("m(HIGH)")).toEqual({
      model: "m",
      intent: { mode: "level", level: "high" },
    });
    expect(parseThinkingSuffix("m( high )")).toEqual({
      model: "m",
      intent: { mode: "level", level: "high" },
    });
  });

  test("maps none/off and auto", () => {
    expect(parseThinkingSuffix("m(none)").intent).toEqual({ mode: "none" });
    expect(parseThinkingSuffix("m(off)").intent).toEqual({ mode: "none" });
    expect(parseThinkingSuffix("m(auto)").intent).toEqual({ mode: "auto" });
  });

  test("treats ultra as the top tier, matching the clamp synonym", () => {
    expect(parseThinkingSuffix("m(ultra)").intent).toEqual({ mode: "level", level: "max" });
  });

  test("reads a numeric suffix as a token budget", () => {
    expect(parseThinkingSuffix("m(8192)").intent).toEqual({ mode: "budget", budget: 8192 });
  });

  test("ignores an unrecognized or empty value so a typo cannot fail a request", () => {
    expect(parseThinkingSuffix("m(bogus)")).toEqual({ model: "m(bogus)", intent: null });
    expect(parseThinkingSuffix("m()")).toEqual({ model: "m()", intent: null });
    expect(parseThinkingSuffix("m(0)")).toEqual({ model: "m(0)", intent: null });
  });

  test("rejects nested parentheses rather than mis-parsing them", () => {
    expect(parseThinkingSuffix("m((high))")).toEqual({ model: "m((high))", intent: null });
  });

  test("leaves a bare suffix alone so the caller gets model-not-found", () => {
    expect(parseThinkingSuffix("(high)")).toEqual({ model: "(high)", intent: null });
  });

  test("does not touch the model ids a dash suffix would have broken", () => {
    // The reason this syntax is parentheses: each of these is a real model id
    // whose dash-suffix truncation would be another real model id.
    for (const id of [
      "gemini-3.1-pro-high",
      "gpt-5.1-codex-max",
      "o3-mini-high",
      "qwen-max",
      "mistral-medium",
    ]) {
      expect(parseThinkingSuffix(id)).toEqual({ model: id, intent: null });
    }
  });
});

/**
 * `formatThinkingSuffix` is the writer half of the same rule, used to render the
 * routable id in the dashboard. The property that matters is round-trip: whatever
 * it writes, `parseThinkingSuffix` must read back as the same level — otherwise
 * the id the operator copies would route differently than the one shown.
 */
describe("formatThinkingSuffix", () => {
  test("leaves the model bare when no level was chosen", () => {
    expect(formatThinkingSuffix("claude-sonnet-4-5", null)).toBe("claude-sonnet-4-5");
  });

  test("writes each ladder level and auto/none as a parenthesized suffix", () => {
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(formatThinkingSuffix("m", level)).toBe(`m(${level})`);
    }
    expect(formatThinkingSuffix("m", "auto")).toBe("m(auto)");
    expect(formatThinkingSuffix("m", "none")).toBe("m(none)");
  });

  test("round-trips every level through the parser", () => {
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      const written = formatThinkingSuffix("claude-sonnet-4-5", level);
      expect(parseThinkingSuffix(written)).toEqual({
        model: "claude-sonnet-4-5",
        intent: { mode: "level", level },
      });
    }
    expect(parseThinkingSuffix(formatThinkingSuffix("m", "auto")).intent).toEqual({ mode: "auto" });
    expect(parseThinkingSuffix(formatThinkingSuffix("m", "none")).intent).toEqual({ mode: "none" });
  });
});

describe("budgetToLevel", () => {
  test("returns null for a non-positive or non-finite budget", () => {
    expect(budgetToLevel(0)).toBeNull();
    expect(budgetToLevel(-1)).toBeNull();
    expect(budgetToLevel(Number.NaN)).toBeNull();
  });

  test("reads each tier at its own boundary", () => {
    expect(budgetToLevel(512)).toBe("minimal");
    expect(budgetToLevel(768)).toBe("minimal");
    expect(budgetToLevel(1024)).toBe("low");
    expect(budgetToLevel(4096)).toBe("low");
    expect(budgetToLevel(8192)).toBe("medium");
    expect(budgetToLevel(16384)).toBe("medium");
    expect(budgetToLevel(24576)).toBe("high");
    expect(budgetToLevel(32768)).toBe("xhigh");
    expect(budgetToLevel(128000)).toBe("max");
    expect(budgetToLevel(1_000_000)).toBe("max");
  });

  test("round-trips every ladder level through its own budget", () => {
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(budgetToLevel(LEVEL_TO_BUDGET[level])).toBe(level);
    }
  });
});

describe("withThinkingSuffixIntent", () => {
  test("writes a level onto the reasoning intent", () => {
    const next = withThinkingSuffixIntent(requestWith(), { mode: "level", level: "high" });
    expect(next.reasoning?.effort).toBe("high");
  });

  test("normalizes a numeric budget to its nearest tier", () => {
    const next = withThinkingSuffixIntent(requestWith(), { mode: "budget", budget: 8192 });
    expect(next.reasoning?.effort).toBe("medium");
    // The raw budget must not survive: the tier is what the per-model clamp
    // understands, so carrying both would let them disagree.
    expect(next.reasoning?.budget_tokens).toBeUndefined();
  });

  test("none disables thinking explicitly instead of merely clearing effort", () => {
    const next = withThinkingSuffixIntent(
      requestWith({ reasoning: { effort: "max" } }),
      { mode: "none" },
    );
    expect(next.reasoning?.thinking_type).toBe("disabled");
    expect(next.reasoning?.effort).toBeUndefined();
  });

  test("auto clears the effort and un-disables thinking", () => {
    const next = withThinkingSuffixIntent(
      requestWith({ reasoning: { effort: "low", thinking_type: "disabled" } }),
      { mode: "auto" },
    );
    expect(next.reasoning?.effort).toBeUndefined();
    expect(next.reasoning?.thinking_type).toBeUndefined();
  });

  test("overrides an effort the body already carried", () => {
    const next = withThinkingSuffixIntent(
      requestWith({ reasoning: { effort: "low" } }),
      { mode: "level", level: "max" },
    );
    expect(next.reasoning?.effort).toBe("max");
  });

  test("leaves unrelated reasoning fields alone", () => {
    const next = withThinkingSuffixIntent(
      requestWith({ reasoning: { summary_mode: "detailed" } }),
      { mode: "level", level: "low" },
    );
    expect(next.reasoning?.summary_mode).toBe("detailed");
    expect(next.reasoning?.effort).toBe("low");
  });

  test("drops the reasoning block entirely when nothing remains", () => {
    const next = withThinkingSuffixIntent(requestWith(), { mode: "auto" });
    expect(next.reasoning).toBeUndefined();
  });

  test("a suffix level flows through the existing per-model clamp", () => {
    // The global/canonical layer sets the ask; the clamp is what makes one
    // suffix mean the right thing on each model. mimo-v2.6 tops out at `high`.
    const applied = withThinkingSuffixIntent(requestWith(), { mode: "level", level: "max" });
    const supported = resolveSupportedReasoningEfforts("mimo-v2.6", "chat");
    expect(clampReasoningEffort(applied.reasoning?.effort, supported)).toBe("high");
  });
});

/**
 * Which Claude generation a model belongs to decides the `thinking` wire shape
 * (adaptive vs budget). The rule lives here so the codec and the effort ladder
 * cannot disagree — an adaptive shape on a budget-era model is a hard 400.
 */
describe("claudeUsesAdaptiveThinking", () => {
  test("adaptive era: Opus 4.6+, Sonnet 4.6+, and the 5-series", () => {
    for (const id of [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-mythos-5",
    ]) {
      expect({ id, adaptive: claudeUsesAdaptiveThinking(id) }).toEqual({ id, adaptive: true });
    }
  });

  test("budget era: 4.5-and-older", () => {
    for (const id of [
      "claude-opus-4-5",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
      "claude-opus-4-1",
      "claude-opus-4-0",
      "claude-sonnet-4-0",
      "claude-3-7-sonnet",
    ]) {
      expect({ id, adaptive: claudeUsesAdaptiveThinking(id) }).toEqual({ id, adaptive: false });
    }
  });

  test("is dot-tolerant for gateway-prefixed ids", () => {
    expect(claudeUsesAdaptiveThinking("cb/claude-opus-4.6")).toBe(true);
    expect(claudeUsesAdaptiveThinking("cb/claude-opus-4.5")).toBe(false);
  });
});
