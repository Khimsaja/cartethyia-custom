import { describe, expect, test } from "bun:test";
import { canonicalToChatPayload } from "../../../src/protocol/request/chat";
import { canonicalToClaudeMessagesPayload } from "../../../src/protocol/request/messages";
import { canonicalToResponsesPayload } from "../../../src/protocol/request/responses";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";

const BILLING = "x-anthropic-billing-header: cc_version=2.1.257.abc; cc_entrypoint=cli; cch=00000;";

function request(): CanonicalRequest {
  return {
    model: "m",
    system: [
      { kind: "text", text: BILLING },
      { kind: "text", text: "real instruction" },
    ],
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: { max_tokens: 100 },
    stream: false,
    source_surface: "chat",
  } as CanonicalRequest;
}

describe("billing attestation is never forwarded upstream", () => {
  test("messages builder drops echoed billing blocks", () => {
    const payload = canonicalToClaudeMessagesPayload(request());
    const texts = ((payload.system ?? []) as Array<Record<string, unknown>>).map((b) => b["text"]);
    expect(texts).toEqual(["real instruction"]);
  });

  test("chat builder drops echoed billing blocks", () => {
    const payload = canonicalToChatPayload(request());
    const systems = (payload["messages"] as Array<Record<string, unknown>>).filter(
      (m) => m["role"] === "system",
    );
    expect(systems).toHaveLength(1);
    expect(systems[0]?.["content"]).toBe("real instruction");
  });

  test("responses builder drops echoed billing blocks", () => {
    const payload = canonicalToResponsesPayload(request());
    const input = payload["input"] as Array<Record<string, unknown>>;
    const texts = input.flatMap((item) =>
      ((item["content"] as Array<Record<string, unknown>>) ?? []).map((c) => c["text"]),
    );
    expect(texts).toContain("real instruction");
    expect(texts.some((t) => String(t).startsWith("x-anthropic-billing-header:"))).toBe(false);
  });
});

describe("messages streaming usage", () => {
  // `stream_options` is an OpenAI field. The native Anthropic API rejects the
  // whole body when it is present (`stream_options: Extra inputs are not
  // permitted`), and Anthropic reports usage without an opt-in — see
  // `protocol/response/messages.ts`, which reads `message_start.message.usage`
  // and `message_delta.usage`. So the Messages codec must never emit it.
  test("a streamed request never carries the OpenAI stream_options field", () => {
    const payload = canonicalToClaudeMessagesPayload({ ...request(), stream: true });
    expect(payload.stream_options).toBeUndefined();
  });

  test("a non-streamed request does not send stream options", () => {
    const payload = canonicalToClaudeMessagesPayload(request());
    expect(payload.stream_options).toBeUndefined();
  });
});

function requestWithExtensions(): CanonicalRequest {
  return {
    model: "m",
    messages: [
      {
        role: "assistant",
        content: [
          { kind: "text", text: "hello" },
          // Foreign-surface annotation: no Messages representation, must not
          // reach Anthropic (unknown block types draw an upstream 400).
          {
            kind: "extension",
            name: "responses:response.output_text.annotation.added",
            payload: {
              type: "response.output_text.annotation.added",
              annotation: { type: "url_citation", url: "https://x.test" },
            },
          },
          { kind: "extension", name: "audio", payload: { data: "x" } },
          { kind: "extension", name: "unknown", payload: "x" },
          // Messages-native extensions must survive the same path.
          {
            kind: "extension",
            name: "server_tool_use",
            payload: { type: "server_tool_use", id: "srv-1" },
          },
          {
            kind: "extension",
            name: "messages:container",
            payload: { type: "container", id: "ctr-1" },
          },
        ],
      },
    ],
    generation_controls: { max_tokens: 100 },
    stream: false,
    source_surface: "responses",
  } as CanonicalRequest;
}

describe("messages builder drops foreign extensions", () => {
  test("only Messages-native extensions reach the Anthropic wire", () => {
    const payload = canonicalToClaudeMessagesPayload(requestWithExtensions());
    const blocks = (
      (payload.messages as Array<Record<string, unknown>>)[0]?.["content"] as Array<
        Record<string, unknown>
      >
    ).map((b) => b["type"]);
    expect(blocks).toContain("text");
    expect(blocks).toContain("server_tool_use");
    expect(blocks).toContain("container");
    expect(blocks.some((t) => String(t).startsWith("responses:"))).toBe(false);
    expect(blocks).not.toContain("audio");
    expect(blocks).not.toContain("unknown");
  });
});

