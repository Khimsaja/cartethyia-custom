/**
 * The parsed prompt is released as soon as the attempt loop no longer needs
 * it.
 *
 * The request state is what every retention path ends at: the dispatch
 * context carries the whole state as `request_identity`, and the in-flight
 * registry holds the controller whose signal listeners close over that
 * context. A state that outlives its request therefore pins the full prompt
 * until the backstop sweep evicts it. Releasing the messages right after the
 * attempt loop returns bounds what a retained state can pin to a few
 * scalars — the fields telemetry still reads (`model`, `source_surface`,
 * `stream`, `reasoning`).
 *
 * The release replaces properties, never mutates arrays: the projected
 * dispatch copies are shallow spreads, so their own `messages` property
 * keeps the original array and a mid-stream Responses retry still
 * re-dispatches the full request.
 */
import { expect, test } from "bun:test";
import { ProxyRequestStateStore } from "../../src/transport/request/state";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

function bigRequest(): CanonicalRequest {
  const longText = "lorem ipsum ".repeat(10_000);
  return {
    model: "bansos/test",
    system: [{ kind: "text", text: longText }],
    instructions: [{ kind: "text", text: longText }],
    messages: [
      { role: "user", content: [{ kind: "text", text: longText }] },
      { role: "assistant", content: [{ kind: "text", text: longText }] },
    ],
    tools: [
      {
        name: "search",
        description: longText,
        jsonSchema: { type: "object", properties: {} },
      },
    ],
    generation_controls: { temperature: 0.7 },
    reasoning: { effort: "high" },
    stream: true,
    source_surface: "chat",
    provider_options: { custom: longText },
    conversation: { conversation_id: "conv-1", provider_state: { blob: longText } },
  };
}

test("release drops the heavy content but keeps the telemetry scalars", () => {
  const store = new ProxyRequestStateStore(undefined);
  const state = store.initialize(
    new Request("https://example.test/v1/chat/completions", { method: "POST" }),
    Date.now(),
    60_000,
  );
  state.canonicalRequest = bigRequest();
  state.releaseCanonicalMessages();
  const slim = state.canonicalRequest;
  expect(slim).toBeDefined();
  expect(slim?.messages).toEqual([]);
  expect(slim?.system).toBeUndefined();
  expect(slim?.instructions).toBeUndefined();
  expect(slim?.tools).toBeUndefined();
  expect(slim?.provider_options).toBeUndefined();
  expect(slim?.conversation).toBeUndefined();
  // Post-dispatch readers keep working off the slimmed request.
  expect(slim?.model).toBe("bansos/test");
  expect(slim?.source_surface).toBe("chat");
  expect(slim?.stream).toBe(true);
  expect(slim?.reasoning).toEqual({ effort: "high" });
  expect(slim?.generation_controls).toEqual({ temperature: 0.7 });
});

test("a projected dispatch copy keeps its own messages array", () => {
  const store = new ProxyRequestStateStore(undefined);
  const state = store.initialize(
    new Request("https://example.test/v1/chat/completions", { method: "POST" }),
    Date.now(),
    60_000,
  );
  const original = bigRequest();
  state.canonicalRequest = original;
  // `projectForRoute` spreads the request: a new object whose `messages`
  // property still points at the original array.
  const projected = { ...original, requiredCapabilities: [] as never[] };
  const projectedMessages = projected.messages;
  expect(projectedMessages.length).toBe(2);
  state.releaseCanonicalMessages();
  expect(state.canonicalRequest?.messages).toEqual([]);
  // The dispatch copy is untouched: a mid-stream retry re-dispatches it.
  expect(projected.messages).toBe(projectedMessages);
  expect(projected.messages.length).toBe(2);
});

test("release slims the prepared request's canonical request too", () => {
  const store = new ProxyRequestStateStore(undefined);
  const state = store.initialize(
    new Request("https://example.test/v1/chat/completions", { method: "POST" }),
    Date.now(),
    60_000,
  );
  const preparedRequest = bigRequest();
  state.canonicalRequest = bigRequest();
  state.preparedRequest = {
    canonicalRequest: preparedRequest,
    authorization: {} as never,
    candidate: {} as never,
    eligibleRouteCandidates: [],
    plan: {} as never,
    caller: {} as never,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    deadlineMs: Date.now() + 60_000,
    routingEngine: {} as never,
    admissionService: {} as never,
  };
  state.releaseCanonicalMessages();
  expect(state.preparedRequest?.canonicalRequest.messages).toEqual([]);
  expect(state.preparedRequest?.canonicalRequest.system).toBeUndefined();
  expect(state.preparedRequest?.canonicalRequest.model).toBe("bansos/test");
});

test("release is a no-op without a canonical request", () => {
  const store = new ProxyRequestStateStore(undefined);
  const state = store.initialize(
    new Request("https://example.test/v1/chat/completions", { method: "POST" }),
    Date.now(),
    60_000,
  );
  expect(() => state.releaseCanonicalMessages()).not.toThrow();
  expect(state.canonicalRequest).toBeUndefined();
  // Releasing twice is safe: the second call finds empty fields.
  state.canonicalRequest = bigRequest();
  state.releaseCanonicalMessages();
  expect(() => state.releaseCanonicalMessages()).not.toThrow();
  expect(state.canonicalRequest?.messages).toEqual([]);
});

test("cleanup drops the prepared plan and staged capture, not just the prompt", () => {
  const store = new ProxyRequestStateStore(undefined);
  const state = store.initialize(
    new Request("https://example.test/v1/chat/completions", { method: "POST" }),
    Date.now(),
    60_000,
  );
  state.canonicalRequest = bigRequest();
  // The prepared request carries the ordered eligible candidates (tens of
  // thousands of objects for a popular model) plus the plan; the staged
  // capture holds the translated exchange. A state retained past its
  // request — an abort-signal listener or a stream closure keeps it
  // reachable for as long as the Response lives — used to pin all three
  // even after the prompt itself was slimmed, because cleanup() never
  // touched them.
  state.preparedRequest = {
    canonicalRequest: bigRequest(),
    authorization: {} as never,
    candidate: {} as never,
    eligibleRouteCandidates: Array.from({ length: 100 }, (_, i) => ({ id: i })) as never,
    plan: {} as never,
    caller: {} as never,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    deadlineMs: Date.now() + 60_000,
    routingEngine: {} as never,
    admissionService: {} as never,
  };
  state.payloadCapture = { request: { body: "x".repeat(1000) } } as never;
  state.ingressBody = { messages: [{ role: "user", content: "x".repeat(1000) }] };

  state.cleanup();

  expect(state.canonicalRequest?.messages).toEqual([]);
  expect(state.preparedRequest).toBeUndefined();
  expect(state.payloadCapture).toBeUndefined();
  expect(state.ingressBody).toBeUndefined();
  // Telemetry scalars survive: the model is what late readers still need.
  expect(state.canonicalRequest?.model).toBe("bansos/test");
  expect(store.statesCount()).toBe(0);
  // Cleanup is idempotent: a second call must not throw.
  expect(() => state.cleanup()).not.toThrow();
});
