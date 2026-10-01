import { describe, expect, test } from "bun:test";
import { runSweep } from "../../src/workers/sweep";

/**
 * The paced path runs the batch sequentially with a pause between items — the
 * shape the OAuth refresh sweep uses because token endpoints rate-limit a
 * burst. These tests pin that contract without touching the network: the sleep
 * is injected, so the delay is observed rather than waited out.
 */
describe("runSweep pace", () => {
  test("runs items sequentially with a delay between them, never after the last", async () => {
    const order: number[] = [];
    const sleeps: number[] = [];
    const result = await runSweep<number>({
      name: "test-pace",
      list: async () => [1, 2, 3],
      run: async (item) => {
        order.push(item);
      },
      pace: {
        interItemDelayMs: 50,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });

    // Sequential: no interleaving, order preserved.
    expect(order).toEqual([1, 2, 3]);
    // Two gaps for three items — the trailing gap is skipped.
    expect(sleeps).toEqual([50, 50]);
    expect(result.attempted).toBe(3);
    expect(result.failed).toBe(0);
  });

  test("a zero delay runs sequentially without sleeping", async () => {
    const sleeps: number[] = [];
    await runSweep<number>({
      name: "test-pace-zero",
      list: async () => [1, 2],
      run: async () => {},
      pace: { interItemDelayMs: 0, sleep: async (ms) => void sleeps.push(ms) },
    });
    expect(sleeps).toEqual([]);
  });

  test("a failing item does not stop the paced pass and is counted", async () => {
    const seen: number[] = [];
    const result = await runSweep<number>({
      name: "test-pace-fail",
      list: async () => [1, 2, 3],
      run: async (item) => {
        seen.push(item);
        if (item === 2) throw new Error("boom");
      },
      pace: { interItemDelayMs: 0 },
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(result.failed).toBe(1);
    expect(result.attempted).toBe(3);
  });
});
