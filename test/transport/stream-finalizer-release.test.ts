/**
 * A retained stream graph must not pin the prompt, and a stream the
 * consumer abandoned must not live until the upstream finishes.
 *
 * The full heap snapshot of the 11 Nov 2026 leak run showed ~247
 * StreamFinalizer / StreamEventPipeline pairs retained with no live request
 * state behind them: each one held the projected dispatch copy (a shallow
 * spread whose `messages` still points at the original array) through the
 * adapter's generator chain, ~426 MB of prompt strings in total. Two gaps
 * let that happen:
 *
 * 1. `releaseStreamResources` never slimmed the dispatch copy — the attempt
 *    loop's release only reaches the state's own canonical request, and the
 *    dispatch copy is a separate object. A retained finalizer therefore kept
 *    the whole prompt even after the state was slimmed.
 * 2. An abort that arrived after the outcome was already recorded (a sweep
 *    eviction, an earlier terminal path) returned early without releasing
 *    anything, and a stream whose consumer simply stopped pulling was never
 *    aborted at all — the stall watchdog only fires on upstream silence,
 *    and a producing upstream re-arms it forever.
 *
 * The fix slims the dispatch copy at release, makes a late abort release,
 * and reaps streams with no consumer pull for the no-pull budget.
 */
import { expect, test } from "bun:test";
import { StreamFinalizer } from "../../src/transport/dispatch/streaming/finalize";
import { StreamEventPipeline } from "../../src/transport/dispatch/streaming/encoder";
import { ProxyRequestStateStore } from "../../src/transport/request/state";
import type { ProxyRequestState } from "../../src/transport/request/state";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { PreparedProxyRequest } from "../../src/transport/request/preparer";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import type { AdmissionLease } from "../../src/security/admission/contracts";
import type { Reservation } from "../../src/transport/routing/route-model";
import type { ProviderExchangeCapture } from "../../src/transport/dispatch/attempt-finalize";

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

function makeFinalizer(
  state: ProxyRequestState,
  canonical: CanonicalRequest,
  dispatchRequest: CanonicalRequest,
  noPullTimeoutMs: number,
): StreamFinalizer {
  // The prepared request is the same canonical object the state holds, so
  // the state's release reaches it too — the dispatch copy is the one
  // holder only the finalizer knows about.
  const prepared = {
    canonicalRequest: canonical,
    routingEngine: { release: async () => undefined },
  } as unknown as PreparedProxyRequest;
  state.preparedRequest = prepared;
  const pipeline = new StreamEventPipeline("chat", { created: 1, include_usage: false }, false);
  return new StreamFinalizer(
    {
      state,
      deps: {
        db: undefined as unknown as CartethyiaDatabase,
        poolSelector: undefined,
        telemetryBuffer: undefined,
        snapshotService: undefined,
      },
      prepared,
      dispatchRequest,
      candidate: {
        providerId: "test-provider",
        modelId: "test-model",
        accountId: undefined,
        accountLabel: undefined,
        networkPoolId: undefined,
      },
      lease: undefined as unknown as AdmissionLease,
      reservation: undefined as unknown as Reservation,
      proxySlot: undefined,
      providerCapture: undefined as unknown as ProviderExchangeCapture,
      getIterator: () => (async function* () {})(),
      ttfbFields: () => ({}),
    },
    pipeline,
    { stallTimeoutMs: 360_000, firstChunkTimeoutMs: 200_000, noPullTimeoutMs },
  );
}

function makeState(): { store: ProxyRequestStateStore; state: ProxyRequestState } {
  const store = new ProxyRequestStateStore(undefined);
  const state = store.initialize(
    new Request("https://example.test/v1/chat/completions", { method: "POST" }),
    Date.now(),
    600_000,
  );
  return { store, state };
}

test("release slims the projected dispatch copy, not just the state request", async () => {
  const { store, state } = makeState();
  const canonical = bigRequest();
  state.canonicalRequest = canonical;
  // The dispatch copy is a shallow spread: its own `messages` property
  // keeps the original array, so slimming the state request alone leaves
  // the full prompt reachable through this object.
  const dispatchRequest: CanonicalRequest = { ...canonical };
  const finalizer = makeFinalizer(state, canonical, dispatchRequest, 120_000);

  await finalizer.releaseStreamResources();

  expect(dispatchRequest.messages).toEqual([]);
  expect(dispatchRequest.system).toBeUndefined();
  expect(dispatchRequest.instructions).toBeUndefined();
  expect(dispatchRequest.tools).toBeUndefined();
  expect(dispatchRequest.provider_options).toBeUndefined();
  expect(dispatchRequest.conversation).toBeUndefined();
  // The state request is slimmed by the same release.
  expect(state.canonicalRequest?.messages).toEqual([]);
  // Telemetry scalars survive on both copies.
  expect(dispatchRequest.model).toBe("bansos/test");
  expect(dispatchRequest.source_surface).toBe("chat");
  expect(dispatchRequest.stream).toBe(true);
  // The state is evicted by the release, not left for the backstop sweep.
  expect(store.statesCount()).toBe(0);
});

test("a late abort releases even when the outcome is already recorded", async () => {
  const { store, state } = makeState();
  const canonical = bigRequest();
  state.canonicalRequest = canonical;
  const dispatchRequest: CanonicalRequest = { ...canonical };
  const finalizer = makeFinalizer(state, canonical, dispatchRequest, 120_000);

  // A sweep eviction (or an earlier terminal path) recorded the outcome but
  // never released the stream graph — the abort used to return early here.
  state.completed = true;
  finalizer.onStreamAbort();
  // The release is async (lease release + cleanup in the finally); give the
  // microtasks a chance to run before asserting the eviction.
  await Bun.sleep(0);

  expect(store.statesCount()).toBe(0);
  expect(dispatchRequest.messages).toEqual([]);
  expect(state.canonicalRequest?.messages).toEqual([]);
});

test("the no-pull reaper aborts a stream the consumer abandoned", async () => {
  const { store, state } = makeState();
  const canonical = bigRequest();
  state.canonicalRequest = canonical;
  const dispatchRequest: CanonicalRequest = { ...canonical };
  const finalizer = makeFinalizer(state, canonical, dispatchRequest, 50);

  // A stream with an attached controller and a running keepalive, but a
  // consumer that never pulls: the upstream may keep producing (and the
  // stall watchdog keeps re-arming on every read), so without the reaper
  // this flight lives until the upstream finishes.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      finalizer.attachController(controller);
      finalizer.startClientKeepalive(controller, 10);
    },
  });
  void stream;

  await Bun.sleep(300);

  expect(state.abortController.signal.aborted).toBe(true);
  expect(state.outcome?.status).toBe("cancelled");
  expect(state.outcome?.httpStatus).toBe(499);
  expect(store.statesCount()).toBe(0);
  expect(dispatchRequest.messages).toEqual([]);
  expect(state.canonicalRequest?.messages).toEqual([]);
});
