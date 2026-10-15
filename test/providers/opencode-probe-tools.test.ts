/**
 * A backfilled free-tier tool must carry a non-empty parameter schema.
 *
 * The free-tier gate reads the tool set, and an empty `properties` object is
 * not agent-shaped: an otherwise-correct dispatch carrying eleven such tools
 * returned 403 `FreeTierError`, while the same dispatch with one declared
 * property returned 200 (verified live 2026-10-15). The probe builds a
 * tool-less request, so every tool it sends is backfilled — which is why the
 * probe failed while a replay of a real client's tools did not.
 */
import { describe, expect, test } from "bun:test";
import { OPENCODE_FREE_SPEC } from "../../src/providers/integrations/opencode/provider";
import { encodeWireRequest } from "../../src/protocol/registry";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchTarget } from "../../src/providers/provider-contracts";

function probeRequest(): CanonicalRequest {
  return {
    model: "muse-spark-1.3-contributor-free",
    messages: [{ role: "user", content: [{ kind: "text", text: "Reply with exactly: PONG" }] }],
    stream: true,
    source_surface: "responses",
    generation_controls: {},
  } as unknown as CanonicalRequest;
}

describe("OpenCode free probe — backfilled tools are agent-shaped", () => {
  test("every backfilled tool declares at least one property", async () => {
    const request = OPENCODE_FREE_SPEC.prepareRequest?.(probeRequest()) ?? probeRequest();
    const payload = await encodeWireRequest("responses", request);
    const candidate: ProviderDispatchTarget = {
      provider_id: "opencodeft",
      model_id: "muse-spark-1.3-contributor-free",
      wire_family: "responses",
      endpoint_path: "/inference/v1/responses",
      capabilities: {},
    };
    OPENCODE_FREE_SPEC.prePayload?.(payload, request, candidate);

    const tools = payload.tools as { parameters: { properties: Record<string, unknown> } }[];
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(Object.keys(tool.parameters.properties).length).toBeGreaterThan(0);
    }
  });
});
