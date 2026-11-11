/**
 * A terminal event must end the stream even when the upstream never closes.
 *
 * Regression for the 11 Nov 2026 heap leak: after the upstream delivered its
 * terminal event, the gateway kept pulling for the next chunk, parking on the
 * upstream read until the stall watchdog fired minutes later. An upstream that
 * holds the SSE connection open after its terminal event therefore pinned the
 * whole dispatch graph — prompt, adapter generator frame, fetch body — per
 * streamed request, which is what grew the heap ~200 MB/min under agent
 * traffic. Surface encoders reject anything after a terminal event, so no
 * later upstream event can ever be delivered; the stream must finalize on
 * the terminal event itself and settle the upstream iterator there.
 *
 * The stub upstream mirrors a real one: it yields its events, then parks
 * forever on a promise that only rejects when the request aborts — the same
 * shape as the SSE decoder, whose reader is cancelled on abort. A gateway
 * that finalizes on the terminal event therefore ends the client stream
 * promptly *and* unwinds the parked upstream generator; a gateway that
 * waits for the upstream to close never ends the response at all.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestGateway, type TestGateway } from "../helpers/gateway";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe, requireDatabase } from "../helpers/database";
import type { CanonicalEvent } from "../../src/protocol/canonical-model";

requireDatabase();

const USAGE = {
  input_tokens: 12,
  cached_input_tokens: 0,
  cache_write_tokens: 0,
  uncached_input_tokens: 12,
  output_tokens: 4,
  reasoning_tokens: 0,
  estimated_cost: 0,
};

async function readWithTimeout(response: Response, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      response.text(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`response body did not end within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await Bun.sleep(50);
  }
  return condition();
}

dbDescribe("terminal event finalizes the stream", () => {
  let gateway: TestGateway;
  let world: GatewayWorld;
  let upstreamSignal: AbortSignal | undefined;
  let generatorUnwound = false;
  let scenario: "terminal-after-content" | "terminal-first" = "terminal-after-content";

  beforeAll(async () => {
    world = await createWorld();
    gateway = await createTestGateway();
    await gateway.serveWorld(world);
    gateway.adapter(world.providerId, {
      onDispatch: (record) => {
        upstreamSignal = record.context.abort_signal;
      },
      streamEvents: () =>
        (async function* (): AsyncGenerator<CanonicalEvent> {
          try {
            if (scenario === "terminal-first") {
              yield {
                type: "terminal",
                sequence_number: 0,
                state: "complete",
                stop_reason: "stop",
                usage: USAGE,
              };
            } else {
              yield {
                type: "message_start",
                sequence_number: 0,
                event_id: "msg_test",
                model: "test",
              };
              yield {
                type: "content_delta",
                sequence_number: 1,
                content: { kind: "text", text: "Hello" },
              };
              yield {
                type: "terminal",
                sequence_number: 2,
                state: "complete",
                stop_reason: "stop",
                usage: USAGE,
              };
            }
            // Park like an upstream that holds the SSE connection open
            // after its terminal event. The real SSE decoder cancels its
            // reader when the request aborts; mirror that here so the test
            // proves the gateway aborts the upstream, not that the mock
            // is uncancellable.
            await new Promise<void>((_, reject) => {
              const signal = upstreamSignal;
              if (signal?.aborted) {
                reject(signal.reason);
                return;
              }
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          } finally {
            generatorUnwound = true;
          }
        })(),
    });
  });

  afterAll(async () => {
    await gateway?.close();
    await world?.cleanup();
  });

  test("response ends promptly after the terminal event", async () => {
    scenario = "terminal-after-content";
    generatorUnwound = false;
    const response = await gateway.json(
      "/v1/chat/completions",
      {
        model: world.qualifiedModel,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      { token: world.token },
    );
    expect(response.status).toBe(200);
    // Without the fix this read never resolves: the gateway parks on the
    // upstream until the stall watchdog fires minutes later.
    const text = await readWithTimeout(response, 10_000);
    expect(text).toContain("Hello");
    // The parked upstream generator must have been settled (its return()
    // queued at finalize) and unwound by the release abort.
    expect(await waitFor(() => generatorUnwound, 5_000)).toBe(true);
  });

  test("response ends promptly when the first event is already terminal", async () => {
    scenario = "terminal-first";
    generatorUnwound = false;
    const response = await gateway.json(
      "/v1/chat/completions",
      {
        model: world.qualifiedModel,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      { token: world.token },
    );
    expect(response.status).toBe(200);
    const text = await readWithTimeout(response, 10_000);
    expect(text.length).toBeGreaterThan(0);
    expect(await waitFor(() => generatorUnwound, 5_000)).toBe(true);
  });
});
