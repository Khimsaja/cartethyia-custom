import { describe, expect, test } from "bun:test";
import { createInFlightRegistry } from "../../../src/transport/request/inflight";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";

describe("in-flight registry", () => {
  test("starts empty and tracks flights by request id", () => {
    const registry = createInFlightRegistry();
    expect(registry.count()).toBe(0);
    expect(registry.snapshot()).toEqual({ inFlight: 0, uniqueIps: 0 });
    registry.track("r1", "1.1.1.1", Date.now() + 1000);
    registry.track("r2", "2.2.2.2", Date.now() + 1000);
    expect(registry.count()).toBe(2);
    expect(registry.snapshot()).toEqual({ inFlight: 2, uniqueIps: 2 });
  });

  test("one IP with concurrent flights counts once in uniqueIps", () => {
    const registry = createInFlightRegistry();
    registry.track("r1", "1.1.1.1", Date.now() + 1000);
    registry.track("r2", "1.1.1.1", Date.now() + 1000);
    registry.track("r3", "2.2.2.2", Date.now() + 1000);
    expect(registry.snapshot()).toEqual({ inFlight: 3, uniqueIps: 2 });
  });

  test("untracking an unknown id is a no-op, never negative", () => {
    const registry = createInFlightRegistry();
    registry.untrack("nope");
    expect(registry.count()).toBe(0);
    registry.track("r1", "1.1.1.1", Date.now() + 1000);
    registry.untrack("r1");
    registry.untrack("r1");
    expect(registry.snapshot()).toEqual({ inFlight: 0, uniqueIps: 0 });
  });

  test("notifies subscribers with the snapshot on every change and unsubscribes cleanly", () => {
    const registry = createInFlightRegistry();
    const seen: Array<{ inFlight: number; uniqueIps: number }> = [];
    const stop = registry.subscribe((snapshot) => seen.push(snapshot));
    registry.track("r1", "1.1.1.1", Date.now() + 1000);
    registry.track("r2", "1.1.1.1", Date.now() + 1000);
    registry.untrack("r1");
    stop();
    registry.track("r3", "3.3.3.3", Date.now() + 1000);
    expect(seen).toEqual([
      { inFlight: 1, uniqueIps: 1 },
      { inFlight: 2, uniqueIps: 1 },
      { inFlight: 1, uniqueIps: 1 },
    ]);
  });

  test("overdue lists only flights past their deadline plus grace", () => {
    const registry = createInFlightRegistry();
    const now = Date.now();
    registry.track("fresh", "1.1.1.1", now + 60_000);
    registry.track("stale", "2.2.2.2", now - 60_000);
    expect(registry.overdue(now, 30_000)).toEqual(["stale"]);
  });

  test("extend moves a flight's deadline so a long stream is not swept", () => {
    const registry = createInFlightRegistry();
    const now = Date.now();
    registry.track("r1", "1.1.1.1", now - 1_000);
    registry.extend("r1", now + 60_000);
    expect(registry.overdue(now, 30_000)).toEqual([]);
  });
});

describe("request state store in-flight funnel", () => {
  test("request initialization is not counted before provider dispatch", () => {
    const store = new ProxyRequestStateStore();
    const state = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 1000);
    expect(store.inFlightCount()).toBe(0);
    state.cleanup();
  });

  test("provider dispatch is counted once and cleanup releases exactly once", () => {
    const store = new ProxyRequestStateStore();
    const state = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 1000);
    state.startProviderFlight();
    state.startProviderFlight();
    expect(store.inFlightCount()).toBe(1);
    expect(store.inFlightSnapshot().uniqueIps).toBe(1);
    state.cleanup();
    expect(store.inFlightCount()).toBe(0);
  });

  test("cleanup before dispatch cannot start a flight afterward", () => {
    const store = new ProxyRequestStateStore();
    const state = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 1000);
    state.cleanup();
    state.startProviderFlight();
    expect(store.inFlightCount()).toBe(0);
  });

  test("double cleanup of one flight releases exactly once", () => {
    const store = new ProxyRequestStateStore();
    const state = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 1000);
    state.startProviderFlight();
    expect(store.inFlightCount()).toBe(1);
    state.cleanup();
    state.cleanup();
    expect(store.inFlightCount()).toBe(0);
  });

  test("two concurrent flights from one IP share one unique IP", () => {
    const store = new ProxyRequestStateStore();
    const first = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 1000);
    const second = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 1000);
    first.clientIdentity = { address: "9.9.9.9", source: "tcp-peer" };
    second.clientIdentity = { address: "9.9.9.9", source: "tcp-peer" };
    first.startProviderFlight();
    second.startProviderFlight();
    expect(store.inFlightSnapshot()).toEqual({ inFlight: 2, uniqueIps: 1 });
    first.cleanup();
    second.cleanup();
  });

  test("cleanup unregisters the request tracker exactly once", () => {
    let untracked = 0;
    const store = new ProxyRequestStateStore({
      track: () => undefined,
      untrack: () => {
        untracked += 1;
      },
    });
    const state = store.initialize(new Request("https://gateway.test/v1/chat/completions"), Date.now(), 60_000);
    state.cleanup();
    state.cleanup();
    expect(untracked).toBe(1);
  });

  test("cleanup executes a callback registered afterward immediately", () => {
    const store = new ProxyRequestStateStore();
    const state = store.initialize(new Request("https://gateway.test/v1/chat/completions"), Date.now(), 60_000);
    state.cleanup();
    let called = false;
    state.addCleanup(() => {
      called = true;
    });
    expect(called).toBe(true);
  });
});

describe("in-flight backstop sweep", () => {
  test("aborts a flight past its deadline and force-releases one the abort cannot reach", () => {
    // A request whose dispatch flight was started but whose cleanup never runs
    // is exactly the leak the backstop exists to end: the gauge would stay up
    // forever. Past the hard grace it is force-dropped, logged, not silent.
    const store = new ProxyRequestStateStore();
    const state = store.initialize(
      new Request("https://gateway.test/v1/chat/completions"),
      Date.now(),
      1_000,
    );
    state.startProviderFlight();
    expect(store.inFlightCount()).toBe(1);
    // Well past deadline + hard grace: the sweep must leave the gauge at zero.
    const released = store.sweepOverdueInFlight(Date.now() + 10 * 60_000, 30_000, 120_000);
    expect(released).toBe(1);
    expect(store.inFlightCount()).toBe(0);
  });

  test("leaves a healthy flight whose deadline has not passed", () => {
    const store = new ProxyRequestStateStore();
    const state = store.initialize(
      new Request("https://gateway.test/v1/chat/completions"),
      Date.now(),
      60_000,
    );
    state.startProviderFlight();
    const released = store.sweepOverdueInFlight(Date.now(), 30_000, 120_000);
    expect(released).toBe(0);
    expect(store.inFlightCount()).toBe(1);
    state.cleanup();
  });
});
