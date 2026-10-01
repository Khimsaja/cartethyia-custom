import { describe, expect, test } from "bun:test";
import { ShutdownCoordinator } from "../../src/runtime/lifecycle";
import { ProxyRequestStateStore } from "../../src/transport/request/state";

describe("shutdown abort ordering", () => {
  test("abortAll aborts every tracked controller", () => {
    const store = new ProxyRequestStateStore();
    const first = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
    const second = new Request("https://gateway.test/v1/responses", { method: "POST" });
    const firstState = store.initialize(first, Date.now(), 60_000);
    const secondState = store.initialize(second, Date.now(), 60_000);
    expect(store.activeCount()).toBe(2);

    store.abortAll();

    expect(firstState.abortController.signal.aborted).toBe(true);
    expect(secondState.abortController.signal.aborted).toBe(true);
    // Teardown is `cleanup()` — `abortAll()` signals, the owner cleans up.
    firstState.cleanup();
    secondState.cleanup();
    expect(store.activeCount()).toBe(0);
  });

  test("coordinator aborts in-flight before flushing telemetry", async () => {
    const order: string[] = [];
    const coordinator = new ShutdownCoordinator(
      {
        flushTelemetry: async () => {
          order.push("flush");
        },
        closePools: async () => {
          order.push("close");
        },
      },
      { drainWindowMs: 0, drainTimeoutMs: 50, flushTimeoutMs: 50 },
    );
    // A request must actually be in flight, or the grace window has nothing to
    // wait for and the straggler abort is skipped entirely (there is nothing to
    // abort). Tracking one is what makes this the ordering test it claims to be.
    coordinator.track("req-1");
    coordinator.setAbortInflight(() => {
      order.push("abort");
    });

    await coordinator.begin("SIGTERM");

    expect(order).toEqual(["abort", "flush", "close"]);
  });

  test("a request that finishes inside the grace window is never aborted", async () => {
    const order: string[] = [];
    const coordinator = new ShutdownCoordinator(
      {
        flushTelemetry: async () => {
          order.push("flush");
        },
        closePools: async () => {
          order.push("close");
        },
      },
      { drainWindowMs: 2_000, drainTimeoutMs: 50, flushTimeoutMs: 50 },
    );
    coordinator.track("req-1");
    coordinator.setAbortInflight(() => {
      order.push("abort");
    });
    // The request completes naturally shortly after the drain begins — the
    // common case for an ordinary response. It must be allowed to finish: an
    // immediate abort would truncate it mid-response.
    setTimeout(() => coordinator.untrack("req-1"), 20);

    await coordinator.begin("SIGTERM");

    expect(order).toEqual(["flush", "close"]);
  });

  test("totalShutdownBudgetMs covers the whole drain so the force-exit never cuts it short", () => {
    const coordinator = new ShutdownCoordinator(
      {},
      { drainWindowMs: 20_000, drainTimeoutMs: 8_000, flushTimeoutMs: 1_000 },
    );
    // The budget must exceed the sum of the drain phases; a shorter one would
    // hard-kill a process that was about to finish gracefully.
    expect(coordinator.totalShutdownBudgetMs()).toBeGreaterThan(20_000 + 8_000 + 1_000);
  });
});