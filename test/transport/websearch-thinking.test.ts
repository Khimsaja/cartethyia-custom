/**
 * What the served-search rewrite does to the rest of the request.
 *
 * `withAnsweredWebSearchToolCall` rebuilds the request to append the search
 * round and drop the hosted search tool. It destructures `tools` out and
 * spreads the remainder, so the question is what survives that rebuild —
 * the continuation is dispatched as a fresh upstream turn, and anything the
 * rebuild loses is silently absent from it.
 *
 * `thinking` is the case that matters: the model is asked to continue with
 * search results in context, and a continuation that stops carrying the
 * caller's reasoning config is a different request than the one that started.
 */
import { describe, expect, test } from "bun:test";
import {
  withAnsweredWebSearchToolCall,
  type WebSearchBridgeResult,
} from "../../src/transport/dispatch/websearch-bridge";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { WebSearchOutcome } from "../../src/providers/provider-contracts";

const CLIENT_CALL_ID = "toolu_01ArealClientCallId";

function served(): WebSearchBridgeResult {
  return {
    providerId: "exa",
    modelId: "exa",
    query: "who is risuncode",
    results: {
      results: [{ title: "One", url: "https://example.com/one", snippet: "first" }],
    } as unknown as WebSearchOutcome,
  };
}

/** A Messages request that carries reasoning config alongside the hosted tool. */
function requestWithThinking(): CanonicalRequest {
  return {
    source_surface: "messages",
    messages: [
      { role: "user", content: [{ kind: "text", text: "who is risuncode" }] },
      {
        role: "assistant",
        content: [
          {
            kind: "toolCall",
            call_id: CLIENT_CALL_ID,
            name: "web_search",
            arguments: { query: "who is risuncode" },
          },
        ],
      },
    ],
    tools: [{ type: "hosted", name: "web_search" }],
    reasoning: { thinking_type: "enabled", budget_tokens: 10000 },
  } as unknown as CanonicalRequest;
}

describe("withAnsweredWebSearchToolCall", () => {
  test("keeps the caller's reasoning config on the continuation", () => {
    const continued = withAnsweredWebSearchToolCall(
      requestWithThinking(),
      { callId: CLIENT_CALL_ID, name: "web_search", query: "who is risuncode" },
      served(),
    );
    // The continuation must still ask for thinking: dropping it changes the
    // request the caller actually made.
    expect(continued.reasoning).toEqual({ thinking_type: "enabled", budget_tokens: 10000 });
  });

  test("drops the hosted search tool but keeps unrelated tools", () => {
    const request = {
      ...requestWithThinking(),
      tools: [
        { type: "hosted", name: "web_search" },
        { type: "function", name: "Read" },
      ],
    } as unknown as CanonicalRequest;
    const continued = withAnsweredWebSearchToolCall(
      request,
      { callId: CLIENT_CALL_ID, name: "web_search", query: "who is risuncode" },
      served(),
    );
    const names = continued.tools?.map((tool) => tool.name);
    expect(names).toEqual(["Read"]);
  });

  test("appends the assistant call and its tool result", () => {
    const continued = withAnsweredWebSearchToolCall(
      requestWithThinking(),
      { callId: CLIENT_CALL_ID, name: "web_search", query: "who is risuncode" },
      served(),
    );
    // Original turn plus the two appended rounds.
    expect(continued.messages.length).toBe(4);
    expect(continued.messages.at(-2)?.role).toBe("assistant");
    expect(continued.messages.at(-1)?.role).toBe("tool");
  });
});