describe("messages builder preserves cross-provider reasoning context", () => {
  test("demotes unsigned reasoning to assistant text and preserves signed Anthropic thinking", () => {
    const payload = canonicalToClaudeMessagesPayload({
      model: "claude",
      messages: [
        {
          role: "assistant",
          content: [
            { kind: "reasoning", payload: "private OpenAI reasoning", summary: "private OpenAI reasoning" },
            { kind: "reasoning", payload: "empty signature", summary: "empty signature", signature: "" },
            { kind: "reasoning", payload: "signed thinking", summary: "signed thinking", signature: "sig" },
          ],
        },
      ],
      generation_controls: { max_tokens: 100 },
      stream: false,
      source_surface: "chat",
    } as unknown as CanonicalRequest);
    const blocks = (payload.messages as Array<Record<string, unknown>>)[0]?.["content"] as Array<
      Record<string, unknown>
    >;
    expect(
      blocks.map(({ type, text, thinking, signature }) => ({
        type,
        text: text ?? null,
        thinking: thinking ?? null,
        signature: signature ?? null,
      })),
    ).toEqual([
      { type: "text", text: "private OpenAI reasoning", thinking: null, signature: null },
      { type: "text", text: "empty signature", thinking: null, signature: null },
      { type: "thinking", text: null, thinking: "signed thinking", signature: "sig" },
    ]);
  });
});

describe("messages builder hoists developer instructions", () => {
  test("top-level instructions reach payload.system, not messages[]", () => {
    const request = {
      model: "m",
      instructions: [{ kind: "text", text: "Rule 1" }],
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: { max_tokens: 10 },
      stream: false,
      source_surface: "responses",
    } as unknown as CanonicalRequest;
    const payload = canonicalToClaudeMessagesPayload(request);
    const system = (payload.system ?? []) as Array<Record<string, unknown>>;
    expect(system.map((b) => b["text"])).toContain("Rule 1");
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(messages.map((m) => m["role"])).toEqual(["user"]);
  });
});

describe("the Messages wire carries no audio block", () => {
  // The Anthropic Messages request content blocks are text, image, document,
  // search_result, thinking, redacted_thinking, tool_use, tool_result, the
  // server-tool result blocks, and container_upload. There is no audio variant
  // and no accepted `media_type` admits an audio MIME type, so an `audio` block
  // is not a shape this wire can express.
  const withAudio = {
    model: "m",
    messages: [
      {
        role: "user",
        content: [
          { kind: "text", text: "transcribe this" },
          { kind: "audio", data: "QUJD", media_type: "audio/wav" },
        ],
      },
    ],
    generation_controls: { max_tokens: 10 },
    stream: false,
    source_surface: "chat",
  } as unknown as CanonicalRequest;

  test("an audio part degrades to a visible placeholder, never an undefined block type", () => {
    const payload = canonicalToClaudeMessagesPayload(withAudio);
    const content = (payload.messages as Array<Record<string, unknown>>)[0]?.["content"] as Array<
      Record<string, unknown>
    >;
    // The caller's text survives; only the attachment is replaced. The
    // placeholder may carry the same cache breakpoint as its neighbours.
    expect(content).toContainEqual({ type: "text", text: "transcribe this" });
    expect(content.some((b) => b["text"] === "[audio]" && b["type"] === "text")).toBe(true);
    // No block on the wire carries the audio payload or an audio discriminator.
    for (const block of content) expect(block["type"]).not.toBe("audio");
    expect(JSON.stringify(payload)).not.toContain("QUJD");
  });

  test("the same part keeps its payload on the wires that do define an audio block", () => {
    // Chat and Responses both define `input_audio`; only Messages does not. This
    // pins the asymmetry so the placeholder above cannot spread to a wire that
    // can actually carry the part.
    const chat = canonicalToChatPayload(withAudio);
    const chatContent = (chat.messages as Array<Record<string, unknown>>)[0]?.["content"] as Array<
      Record<string, unknown>
    >;
    expect(chatContent).toContainEqual({
      type: "input_audio",
      input_audio: { data: "QUJD", format: "wav" },
    });

    const responses = canonicalToResponsesPayload(withAudio);
    const input = responses.input as Array<Record<string, unknown>>;
    const responsesContent = input[0]?.["content"] as Array<Record<string, unknown>>;
    expect(responsesContent).toContainEqual({
      type: "input_audio",
      data: "QUJD",
      media_type: "audio/wav",
    });
  });
});

