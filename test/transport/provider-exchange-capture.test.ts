import { describe, expect, test } from "bun:test";
import { captureProviderExchange } from "../../src/transport/dispatch/attempt-finalize";

describe("provider exchange capture", () => {
  test("captures OpenCode fingerprint headers without persisting credentials", async () => {
    const capture = {
      request: null,
      response: Promise.resolve(null),
    };
    const fetcher = captureProviderExchange(
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
      capture,
    );

    await fetcher("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "x-opencode-client": "opencode",
        "x-opencode-project": "global",
        "x-opencode-request": "msg_test",
        "x-opencode-session": "ses_test",
        "x-session-affinity": "aff_stable_conversation",
        "user-agent": "opencode/2.0.27",
      },
      body: "{}",
    });

    expect(capture.request).toMatchObject({
      headers: {
        "x-opencode-client": "opencode",
        "x-opencode-project": "global",
        "x-opencode-request": "msg_test",
        "x-opencode-session": "ses_test",
        "x-session-affinity": "aff_stable_conversation",
        "user-agent": "opencode/2.0.27",
      },
    });
    expect(JSON.stringify(capture.request)).not.toContain("Bearer secret");
  });
});
