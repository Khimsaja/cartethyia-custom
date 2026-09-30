import { describe, expect, test } from "bun:test";
import { OPENROUTER_MODELS, OPENROUTER_SPEC } from "../../../src/providers/integrations/openrouter";

/**
 * OpenRouter fronts the System One decision API as `typesafe/jev-1.13`. It is
 * not a chat model: it answers `{answers}` to a `{state, questions}` body. The
 * catalog must mark it `systemone` and point it at the native `/systemone`
 * endpoint, so the chat surface never sees it and the native route does.
 */
describe("OpenRouter catalog", () => {
  test("declares the System One decision model as a native-service row", () => {
    const jev = OPENROUTER_MODELS.find((model) => model.modelId === "typesafe/jev-1.13");
    expect(jev).toBeDefined();
    expect(jev?.serviceKind).toBe("systemone");
    expect(jev?.endpointPath).toBe("/systemone");
    // A decision model has no chat tool surface.
    expect(jev?.toolCall).toBe(false);
  });

  test("keeps the OpenRouter attribution headers on every dispatch", () => {
    // These are required by OpenRouter for ranking/attribution; the native
    // systemone dispatch shares the same header set as the chat wire.
    expect(OPENROUTER_SPEC.extra_headers).toMatchObject({
      "HTTP-Referer": "https://endpoint-proxy.local",
      "X-Title": "Endpoint Proxy",
    });
  });
});
