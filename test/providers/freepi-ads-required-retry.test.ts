/**
 * Free-pi `ads_required` recovery.
 *
 * The adapter caches one ad-registered session id per credential forever,
 * so a session whose ad registration never landed fails every chat with
 * `ads_required` until the gateway restarts. Dispatch must drop the stale
 * id and retry once with a fresh ad-registered session, and the classifier
 * must read the refusal as a short server-side cooldown — never as
 * `auth_invalidated` (the credential is fine).
 */
import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import { FreepiAdapter } from "../../src/providers/integrations/freepi/freepi";
import { throwFreepiUpstreamError } from "../../src/providers/integrations/freepi/freepi-protocol";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/provider-contracts";

const ADS_MESSAGE =
  "free-pi is free because ads pay for it, so ads can't be skipped. Ads aren't showing for this account, so free completions are paused.";

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      // The upstream's wire is `data {...}` — space, NO colon.
      // parseFreepiSse slices the first 4 chars ("data") and strips one
      // leading space, so standard `data: {...}` would arrive as the
      // unparsable string ": {...}" and every frame would be skipped.
      for (const frame of frames) controller.enqueue(encoder.encode(`data ${frame}\n\n`));
      controller.close();
    },
  });
}

function adsRequiredStream(): ReadableStream<Uint8Array> {
  return sseStream([
    JSON.stringify({ error: { code: "ads_required", message: ADS_MESSAGE } }),
  ]);
}

function okChatStream(text: string): ReadableStream<Uint8Array> {
  return sseStream([
    JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] }),
    "[DONE]",
  ]);
}

interface FetchLog {
  chatSessions: string[];
  adsNext: number;
  impressions: number;
}

/** Mock upstream: ads always serve, chat answers come from the queue. */
function stubFetch(chatQueue: Array<() => Response>, log: FetchLog): typeof fetch {
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.includes("/ads/next")) {
      log.adsNext += 1;
      const slot = new URL(url).searchParams.get("slot") ?? "banner";
      return new Response(JSON.stringify({ ad_id: `ad-${slot}`, click_token: `tok-${slot}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/ads/impression")) {
      log.impressions += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/v1/chat/completions")) {
      log.chatSessions.push(headers["x-session-id"] ?? "");
      const next = chatQueue.shift();
      if (!next) throw new Error("unexpected extra chat call");
      return next();
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return impl;
}

function makeContext(impl: typeof fetch): ProviderDispatchContext {
  return {
    outbound_fetch: impl,
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
    credential: {
      credential_id: "c1",
      provider_id: "freepi",
      credential_kind: "oauth",
      kind: "oauth",
      secret: new TextEncoder().encode("jwt-test"),
    },
    user_agent: "test",
  } as unknown as ProviderDispatchContext;
}

function makeTarget(): ProviderDispatchTarget {
  return {
    provider_id: "freepi",
    model_id: "deepseek-v4.1-flash",
    wire_family: "chat",
    endpoint_path: "/v1/chat/completions",
    credential: {
      credential_id: "c1",
      provider_id: "freepi",
      credential_kind: "oauth",
      kind: "oauth",
      secret: new TextEncoder().encode("jwt-test"),
    },
  } as unknown as ProviderDispatchTarget;
}

function makeRequest(): CanonicalRequest {
  return {
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    stream: true,
    generation_controls: {},
    source_surface: "test",
  } as unknown as CanonicalRequest;
}

async function collectText(adapter: FreepiAdapter, context: ProviderDispatchContext): Promise<string> {
  let text = "";
  for await (const event of adapter.dispatch(makeRequest(), makeTarget(), context)) {
    const content = (event as { content?: { kind?: string; text?: string } }).content;
    if (content?.kind === "text" && typeof content.text === "string") text += content.text;
  }
  return text;
}

describe("FreepiAdapter ads_required retry", () => {
  test("retries once with a fresh ad-registered session, then succeeds", async () => {
    const log: FetchLog = { chatSessions: [], adsNext: 0, impressions: 0 };
    const fetchImpl = stubFetch(
      [
        () => new Response(adsRequiredStream(), { status: 200, headers: { "content-type": "text/event-stream" } }),
        () => new Response(okChatStream("hi"), { status: 200, headers: { "content-type": "text/event-stream" } }),
      ],
      log,
    );
    const adapter = new FreepiAdapter({ fetch: fetchImpl });
    expect(await collectText(adapter, makeContext(fetchImpl))).toBe("hi");
    // Two chat attempts on two different session ids, and the retry
    // re-registered ads (2 slots x 2 sessions).
    expect(log.chatSessions).toHaveLength(2);
    expect(log.chatSessions[0]!).not.toBe(log.chatSessions[1]);
    expect(log.chatSessions[0]!.length).toBeGreaterThan(0);
    expect(log.adsNext).toBe(4);
    expect(log.impressions).toBe(4);
  });

  test("gives up after the retry also answers ads_required", async () => {
    const log: FetchLog = { chatSessions: [], adsNext: 0, impressions: 0 };
    const fetchImpl = stubFetch(
      [
        () => new Response(adsRequiredStream(), { status: 200, headers: { "content-type": "text/event-stream" } }),
        () => new Response(adsRequiredStream(), { status: 200, headers: { "content-type": "text/event-stream" } }),
      ],
      log,
    );
    const adapter = new FreepiAdapter({ fetch: fetchImpl });
    let thrown: unknown;
    try {
      await collectText(adapter, makeContext(fetchImpl));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GatewayError);
    expect(log.chatSessions).toHaveLength(2);
  });
});

describe("Freepi ads_required classification", () => {
  test("throwFreepiUpstreamError carries ads_required in providerCode", () => {
    let thrown: unknown;
    try {
      throwFreepiUpstreamError("ads_required", ADS_MESSAGE);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GatewayError);
    const details = (thrown as GatewayError).details as Record<string, unknown>;
    expect(details["providerCode"]).toBe("ads_required");
    expect(details["upstream_code"]).toBe("ads_required");
  });

  test("ads_required cools the account briefly, never as auth_invalidated", () => {
    const error = new GatewayError("platform_unavailable", 502, ADS_MESSAGE, {
      providerCode: "ads_required",
    }, "upstream");
    const classification = classifyAccountError(error, {
      origin: "upstream",
      scope: "account",
      providerId: "freepi",
    });
    expect(classification.category).toBe("server_error");
    expect(classification.status).toBe("cooldown");
    expect(classification.cooldownMs).toBe(10 * 60_000);
    expect(classification.mutatesAccount).toBe(true);
  });
});
