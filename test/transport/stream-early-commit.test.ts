/**
 * Early commit races the first upstream event against a commit budget.
 *
 * The race must preserve pre-commit failover exactly: a first event that
 * settles (resolved or rejected) inside the budget returns its outcome to
 * the caller, so a fast failure still throws to the attempt loop. Only a
 * first event that is still pending when the budget elapses takes the
 * timeout branch, and the returned promise stays alive for the stream's
 * `start()` to finish priming after the stream is committed.
 */
import { expect, test } from "bun:test";
import { raceFirstEvent } from "../../src/transport/dispatch/streaming/stream";
import type { CanonicalEvent } from "../../src/protocol/canonical-model";

function fakeEvent(): IteratorResult<CanonicalEvent> {
  return {
    done: false,
    value: { type: "content_delta" } as unknown as CanonicalEvent,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("returns the first event when it settles within the budget", async () => {
  const event = fakeEvent();
  const raced = await raceFirstEvent(Promise.resolve(event), 1_000);
  expect(raced.timedOut).toBe(false);
  if (!raced.timedOut) expect(raced.first).toBe(event);
});

test("rethrows a fast failure so the attempt loop can fail over", async () => {
  const failure = new Error("upstream refused");
  await expect(raceFirstEvent(Promise.reject(failure), 1_000)).rejects.toBe(failure);
});

test("returns the pending promise when the budget elapses first", async () => {
  const event = fakeEvent();
  const gate = deferred<IteratorResult<CanonicalEvent>>();
  const raced = await raceFirstEvent(gate.promise, 1);
  expect(raced.timedOut).toBe(true);
  if (raced.timedOut) {
    gate.resolve(event);
    await expect(raced.pending).resolves.toBe(event);
  }
});

test("a failure after the budget elapses stays observable on the pending promise", async () => {
  const failure = new Error("upstream died mid-prime");
  const gate = deferred<IteratorResult<CanonicalEvent>>();
  const raced = await raceFirstEvent(gate.promise, 1);
  expect(raced.timedOut).toBe(true);
  if (raced.timedOut) {
    gate.reject(failure);
    await expect(raced.pending).rejects.toBe(failure);
  }
});
