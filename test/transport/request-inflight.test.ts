import { expect, test } from "bun:test";
import { ProxyRequestStateStore } from "../../src/transport/request/state";

test("in-flight snapshot tracks requests and distinct client IPs until cleanup", () => {
  const store = new ProxyRequestStateStore();
  const first = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 60_000);
  const second = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 60_000);
  first.clientIdentity = { address: "192.0.2.1", source: "tcp-peer" };
  second.clientIdentity = { address: "192.0.2.1", source: "tcp-peer" };

  first.startProviderFlight();
  second.startProviderFlight();
  expect(store.inFlightSnapshot()).toMatchObject({ inFlight: 2, uniqueIps: 1 });

  first.cleanup();
  expect(store.inFlightSnapshot()).toMatchObject({ inFlight: 1, uniqueIps: 1 });

  second.cleanup();
  expect(store.inFlightSnapshot()).toMatchObject({ inFlight: 0, uniqueIps: 0 });
});

test("a request that never starts a flight is never counted", () => {
  const store = new ProxyRequestStateStore();
  const state = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 60_000);
  state.clientIdentity = { address: "192.0.2.1", source: "tcp-peer" };

  // Registered but never dispatched: the gauge counts provider flights, not
  // raw registrations, so this stays invisible until dispatch happens.
  expect(store.inFlightSnapshot()).toMatchObject({ inFlight: 0, uniqueIps: 0 });

  state.startProviderFlight();
  expect(store.inFlightSnapshot()).toMatchObject({ inFlight: 1, uniqueIps: 1 });
  state.extendDeadline(60_000);
  expect(store.inFlightSnapshot()).toMatchObject({ inFlight: 1, uniqueIps: 1 });

  state.cleanup();
  expect(store.inFlightSnapshot()).toMatchObject({ inFlight: 0, uniqueIps: 0 });
});

test("extendDeadline never moves the deadline past the stream hard ceiling", () => {
  const store = new ProxyRequestStateStore();
  const state = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 60_000);
  const ceiling = Date.now() + 100_000;
  state.hardDeadlineMs = ceiling;

  // The stall watchdog re-arms with a full stall budget on every upstream
  // read; without the clamp each re-arm would push the deadline — and the
  // dispatch graph it pins — forward forever on a dribble stream.
  state.extendDeadline(360_000);
  expect(state.deadlineMs).toBeLessThanOrEqual(ceiling);
  expect(state.deadlineMs).toBeGreaterThan(Date.now());

  // A second re-arm after time has passed still cannot pass the ceiling.
  state.extendDeadline(360_000);
  expect(state.deadlineMs).toBeLessThanOrEqual(ceiling);

  state.cleanup();
});

test("extendDeadline is uncapped while no hard ceiling is set", () => {
  const store = new ProxyRequestStateStore();
  const state = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 60_000);
  const before = Date.now();
  state.extendDeadline(600_000);
  expect(state.deadlineMs).toBeGreaterThanOrEqual(before + 599_000);
  state.cleanup();
});

test("the deadline timer fires at the hard ceiling, not the re-armed budget", async () => {
  const store = new ProxyRequestStateStore();
  const state = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 60_000);
  state.hardDeadlineMs = Date.now() + 50;
  // A watchdog re-arm asking for 10 minutes must still abort at the ceiling.
  state.extendDeadline(600_000);
  expect(state.abortController.signal.aborted).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(state.abortController.signal.aborted).toBe(true);
  state.cleanup();
});
