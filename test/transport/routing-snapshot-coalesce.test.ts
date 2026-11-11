/**
 * Invalidation bursts must coalesce into a single background rebuild.
 *
 * Regression lock for the 2026-11-11 OOM-kill: invalidate() used to drop
 * the snapshot cache, so the next request paid a full ~1 GB rebuild — and
 * health churn (~100 invalidates/min) drove a rebuild every ~20-40 s
 * until RSS hit 15.6 GB and the kernel killed the gateway. invalidate()
 * now keeps serving the previous snapshot and schedules one debounced
 * background rebuild per window; a burst collapses into that single
 * rebuild, and the new snapshot lands when it completes.
 */
import { describe, expect, test } from "bun:test";
import { InMemoryRouteSnapshotService } from "../../src/transport/routing/route-model";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("snapshot rebuild coalescing", () => {
  test(
    "a burst of invalidates triggers exactly one background rebuild",
    async () => {
      let builds = 0;
      let mode: "v1" | "v2" = "v1";
      const svc = new InMemoryRouteSnapshotService(
        async () => {
          builds += 1;
          return {
            candidates: [],
            aliases: {},
            combos: {},
            created_at: mode === "v1" ? 111 : 222,
          };
        },
        { rebuildDebounceMs: 100 },
      );
      const first = await svc.getSnapshot();
      expect(first.created_at).toBe(111);
      expect(builds).toBe(1);

      mode = "v2";
      for (let i = 0; i < 5; i += 1) await svc.invalidate();
      // The burst must not have rebuilt synchronously: the old snapshot
      // keeps serving while the debounced rebuild is pending.
      const during = await svc.getSnapshot();
      expect(during.created_at).toBe(111);
      expect(builds).toBe(1);

      await sleep(1200); // Past the 100 ms debounce + the one rebuild.
      expect(builds).toBe(2);
      const after = await svc.getSnapshot();
      expect(after.created_at).toBe(222);
      svc.stop();
      svc.unsubscribe();
    },
    30000,
  );

  test(
    "an invalidation that lands while a build runs is repaid exactly once",
    async () => {
      let builds = 0;
      let mode: "v1" | "v2" | "v3" = "v1";
      let releaseBuild: (() => void) | undefined;
      const svc = new InMemoryRouteSnapshotService(
        async () => {
          builds += 1;
          if (mode === "v2") {
            // Hold the v2 build open so the invalidate lands mid-build.
            await new Promise<void>((resolve) => {
              releaseBuild = resolve;
            });
          }
          return {
            candidates: [],
            aliases: {},
            combos: {},
            created_at: mode === "v1" ? 111 : mode === "v2" ? 222 : 333,
          };
        },
        { rebuildDebounceMs: 100 },
      );
      const first = await svc.getSnapshot();
      expect(first.created_at).toBe(111);
      expect(builds).toBe(1);

      mode = "v2";
      const invalidatePromise = svc.invalidate();
      await sleep(300); // Timer fires; the v2 build starts and blocks.
      mode = "v3";
      await invalidatePromise;
      await svc.invalidate(); // Lands mid-build: owed exactly one follow-up.
      releaseBuild?.();
      await sleep(1200); // v2 build settles + debounced v3 follow-up runs.
      expect(builds).toBe(3);
      const after = await svc.getSnapshot();
      expect(after.created_at).toBe(333);
      svc.stop();
      svc.unsubscribe();
    },
    30000,
  );
});
