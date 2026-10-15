/**
 * OpenCode Free rewrites the canonical request before it is encoded.
 *
 * `fledge-alpha-free` rejects any temperature outside {0, 0.6, 1} with a 400,
 * and clients send arbitrary values, so the adapter snaps an out-of-set value
 * to the nearest allowed one. A value already in the set must pass through
 * unchanged, and a model that is not restricted must not be touched.
 */
import { describe, expect, test } from "bun:test";
import {
  FREE_AGENT_TOOL_NAMES,
  OPENCODE_FREE_SPEC,
} from "../../src/providers/integrations/opencode/provider";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import { encodeWireRequest } from "../../src/protocol/registry";
import type { ProviderDispatchTarget } from "../../src/providers/provider-contracts";

function request(model: string, temperature: number | undefined): CanonicalRequest {
  return {
    model,
    messages: [],
    stream: true,
    tools: [],
    generation_controls: temperature === undefined ? {} : { temperature },
  } as unknown as CanonicalRequest;
}

const prepare = OPENCODE_FREE_SPEC.prepareRequest!;

describe("OpenCode Free restricted temperature", () => {
  test("builds and forwards the default agent tools when the client sends none", async () => {
    const prepared = prepare({
      ...request("opencodeft/muse-spark-1.3-contributor-free", undefined),
      stream: false,
      tools: [],
    });
    const candidate: ProviderDispatchTarget = {
      provider_id: "opencodeft",
      model_id: "muse-spark-1.3-contributor-free",
      wire_family: "responses",
      endpoint_path: "/v1/responses",
      capabilities: {},
    };
    const payload = await encodeWireRequest("responses", prepared);
    OPENCODE_FREE_SPEC.prePayload?.(payload, prepared, candidate);

    // The gate refuses stream:false on free models, so the wire body is forced
    // to stream regardless of what the caller asked for. The client-visible
    // contract is left alone, which is why prepared.stream stays false.
    expect(payload.stream).toBe(true);
    // The full agent set, not just two: the free-tier gate reads the set, and a
    // five-tool subset still answered 403. Asserted against the source list so
    // the two cannot drift apart.
    expect(prepared.tools?.map((tool) => tool.name)).toEqual([...FREE_AGENT_TOOL_NAMES]);
    expect(payload.tools).toEqual(
      FREE_AGENT_TOOL_NAMES.map((name) => ({
        type: "function",
        name,
        description: expect.any(String),
        parameters: {
          type: "object",
          properties: { input: { type: "string", description: expect.any(String) } },
          required: [],
        },
      })),
    );
    expect(payload.store).toBe(false);
  });

  test("snaps an out-of-set temperature to the nearest allowed value", () => {
    expect(prepare(request("opencodeft/fledge-alpha-free", 0.7)).generation_controls.temperature).toBe(0.6);
    expect(prepare(request("fledge-alpha-free", 0.2)).generation_controls.temperature).toBe(0);
    expect(prepare(request("fledge-alpha-free", 0.9)).generation_controls.temperature).toBe(1);
  });

  test("leaves an allowed temperature untouched", () => {
    for (const value of [0, 0.6, 1]) {
      expect(prepare(request("fledge-alpha-free", value)).generation_controls.temperature).toBe(value);
    }
  });

  test("does not touch a model that accepts any temperature", () => {
    const prepared = prepare(request("opencodeft/some-other-model", 0.7));
    expect(prepared.generation_controls.temperature).toBe(0.7);
  });

  test("does nothing when no temperature was sent", () => {
    const prepared = prepare(request("fledge-alpha-free", undefined));
    expect(prepared.generation_controls.temperature).toBeUndefined();
  });
});
