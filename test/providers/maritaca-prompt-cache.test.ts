/**
 * Maritaca rejects any `prompt_cache_key` with 422 `extra_forbidden`
 * (verified live 2026-11-17, request de7043d4; the same 422 cluster appeared
 * 2026-11-14). The gateway derives the key from the first message when it is
 * long enough (`aff_<sha256>`), so the Model Lab system persona — and any
 * real request with a long first message — always carries one.
 *
 * The provider row already declared `prompt_cache: false` (6 Nov), but the
 * flag had no reader on the BYOK path: the generic adapter always forwarded
 * the key. These cases pin the wire boundary — what actually leaves the
 * gateway — for both adapter shapes. The profile-to-config mapping itself
 * (`registerByokProviders`) is proven by the live deploy check, not here:
 * no test drives that registration path today.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import { validateCompatibilityProfile } from "../../src/console/providers/catalog/contracts-validators";
import { OpenAICompatibleAdapter } from "../../src/providers/adapters/compatible-adapter";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/provider-contracts";
import { parseCustomProviderId } from "../../src/providers/provider-contracts";

// Long enough (>= 30 chars) that resolvePromptCacheKey derives an `aff_` key
// from it, exactly like the Model Lab system persona did live.
const LONG_FIRST_MESSAGE =
  "## Cartethyia Model Lab persona\nYou are Cartethyia, an AI assistant in Cartethyia Model Lab.";

const makeRequest = (temperature?: number) =>
  ({
    model: "S5-free",
    messages: [
      { role: "system", content: [{ kind: "text", text: LONG_FIRST_MESSAGE }] },
      { role: "user", content: [{ kind: "text", text: "pong" }] },
    ],
    generation_controls: temperature === undefined ? {} : { temperature },
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

const defaultAdapter = new ExposedAdapter({
  provider_id: parseCustomProviderId("maritaca"),
  base_url: "https://chat.maritaca.ai/api/v1",
  authentication_header_shape: "authorization_bearer",
});

const noCacheAdapter = new ExposedAdapter({
  provider_id: parseCustomProviderId("maritaca"),
  base_url: "https://chat.maritaca.ai/api/v1",
  authentication_header_shape: "authorization_bearer",
  supports_prompt_caching: false,
});

describe("Maritaca prompt-cache key", () => {
  test("default adapter sends the derived aff_ cache key (the 422 trigger)", async () => {
    const payload = (await defaultAdapter.exposePreparePayload(
      makeRequest(),
      makeCandidate("maritaca"),
      context,
    )) as Record<string, unknown>;

    expect(typeof payload["prompt_cache_key"]).toBe("string");
    expect(String(payload["prompt_cache_key"]).startsWith("aff_")).toBe(true);
  });

  test("supports_prompt_caching false drops the key from the wire payload", async () => {
    const payload = (await noCacheAdapter.exposePreparePayload(
      makeRequest(),
      makeCandidate("maritaca"),
      context,
    )) as Record<string, unknown>;

    expect("prompt_cache_key" in payload).toBe(false);
  });

  test("maritaca prod shape: temperature 1 and no cache key at once", async () => {
    const payload = (await noCacheAdapter.exposePreparePayload(
      makeRequest(0.2),
      makeCandidate("maritaca"),
      context,
    )) as Record<string, unknown>;

    expect(payload["temperature"]).toBe(1);
    expect("prompt_cache_key" in payload).toBe(false);
  });

  test("validator accepts prompt_cache false and rejects a non-boolean", () => {
    expect(() => validateCompatibilityProfile({ prompt_cache: false })).not.toThrow();
    expect(() => validateCompatibilityProfile({ prompt_cache: true })).not.toThrow();
    expect(() =>
      validateCompatibilityProfile({ prompt_cache: "no" as unknown as boolean }),
    ).toThrow(/prompt_cache must be boolean/);
  });
});
