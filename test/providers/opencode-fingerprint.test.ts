import { describe, expect, test } from "bun:test";
import type { ProviderDispatchContext } from "../../src/providers/core/contracts";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import { encodeWireRequest } from "../../src/protocol/registry";
import { OPENCODE_FREE_SPEC } from "../../src/providers/integrations/opencode/provider";

describe("OpenCode request fingerprint", () => {
  test("matches the captured CLI identity and reuses session identity per conversation", async () => {
    const context: ProviderDispatchContext = {
      credential: {
        provider_id: "opencodeft",
        credential_kind: "none",
      },
      deadline: Date.now() + 1_000,
      abort_signal: new AbortController().signal,
      conversation_affinity: "aff_stable_conversation",
      request_headers: { "x-opencode-project": "stable-project-hash" },
    };
    const buildHeaders = OPENCODE_FREE_SPEC.buildExtraHeaders;
    if (!buildHeaders) throw new Error("OpenCode Free must provide fingerprint headers");

    const first = await buildHeaders(context);
    const second = await buildHeaders(context);

    expect(first["x-opencode-client"]).toBe("cli");
    expect(first["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(second["x-opencode-session"]).toBe(first["x-opencode-session"]);
    expect(first["x-opencode-session-id"]).toBe(first["x-opencode-session"]);
    expect(first["x-session-affinity"]).toBe(first["x-opencode-session"]);
    expect(first["x-session-id"]).toBe(first["x-opencode-session"]);
    expect(first["x-opencode-project"]).toBe("stable-project-hash");
    expect(first["user-agent"]).toMatch(/^opencode\/latest\/\d+\.\d+\.\d+\/cli$/);
    const traceparent = first["traceparent"];
    const b3 = first["b3"];
    if (!traceparent || !b3) throw new Error("OpenCode trace headers must be present");
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(b3).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/);
    const [, traceId, spanId] = traceparent.split("-");
    expect(b3).toStartWith(`${traceId}-${spanId}-1-`);
    expect(first["x-opencode-request"]).toBeUndefined();
    expect(traceparent).not.toBe(second["traceparent"]);
  });

  test("uses the captured Chat Completions token-limit field in the wire encoder", async () => {
    const tokenLimitField = OPENCODE_FREE_SPEC.chatTokenLimitField;
    if (!tokenLimitField) throw new Error("OpenCode must configure its Chat token-limit field");
    const request: CanonicalRequest = {
      model: "muse-spark-1.2-contributor-free",
      messages: [],
      generation_controls: { max_tokens: 512 },
      stream: true,
      source_surface: "chat",
    };
    const payload = await encodeWireRequest("chat", request, { chatTokenLimitField: tokenLimitField });

    expect(payload["max_completion_tokens"]).toBe(512);
    expect(payload["max_tokens"]).toBeUndefined();
  });
});
