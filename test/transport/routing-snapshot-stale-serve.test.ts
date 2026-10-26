/**
 * A failed debounced snapshot rebuild must not 500 the data plane.
 *
 * Regression lock for the 2026-10-26 internal_error bursts: runDebouncedRebuild
 * used to clear the snapshot first and then await a fresh build, so a failed
 * build rejected every request waiting on it — a minute-burst of 500
 * internal_error across all models, with nothing in the journal. The rebuild
 * now serves the previous snapshot while building and swaps only on success.
 */
import { describe, expect, test } from "bun:test";
import { InMemoryRouteSnapshotService } from "../../src/transport/routing/route-model";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("stale snapshot during rebuild", () => {
  test(
    "a failed debounced rebuild keeps serving the previous snapshot",
    async () => {
      let mode: "v1" | "fail" | "v2" = "v1";
      const svc = new InMemoryRouteSnapshotService(async () => {
        if (mode === "fail") throw new Error("boom");
        return {
          candidates: [],
          aliases: {},
          combos: {},
          created_at: mode === "v1" ? 111 : 222,
        };
      });
      const first = await svc.getSnapshot();
      expect(first.created_at).toBe(111);

      mode = "fail";
      await svc.invalidate();
      await sleep(6500); // Past DEBOUNCE_MS (5000).
      const during = await svc.getSnapshot();
      expect(during.created_at).toBe(111); // Old snapshot, no throw.

      mode = "v2";
      await svc.invalidate();
      await sleep(6500);
      const after = await svc.getSnapshot();
      expect(after.created_at).toBe(222);
      svc.unsubscribe();
    },
    30000,
  );
});
