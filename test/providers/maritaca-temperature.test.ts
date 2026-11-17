import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import { applyParamQuirks, hasParamQuirk } from "../../src/protocol/translation/quirks";
import { OpenAICompatibleAdapter } from "../../src/providers/adapters/compatible-adapter";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/provider-contracts";
import { parseCustomProviderId } from "../../src/providers/provider-contracts";

const makeRequest = (temperature?: number) =>
  ({
    model: "S5-free",
    messages: [{ role: "user", content: [{ kind: "text", text: "Hi." }] }],
    generation_controls: temperature === undefined ? {} : { temperature, top_p: 0.8 },
    source_surface: "chat",
    stream: false,
  }) as unknown as CanonicalRequest;

const makeCandidate = (providerId: string) =>
  ({
    provider_id: providerId,
    model_id: "S5-free",
    wire_family: "chat",
    endpoint_path: "/chat/completions",
    capabilities: {},
  }) as unknown as ProviderDispatchTarget;

const context = {
  credential: { kind: "api_key", secret: "test" },
  deadline: Date.now() + 60_000,
  abort_signal: new AbortController().signal,
} as unknown as ProviderDispatchContext;

class ExposedAdapter extends OpenAICompatibleAdapter {
  exposePreparePayload(
    request: CanonicalRequest,
    target: ProviderDispatchTarget,
    ctx: ProviderDispatchContext,
  ) {
    return this.preparePayload(request, target, ctx);
  }
}

const maritacaAdapter = new ExposedAdapter({
  provider_id: parseCustomProviderId("maritaca"),
  base_url: "https://chat.maritaca.ai/api/v1",
  authentication_header_shape: "authorization_bearer",
  supports_prompt_caching: false,
});

describe("Maritaca temperature override", () => {
  test("forces temperature to 1, overriding the caller's value", () => {
    const request = makeRequest(0.2);
    const forced = applyParamQuirks(request, "maritaca", "chat");

    expect(forced.generation_controls.temperature).toBe(1);
    expect(forced.generation_controls.top_p).toBe(0.8);
    expect(request.generation_controls.temperature).toBe(0.2);
  });

  test("forces temperature to 1 when the caller sent none", () => {
    const forced = applyParamQuirks(makeRequest(), "maritaca", "chat");
    expect(forced.generation_controls.temperature).toBe(1);
  });

  test("hasParamQuirk matches maritaca and no unlisted provider", () => {
    expect(hasParamQuirk("maritaca", "S5-free")).toBe(true);
    expect(hasParamQuirk("deepai", "S5-free")).toBe(false);
  });

  test("unlisted providers are returned untouched", () => {
    const request = makeRequest(0.2);
    expect(applyParamQuirks(request, "deepai", "chat")).toBe(request);
  });

  test("generic adapter emits temperature 1 for maritaca", async () => {
    const payload = (await maritacaAdapter.exposePreparePayload(
      makeRequest(0.2),
      makeCandidate("maritaca"),
      context,
    )) as Record<string, unknown>;

    expect(payload["temperature"]).toBe(1);
  });

  test("generic adapter leaves other providers alone", async () => {
    const payload = (await maritacaAdapter.exposePreparePayload(
      makeRequest(0.2),
      makeCandidate("deepai"),
      context,
    )) as Record<string, unknown>;

    expect(payload["temperature"]).toBe(0.2);
  });
});
