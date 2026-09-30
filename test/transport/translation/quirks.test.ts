import { describe, expect, test } from "bun:test";
import {
  applyParamQuirks,
  findParamQuirk,
  rejectsSamplingParams,
} from "../../../src/transport/translation/quirks";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";

function requestWith(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    // Opus 4.7+ is the generation that rejects sampling; 4.6 and earlier accept it.
    model: "claude-opus-4-7",
    stream: false,
    messages: [],
    generation_controls: {
      temperature: 0.7,
      max_tokens: 8192,
    },
    ...overrides,
  } as CanonicalRequest;
}

describe("rejectsSamplingParams", () => {
  test("opus turns strict at 4.7", () => {
    expect(rejectsSamplingParams("claude-opus-4-6")).toBe(false);
    expect(rejectsSamplingParams("claude-opus-4-5")).toBe(false);
    expect(rejectsSamplingParams("claude-opus-4-7")).toBe(true);
    expect(rejectsSamplingParams("claude-opus-4-8")).toBe(true);
    expect(rejectsSamplingParams("claude-opus-5")).toBe(true);
    expect(rejectsSamplingParams("claude-opus-5-5")).toBe(true);
  });

  test("sonnet/fable/mythos turn strict at 5", () => {
    expect(rejectsSamplingParams("claude-sonnet-4-6")).toBe(false);
    expect(rejectsSamplingParams("claude-sonnet-4-5")).toBe(false);
    expect(rejectsSamplingParams("claude-sonnet-5")).toBe(true);
    expect(rejectsSamplingParams("claude-fable-5")).toBe(true);
    expect(rejectsSamplingParams("claude-fable-5-1")).toBe(true);
    expect(rejectsSamplingParams("claude-mythos-5")).toBe(true);
  });

  test("a family or name with no parseable generation is left alone", () => {
    // haiku accepts sampling; a dated snapshot or reseller alias reports no
    // generation and must not be stripped on a guess.
    expect(rejectsSamplingParams("claude-haiku-4-5")).toBe(false);
    expect(rejectsSamplingParams("claude-3-7-sonnet")).toBe(false);
    expect(rejectsSamplingParams("claude-haiku-4-5-20251001")).toBe(false);
    expect(rejectsSamplingParams("gpt-5")).toBe(false);
  });
});

describe("applyParamQuirks", () => {
  test("strips sampling params for a generation that rejects them", () => {
    const request = requestWith();
    const next = applyParamQuirks(request, "anthropic");
    expect(next.generation_controls.temperature).toBeUndefined();
    expect(next.generation_controls.max_tokens).toBe(8192);
    // Original request untouched.
    expect(request.generation_controls.temperature).toBe(0.7);
  });

  test("keeps sampling params on an older generation that accepts them", () => {
    // `claude-opus-4-6` takes temperature; stripping it would silently change
    // the caller's request on a model that never objected to it.
    const request = requestWith({ model: "claude-opus-4-6" });
    expect(applyParamQuirks(request, "anthropic")).toBe(request);
  });

  test("applies to the Claude Code OAuth provider id too", () => {
    const request = requestWith({ model: "claude-opus-4-7" });
    const next = applyParamQuirks(request, "claude");
    expect(next.generation_controls.temperature).toBeUndefined();
  });

  test("leaves non-matching providers untouched", () => {
    const request = requestWith();
    expect(applyParamQuirks(request, "mistral")).toBe(request);
  });

  test("model matcher limits the quirk to claude models", () => {
    const nonClaude = requestWith({ model: "gpt-5" });
    expect(applyParamQuirks(nonClaude, "anthropic")).toBe(nonClaude);
  });

  test("returns the original reference when nothing changed", () => {
    const noControls = requestWith({
      generation_controls: { max_tokens: 100 },
    });
    expect(applyParamQuirks(noControls, "anthropic")).toBe(noControls);
  });

  test("findParamQuirk matches provider and the generation predicate", () => {
    expect(findParamQuirk("anthropic", "claude-opus-4-7")).toBeDefined();
    expect(findParamQuirk("claude", "claude-sonnet-5")).toBeDefined();
    // Older generations accept sampling, so no quirk applies.
    expect(findParamQuirk("anthropic", "claude-sonnet-4-6")).toBeUndefined();
    expect(findParamQuirk("anthropic", "gpt-5")).toBeUndefined();
    expect(findParamQuirk("zai", "claude-like-model")).toBeUndefined();
  });
});