describe("tool_use blocks on the Messages request body", () => {
  test("never carry the canonical stream index", () => {
    // Studio (and any Chat/Responses client) sends `tool_calls` in history, and
    // those parsers stamp every call with its array position. Copying that onto
    // the `tool_use` block leaked a stream-only field into the request, and
    // Anthropic rejected the whole body:
    // `messages.2.content.0.tool_use.index: Extra inputs are not permitted`.
    const payload = canonicalToClaudeMessagesPayload({
      model: "claude-sonnet-5",
      messages: [
        {
          role: "assistant",
          content: [
            { kind: "toolCall", call_id: "c1", name: "lookup", arguments: '{"k":1}', index: 0 },
            { kind: "toolCall", call_id: "c2", name: "lookup", arguments: '{"k":2}', index: 1 },
          ],
        },
      ],
      generation_controls: { max_tokens: 1024 },
      stream: false,
      source_surface: "chat",
    } as never);

    const content = (payload.messages as Array<Record<string, unknown>>)[0]?.["content"] as Array<
      Record<string, unknown>
    >;
    expect(content).toHaveLength(2);
    for (const block of content) {
      expect(block["type"]).toBe("tool_use");
      expect(block).not.toHaveProperty("index");
      // The block order still expresses the position the index used to carry.
      expect(block).toHaveProperty("input");
      expect(block).toHaveProperty("id");
    }
  });
});

/**
 * The `thinking` block shape is chosen by model generation, not copied from the
 * canonical intent. Adaptive-era models take `type: "adaptive"` with depth on
 * `output_config.effort`; budget-era models take `type: "enabled"` with a
 * `budget_tokens`. The two reject each other's shape (verified live: an adaptive
 * block on opus-4-5/sonnet-4-5/haiku-4-5 → "adaptive thinking is not supported
 * on this model"; a budget-less enabled block → "thinking.enabled.budget_tokens:
 * Field required").
 */
describe("claude thinking block shape follows the model generation", () => {
  const withReasoning = (model: string, reasoning: Record<string, unknown>): CanonicalRequest =>
    ({
      model,
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: { max_tokens: 8192 },
      stream: false,
      source_surface: "chat",
      reasoning,
    }) as CanonicalRequest;

  test("an adaptive-era model gets `adaptive` with no budget_tokens", () => {
    const payload = canonicalToClaudeMessagesPayload(
      withReasoning("claude-sonnet-5-5", { effort: "high" }),
    );
    const thinking = payload.thinking as Record<string, unknown>;
    expect(thinking["type"]).toBe("adaptive");
    expect(thinking).not.toHaveProperty("budget_tokens");
    // Depth rides on output_config.effort for adaptive models.
    expect((payload.output_config as Record<string, unknown>)["effort"]).toBe("high");
  });

  test("a budget-era model gets `enabled` with a budget_tokens derived from the level", () => {
    const payload = canonicalToClaudeMessagesPayload(
      withReasoning("claude-opus-4-5", { effort: "high" }),
    );
    const thinking = payload.thinking as Record<string, unknown>;
    expect(thinking["type"]).toBe("enabled");
    expect(thinking["budget_tokens"]).toBe(24_576);
    // The effort still rides along: budget-era models accept
    // `output_config.effort` alongside `thinking.enabled` (verified live:
    // opus-4-5 / sonnet-4-5 / haiku-4-5 all 200). Only the *thinking* shape is
    // generation-gated.
    expect((payload.output_config as Record<string, unknown>)["effort"]).toBe("high");
  });

  test("a budget-era model floors the derived budget at the upstream minimum", () => {
    const payload = canonicalToClaudeMessagesPayload(
      withReasoning("claude-haiku-4-5", { effort: "minimal" }),
    );
    // LEVEL_TO_BUDGET.minimal is 512, below the upstream floor of 1024.
    expect((payload.thinking as Record<string, unknown>)["budget_tokens"]).toBe(1024);
  });

  test("an adaptive-era model opts into summarized thinking display", () => {
    // 4.7+/5-series omit thinking content by default; the summarized display is
    // what keeps human-readable thinking text streaming.
    const payload = canonicalToClaudeMessagesPayload(
      withReasoning("claude-opus-5", { effort: "high" }),
    );
    expect((payload.thinking as Record<string, unknown>)["display"]).toBe("summarized");
  });
});
