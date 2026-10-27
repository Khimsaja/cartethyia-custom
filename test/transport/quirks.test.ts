import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import { applyParamQuirks } from "../../src/transport/translation/quirks";

function request(
  provider: string,
  model: string,
  stream: boolean,
  controls: Record<string, unknown>,
): CanonicalRequest {
  void provider;
  return {
    model,
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: controls,
    source_surface: "chat",
    stream,
  } as unknown as CanonicalRequest;
}

describe("inferhub/deepseek parameter quirks", () => {
  test("strips stream_options extensions on a non-streaming call, keeps other controls", () => {
    const out = applyParamQuirks(
      request("inferhub", "deepseek-v4.1-flash-1017", false, {
        "extension:include_usage": true,
        temperature: 0.5,
      }),
      "inferhub",
    );
    expect(out.generation_controls["extension:include_usage"]).toBeUndefined();
    expect(out.generation_controls.temperature).toBe(0.5);
  });

  test("keeps stream_options extensions on a real stream", () => {
    const out = applyParamQuirks(
      request("inferhub", "deepseek-v4.1-flash-1017", true, {
        "extension:include_usage": true,
      }),
      "inferhub",
    );
    expect(out.generation_controls["extension:include_usage"]).toBe(true);
  });

  test("strips logprobs/top_logprobs for inferhub deepseek", () => {
    const out = applyParamQuirks(
      request("inferhub", "deepseek-v4.1-flash-1017", false, {
        logprobs: true,
        top_logprobs: 5,
        max_tokens: 1000,
      }),
      "inferhub",
    );
    expect(out.generation_controls.logprobs).toBeUndefined();
    expect(out.generation_controls.top_logprobs).toBeUndefined();
    expect(out.generation_controls.max_tokens).toBe(1000);
  });

  test("leaves non-deepseek inferhub models untouched", () => {
    const input = request("inferhub", "qwen-3.8-27b", false, {
      "extension:include_usage": true,
      logprobs: true,
    });
    expect(applyParamQuirks(input, "inferhub")).toBe(input);
  });

  test("leaves deepseek on other providers untouched", () => {
    const input = request("cb", "deepseek-v4.1-flash-1017", false, {
      "extension:include_usage": true,
      logprobs: true,
    });
    expect(applyParamQuirks(input, "cb")).toBe(input);
  });

  test("re-applying quirks is idempotent", () => {
    const once = applyParamQuirks(
      request("inferhub", "deepseek-v4.1-flash-1017", false, {
        "extension:include_usage": true,
        logprobs: true,
      }),
      "inferhub",
    );
    expect(applyParamQuirks(once, "inferhub")).toBe(once);
  });
});
