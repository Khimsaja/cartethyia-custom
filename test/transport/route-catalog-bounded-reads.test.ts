/**
 * `runBounded`: the snapshot rebuild's catalog reads run with bounded
 * concurrency.
 *
 * The rebuild's fourteen catalog reads used to start together in one
 * `Promise.all`, claiming fourteen pool connections in the same instant a
 * burst of key lookups needed them — one of the ways a rebuild turned into
 * connect timeouts for everyone (2026-11-14). The runner caps the lanes
 * while preserving result order.
 */
import { describe, expect, test } from "bun:test";
import { runBounded } from "../../src/transport/routing/route-catalog";

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("runBounded", () => {
  test("never exceeds the concurrency limit and preserves result order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tasks = Array.from({ length: 14 }, (_, index) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(10);
      inFlight -= 1;
      return index * 2;
    });
    const results = await runBounded(tasks, 4);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(results).toEqual(Array.from({ length: 14 }, (_, index) => index * 2));
  });

  test("a rejection rejects the whole run", async () => {
    const tasks = [
      async () => 1,
      async () => {
        throw new Error("boom");
      },
      async () => 3,
    ];
    await expect(runBounded(tasks, 2)).rejects.toThrow("boom");
  });
});
