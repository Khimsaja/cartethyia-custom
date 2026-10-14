import { describe, expect, test } from "bun:test";
import { buddyPrePayloadCommon } from "../../src/providers/integrations/buddy/buddy-chat-shared";
import { readBuddyDeviceToken, workbuddyHeaders } from "../../src/providers/integrations/buddy/workbuddy/shared";
import { fetchTencentBillingQuota } from "../../src/providers/integrations/buddy/buddy-quota-shared";
import { fetchWorkBuddyCnQuota } from "../../src/providers/integrations/buddy/workbuddy/quota";
import { parseDsmlToolCalls } from "../../src/protocol/response/dsml";
import { parseChatResponseToEvents } from "../../src/protocol/response/chat";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext } from "../../src/providers/provider-contracts";

const request = { model: "glm-5.2", messages: [] } as unknown as CanonicalRequest;
const context = {
  credential: { account_id: "abcdef123456", auth_state: { deviceToken: "desktop-token" } },
} as unknown as ProviderDispatchContext;

describe("Buddy upstream protocol alignment", () => {
  test("keeps tools when tool_choice is none without inventing a cache key", () => {
    const payload: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "run_shell" } }],
      tool_choice: "none",
    };
    buddyPrePayloadCommon(payload, request);
    expect(payload["tool_choice"]).toBe("none");
    expect(payload["tools"]).toHaveLength(1);
    expect(payload["prompt_cache_key"]).toBeUndefined();
  });

  test("clamps an unsupported international effort without touching a supported one", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      messages: [],
      reasoning_effort: "max",
      prompt_cache_key: "client-key",
    };
    buddyPrePayloadCommon(payload, request, "intl");
    expect(payload["reasoning_effort"]).toBe("high");
    expect(payload["prompt_cache_key"]).toBe("client-key");
  });

  test("raising the effort also lifts a max_tokens sized for the lower one", () => {
    // `hy4-preview-f` serves only `high`. A caller who asked for `low` sized
    // its answer for `low`, but the raised level spends part of the same
    // budget on reasoning — so the answer truncates and an agent retries from
    // the top, which reads as a loop rather than as a short limit.
    const payload: Record<string, unknown> = {
      model: "hy4-preview-f",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "low",
      max_tokens: 2048,
    };
    buddyPrePayloadCommon(payload, request, "intl");
    expect(payload["reasoning_effort"]).toBe("high");
    expect(payload["max_tokens"]).toBe(32_000);
  });

  test("a supported effort leaves the caller's max_tokens alone", () => {
    // Nothing was raised, so nothing is owed a bigger budget: a caller who
    // deliberately asked for a small answer still gets one.
    const payload: Record<string, unknown> = {
      model: "hy4-preview-f",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
      max_tokens: 2048,
    };
    buddyPrePayloadCommon(payload, request, "intl");
    expect(payload["reasoning_effort"]).toBe("high");
    expect(payload["max_tokens"]).toBe(2048);
  });

  test("clamping an effort downward never raises the output budget", () => {
    const payload: Record<string, unknown> = {
      model: "glm-5.3",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "max",
      max_tokens: 2048,
    };
    buddyPrePayloadCommon(payload, request, "intl");
    expect(payload["max_tokens"]).toBe(2048);
  });

  test("a max_tokens already above the floor is not overwritten", () => {
    const payload: Record<string, unknown> = {
      model: "hy4-preview-f",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "low",
      max_tokens: 60_000,
    };
    buddyPrePayloadCommon(payload, request, "intl");
    expect(payload["max_tokens"]).toBe(60_000);
  });

  test("uses the CN effort ladder for the same model", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      messages: [],
      reasoning_effort: "max",
    };
    buddyPrePayloadCommon(payload, request, "cn");
    expect(payload["reasoning_effort"]).toBe("max");
  });

  test("sends the desktop device token only when the account has one", async () => {
    const headers = await workbuddyHeaders(context, request);
    expect(headers["x-device-token"]).toBe("desktop-token");
    expect(readBuddyDeviceToken({ credential: { auth_state: {} } } as unknown as ProviderDispatchContext)).toBeUndefined();
  });

  test("WorkBuddy CN changes only the host identity in the shared headers", async () => {
    const cnHeaders = await workbuddyHeaders(context, request, "www.workbuddy.cn", "5.7.7.40774747");
    const intlHeaders = await workbuddyHeaders(context, request);
    expect(cnHeaders["origin"]).toBe("https://www.workbuddy.cn");
    expect(cnHeaders["referer"]).toBe("https://www.workbuddy.cn/");
    expect(cnHeaders["x-domain"]).toBe("www.workbuddy.cn");
    expect(cnHeaders["user-agent"]).toMatch(
      /^WorkBuddy\/5\.7\.7\.40774747 WorkBuddy AI\/5\.7\.7\.40774747 CLI\/\S+$/,
    );
    expect(cnHeaders["user-agent"]).toContain("5.7.7.40774747");
    expect(cnHeaders["x-product"]).toBe(intlHeaders["x-product"]);
  });

  test("recovers a complete DSML block as a tool call", () => {
    const pipe = "\uFF5C\uFF5C";
    const text = `<${pipe}DSML${pipe} calls><${pipe}DSML${pipe} invoke name="run_shell"><${pipe}DSML${pipe} parameter name="command" string="true">ls</${pipe}DSML${pipe} parameter></${pipe}DSML${pipe} invoke></${pipe}DSML${pipe} calls>`;
    const recovered = parseDsmlToolCalls(text);
    expect(recovered?.calls[0]?.name).toBe("run_shell");
    expect(JSON.parse(recovered?.calls[0]?.arguments ?? "{}")).toEqual({ command: "ls" });
    const events = parseChatResponseToEvents({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
    }, request);
    expect(events.some((event) => event.type === "tool_call_delta" && event.name === "run_shell")).toBe(true);
  });

  test("drops a replayed tool call whose function name is empty, and its orphan result", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      messages: [
        { role: "user", content: "search this" },
        {
          role: "assistant",
          content: "on it",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "", arguments: '{"query":"x"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "<tool_use_error>No such tool available: </tool_use_error>" },
      ],
    };
    buddyPrePayloadCommon(payload, request);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages.some((m) => m["role"] === "tool" && m["tool_call_id"] === "call_1")).toBe(false);
    const assistant = messages.find((m) => m["role"] === "assistant") as Record<string, unknown> | undefined;
    expect(assistant?.["tool_calls"]).toBeUndefined();
  });

  test("keeps a named call on the same turn when a sibling name is empty", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "working",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "run_shell", arguments: "{}" } },
            { id: "call_2", type: "function", function: { name: "", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
        { role: "tool", tool_call_id: "call_2", content: "err" },
      ],
    };
    buddyPrePayloadCommon(payload, request);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    const assistant = messages.find((m) => m["role"] === "assistant") as Record<string, unknown>;
    const kept = (assistant["tool_calls"] ?? []) as Array<Record<string, unknown>>;
    expect(kept).toHaveLength(1);
    expect((kept[0]?.["function"] as Record<string, unknown> | undefined)?.["name"]).toBe("run_shell");
    expect(messages.some((m) => m["tool_call_id"] === "call_2")).toBe(false);
  });

  test("does not remove an assistant turn that keeps content after dropping a nameless call", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "checking",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "  ", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "err" },
      ],
    };
    buddyPrePayloadCommon(payload, request);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    // The turn said something before calling, so it survives without its call.
    expect(messages.some((m) => m["role"] === "assistant" && m["content"] === "checking")).toBe(true);
  });

  test("reads enterprise usage when the personal package list is empty", async () => {
    const fetcher = (async (url: string) => new Response(JSON.stringify(
      String(url).endsWith("/get-user-resource")
        ? { code: 0, data: { Response: { Data: { Accounts: [] } } } }
        : { code: 0, data: { credit: 200, limitNum: 1000, cycleEndTime: "2026-10-26 23:59:59" } },
    ), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchTencentBillingQuota({
      source: "workbuddy",
      display: "WorkBuddy",
      url: "https://www.workbuddy.ai/v2/billing/meter/get-user-resource",
      headers: { "X-Enterprise-Id": "ent-1" },
      credential: "token",
      fetcher,
      defaultPlan: "WorkBuddy",
    });

    expect(result.plan).toBe("Enterprise");
    expect(result.windows[0]?.remaining).toBe(800);
    expect(result.windows[0]?.limit).toBe(1000);
  });

  test("WorkBuddy CN quota uses its own host and client version", async () => {
    let capturedUrl = "";
    let capturedHeaders: Headers | undefined;
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        code: 0,
        data: {
          Response: {
            Data: {
              Accounts: [{
                PackageName: "WorkBuddy CN",
                CapacityUsed: 10,
                CapacitySize: 100,
                CycleEndTime: "2026-11-01T00:00:00.000Z",
              }],
            },
          },
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchWorkBuddyCnQuota("token", fetcher);

    expect(result.source).toBe("workbuddycn");
    expect(capturedUrl).toBe("https://www.workbuddy.cn/v2/billing/meter/get-user-resource");
    expect(capturedHeaders?.get("x-domain")).toBe("www.workbuddy.cn");
    expect(capturedHeaders?.get("user-agent")).toContain("WorkBuddy/5.7.7.40774747");
  });

  test("classifies refill and bonus packages into the same spendable credit pool", async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              {
                PackageName: "Monthly",
                CycleCapacityUsedPrecise: "0",
                CycleCapacitySizePrecise: "100",
                CycleEndTime: "2030-11-01 00:00:00",
                DeductionEndTime: "2030-12-01 00:00:00",
              },
              {
                PackageName: "Bonus",
                CapacityUsedPrecise: "30",
                CapacitySizePrecise: "30",
                CycleEndTime: "2030-11-15 00:00:00",
              },
            ],
          },
        },
      },
    }), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchTencentBillingQuota({
      source: "cb",
      display: "CodeBuddy",
      url: "https://www.codebuddy.ai/v2/billing/meter/get-user-resource",
      headers: {},
      credential: "token",
      fetcher,
      defaultPlan: "CodeBuddy",
    });

    expect(result.windows.map((entry) => entry.accounting)).toEqual(["pooled", "pooled"]);
  });
});
