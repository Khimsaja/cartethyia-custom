import { describe, expect, test } from "bun:test";
import type { ProviderDispatchContext } from "../../src/providers/contracts";
import { OPENCODE_FREE_SPEC } from "../../src/providers/specs/opencode";

describe("OpenCode request fingerprint", () => {
  test("preserves conversation affinity without reusing the request id", async () => {
    const context: ProviderDispatchContext = {
      credential: {
        provider_id: "opencodeft",
        credential_kind: "none",
      },
      deadline: Date.now() + 1_000,
      abort_signal: new AbortController().signal,
      conversation_affinity: "aff_stable_conversation",
    };
    const buildHeaders = OPENCODE_FREE_SPEC.buildExtraHeaders;
    if (!buildHeaders) throw new Error("OpenCode Free must provide fingerprint headers");

    const first = await buildHeaders(context);
    const second = await buildHeaders(context);

    expect(first["x-opencode-client"]).toBe("opencode");
    expect(first["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(second["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(first["x-session-affinity"]).toBe("aff_stable_conversation");
    expect(second["x-session-affinity"]).toBe("aff_stable_conversation");
    expect(second["x-opencode-session"]).not.toBe(first["x-opencode-session"]);
    expect(first["x-opencode-request"]).toMatch(/^msg_[0-9a-f]{30}$/);
    expect(second["x-opencode-request"]).toMatch(/^msg_[0-9a-f]{30}$/);
    expect(second["x-opencode-request"]).not.toBe(first["x-opencode-request"]);
  });
});
