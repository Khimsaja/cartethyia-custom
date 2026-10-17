/**
 * The OpenCode Free and Zen tiers dispatch on `/inference/v1`, not `/zen/v1`.
 *
 * `/zen/v1/models` publishes the catalog while `/inference/v1/models` answers
 * 404, so the two bases look interchangeable — and they are not. A byte-exact
 * replay against `/inference/v1` returned 200 where `/zen/v1` did not, and the
 * gateway kept failing because every model row carried an explicit `/zen/v1`
 * endpoint, which outranks the per-provider wire-family table at dispatch.
 *
 * Go stays on its own base.
 */
import { describe, expect, test } from "bun:test";
import { providerBaseUrl } from "../../src/providers/provider-metadata";
import {
  OPENCODE_FREE_MODELS,
  OPENCODE_GO_MODELS,
  OPENCODE_ZEN_MODELS,
} from "../../src/providers/integrations/opencode/provider";

function dispatchUrl(providerId: "opencode" | "opencode-zen" | "opencode-go", endpointPath: string): string {
  return providerBaseUrl(providerId).replace(/\/+$/, "") + endpointPath;
}

describe("OpenCode dispatch base", () => {
  test("free and zen models dispatch on /inference/v1", () => {
    for (const model of [...OPENCODE_FREE_MODELS, ...OPENCODE_ZEN_MODELS]) {
      expect(model.endpointPath.startsWith("/inference/v1/")).toBe(true);
    }
  });

  test("a free model lands on the URL a replay proved returns 200", () => {
    const free = OPENCODE_FREE_MODELS.find((model) => model.modelId === "longcat-2.5-preview-free");
    expect(dispatchUrl("opencode", free?.endpointPath ?? "")).toBe(
      "https://opencode.ai/inference/v1/chat/completions",
    );
  });

  test("go keeps its own base", () => {
    for (const model of OPENCODE_GO_MODELS) {
      expect(model.endpointPath.startsWith("/zen/go/v1/")).toBe(true);
    }
  });
});
