import { describe, expect, test } from "bun:test";
import { postUpstreamJson } from "../../src/protocol/upstream/post-json";

/**
 * Fix #3: an abandoned streamed upload must not park the wire payload in a
 * suspended serializer, and the upstream fetch must stay abortable through
 * the request signal after `release()` (which clears the deadline arm).
 *
 * Background: heap snapshots of the Linode load test showed one suspended
 * `jsonChunks` generator per aborted streaming request, each holding its
 * ~1.2 MB wire payload via the body stream's `pull` closure, rooted at
 * Bun's native fetch state — 10 payloads / 11.2 MB retained minutes after
 * the load, surviving forced GC. Two defects combined: `jsonBodyStream`
 * had no `cancel()` to settle the serializer, and `postUpstreamJson`
 * handed the fetch only the lifecycle signal, whose abort forwarder is
 * removed by `release()` right after headers arrive — so a client that
 * disconnects mid-stream never aborted the fetch at all.
 */

function makeContext(signal: AbortSignal) {
  return {
    abort_signal: signal,
    deadline: Date.now() + 3_600_000,
    capture_provider_body: false,
  } as never;
}

describe("postUpstreamJson streamed-body release", () => {
  test("cancelling the streamed body settles the serializer and frees the payload", async () => {
    let capturedBody: ReadableStream<Uint8Array> | undefined;
    const outboundFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body as ReadableStream<Uint8Array>;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    // Build the payload in a scope that ends here, so only the WeakRef
    // (and the body stream's serializer) can keep it alive afterwards.
    const ref = await (async () => {
      const payload = {
        model: "mock-deepseek",
        messages: [{ role: "user", content: "x".repeat(1_200_000) }],
        stream: true,
      } as Record<string, unknown>;
      const weak = new WeakRef(payload);
      const stateAc = new AbortController();
      const upstream = await postUpstreamJson(
        "http://127.0.0.1:18099/v1/chat/completions",
        { "content-type": "application/json" },
        payload,
        makeContext(stateAc.signal),
        outboundFetch as never,
        { streamBody: true },
      );
      upstream.release();
      expect(capturedBody).toBeDefined();
      return weak;
    })();

    expect(ref.deref()).toBeDefined();
    // Abandon the upload the way a fetch abort does: cancel the body stream.
    await capturedBody!.cancel();
    Bun.gc(true);
    await Bun.sleep(50);
    Bun.gc(true);
    expect(ref.deref()).toBeUndefined();
  });

  test("draining the streamed body releases the payload even while the stream is retained", async () => {
    let capturedBody: ReadableStream<Uint8Array> | undefined;
    const outboundFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body as ReadableStream<Uint8Array>;
      // Drain the body the way the validated fetch does (`dial()` reads it
      // into bytes before sending). The stream object itself stays referenced
      // afterwards, the way the runtime's native fetch state retains it.
      await new Response(capturedBody).arrayBuffer();
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const ref = await (async () => {
      const payload = {
        model: "mock-deepseek",
        messages: [{ role: "user", content: "x".repeat(1_200_000) }],
        stream: true,
      } as Record<string, unknown>;
      const weak = new WeakRef(payload);
      const stateAc = new AbortController();
      const upstream = await postUpstreamJson(
        "http://127.0.0.1:18099/v1/chat/completions",
        { "content-type": "application/json" },
        payload,
        makeContext(stateAc.signal),
        outboundFetch as never,
        { streamBody: true },
      );
      upstream.release();
      expect(capturedBody).toBeDefined();
      return weak;
    })();

    expect(ref.deref()).toBeDefined();
    // Keep the stream object alive (native fetch state holds it) and GC.
    expect(capturedBody).toBeDefined();
    Bun.gc(true);
    await Bun.sleep(50);
    Bun.gc(true);
    expect(ref.deref()).toBeUndefined();
  });

  test("a bodyEncoder does not create an unused stream that retains the payload", async () => {
    const outboundFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      // The encoder output is the body; no stream is created or drained.
      expect(typeof init?.body === "string").toBe(true);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const ref = await (async () => {
      const payload = {
        model: "mock-deepseek",
        messages: [{ role: "user", content: "x".repeat(1_200_000) }],
        stream: true,
      } as Record<string, unknown>;
      const weak = new WeakRef(payload);
      const stateAc = new AbortController();
      const upstream = await postUpstreamJson(
        "http://127.0.0.1:18099/v1/chat/completions",
        { "content-type": "application/json" },
        payload,
        makeContext(stateAc.signal),
        outboundFetch as never,
        { streamBody: true },
        (p) => JSON.stringify(p),
      );
      upstream.release();
      return weak;
    })();

    expect(ref.deref()).toBeDefined();
    Bun.gc(true);
    await Bun.sleep(50);
    Bun.gc(true);
    expect(ref.deref()).toBeUndefined();
  });

  test("the fetch signal aborts when the request signal aborts after release()", async () => {
    let capturedSignal: AbortSignal | undefined;
    const outboundFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const stateAc = new AbortController();
    const upstream = await postUpstreamJson(
      "http://127.0.0.1:18099/v1/chat/completions",
      { "content-type": "application/json" },
      { model: "mock-deepseek", messages: [], stream: false },
      makeContext(stateAc.signal),
      outboundFetch as never,
    );
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);
    // The adapter releases the deadline arm right after headers arrive.
    upstream.release();
    expect(capturedSignal!.aborted).toBe(false);
    // A client disconnect after release must still abort the fetch.
    stateAc.abort(new DOMException("client disconnect", "AbortError"));
    expect(capturedSignal!.aborted).toBe(true);
    expect(upstream.signal.aborted).toBe(true);
  });
});
