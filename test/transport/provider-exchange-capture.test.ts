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
        authorization: "******",
        "x-opencode-client": "cli",
        "x-opencode-project": "stable-project-hash",
        "x-opencode-session": "ses_test",
        "x-opencode-session-id": "ses_test",
        "x-session-affinity": "ses_test",
        "x-session-id": "ses_test",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        b3: "0123456789abcdef0123456789abcdef-0123456789abcdef-1-fedcba9876543210",
        "user-agent": "opencode/latest/2.0.28/cli",
      },
      body: "{}",
    });

    expect(capture.request).toMatchObject({
      headers: {
        "x-opencode-client": "cli",
        "x-opencode-project": "stable-project-hash",
        "x-opencode-session": "ses_test",
        "x-session-affinity": "ses_test",
        "x-session-id": "ses_test",
        "user-agent": "opencode/latest/2.0.28/cli",
      },
    });
    expect(JSON.stringify(capture.request)).not.toContain("******");
  });
});
