/**
 * Two-tier invalidation gating for the route snapshot.
 *
 * Regression lock for the 2026-11-11 OOM-kill follow-up: the first fix
 * (a2b936a8) coalesced all invalidations into one rebuild per 30 s window,
 * but health/probe churn (~100 invalidations/min) still drove a rebuild
 * every ~35-40 s and RSS grew ~600 MB/min until the restart protocol
 * stopped the gateway at 3.5 GB. Health/probe invalidations now batch on
 * a long background window while operator (console) edits keep the short
 * window — and no invalidation is ever lost: the timer guarantees the
 * rebuild, an operator invalidate pulls a pending background one forward,
 * and a mid-build one is repaid as exactly one follow-up.
 */
import { describe, expect, test } from "bun:test";
import { InMemoryRouteSnapshotService } from "../../src/transport/routing/route-model";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeService(builds: { count: number }, mode: { current: string }) {
  return new InMemoryRouteSnapshotService(
    async () => {
      builds.count += 1;
      return {
        candidates: [],
        aliases: {},
        combos: {},
        created_at: mode.current === "v1" ? 111 : mode.current === "v2" ? 222 : 333,
      };
    },
    // Production uses 90 s / 300 s; the tests use 100 ms / 500 ms so the
    // same tiering logic runs in under a second.
    { rebuildDebounceMs: 100, backgroundDebounceMs: 500 },
  );
}

describe("snapshot invalidation gating", () => {
  test(
    "a burst of background invalidations triggers exactly one rebuild per window",
    async () => {
      const builds = { count: 0 };
      const mode = { current: "v1" };
      const svc = makeService(builds, mode);
      const first = await svc.getSnapshot();
      expect(first.created_at).toBe(111);
      expect(builds.count).toBe(1);

      mode.current = "v2";
      for (let i = 0; i < 10; i += 1) await svc.invalidateBackground();
      // Nothing rebuilds synchronously: the old snapshot keeps serving
      // while the background batch window is pending.
      const during = await svc.getSnapshot();
      expect(during.created_at).toBe(111);
      expect(builds.count).toBe(1);

      await sleep(900); // Past the 500 ms background window + the one rebuild.
      expect(builds.count).toBe(2);
      const after = await svc.getSnapshot();
      expect(after.created_at).toBe(222);

      // A second burst inside a fresh window coalesces the same way.
      mode.current = "v3";
      for (let i = 0; i < 10; i += 1) await svc.invalidateBackground();
      await sleep(900);
      expect(builds.count).toBe(3);
      expect((await svc.getSnapshot()).created_at).toBe(333);
      svc.stop();
      svc.unsubscribe();
    },
    30000,
  );

  test(
    "an operator invalidation pulls a pending background rebuild forward",
    async () => {
      const builds = { count: 0 };
      const mode = { current: "v1" };
      const svc = makeService(builds, mode);
      await svc.getSnapshot();
      expect(builds.count).toBe(1);

      mode.current = "v2";
      await svc.invalidateBackground(); // Schedules the 500 ms background timer.
      await sleep(50);
      await svc.invalidate(); // Operator: must shorten the timer to 100 ms.
      await sleep(300); // Past the operator window, well short of 500 ms.
      expect(builds.count).toBe(2);
      expect((await svc.getSnapshot()).created_at).toBe(222);
      svc.stop();
      svc.unsubscribe();
    },
    30000,
  );

  test(
    "a background invalidation never lengthens a pending operator rebuild",
    async () => {
      const builds = { count: 0 };
      const mode = { current: "v1" };
      const svc = makeService(builds, mode);
      await svc.getSnapshot();
      expect(builds.count).toBe(1);

      mode.current = "v2";
      await svc.invalidate(); // Schedules the 100 ms operator timer.
      await sleep(50);
      await svc.invalidateBackground(); // Must not push the timer to 500 ms.
      await sleep(300);
      expect(builds.count).toBe(2);
      expect((await svc.getSnapshot()).created_at).toBe(222);
      svc.stop();
      svc.unsubscribe();
    },
    30000,
  );

  test(
    "a background invalidation that lands while a build runs is repaid exactly once",
    async () => {
      const builds = { count: 0 };
      const mode = { current: "v1" };
      let releaseBuild: (() => void) | undefined;
      const svc = new InMemoryRouteSnapshotService(
        async () => {
          builds.count += 1;
          if (mode.current === "v2") {
            // Hold the v2 build open so the invalidate lands mid-build.
            await new Promise<void>((resolve) => {
              releaseBuild = resolve;
            });
          }
          return {
            candidates: [],
            aliases: {},
            combos: {},
            created_at: mode.current === "v1" ? 111 : mode.current === "v2" ? 222 : 333,
          };
        },
        { rebuildDebounceMs: 100, backgroundDebounceMs: 500 },
      );
      await svc.getSnapshot();
      expect(builds.count).toBe(1);

      mode.current = "v2";
      const invalidatePromise = svc.invalidateBackground();
      await sleep(700); // Timer fires; the v2 build starts and blocks.
      mode.current = "v3";
      await invalidatePromise;
      await svc.invalidateBackground(); // Lands mid-build: owed exactly one follow-up.
      releaseBuild?.();
      // v2 build settles + debounced v3 follow-up runs on the background window.
      await sleep(1200);
      expect(builds.count).toBe(3);
      expect((await svc.getSnapshot()).created_at).toBe(333);
      svc.stop();
      svc.unsubscribe();
    },
    30000,
  );

  test(
    "a background invalidation is not lost when it arrives during an operator rebuild",
    async () => {
      const builds = { count: 0 };
      const mode = { current: "v1" };
      let releaseBuild: (() => void) | undefined;
      const svc = new InMemoryRouteSnapshotService(
        async () => {
          builds.count += 1;
          if (mode.current === "v2") {
            await new Promise<void>((resolve) => {
              releaseBuild = resolve;
            });
          }
          return {
            candidates: [],
            aliases: {},
            combos: {},
            created_at: mode.current === "v1" ? 111 : mode.current === "v2" ? 222 : 333,
          };
        },
        { rebuildDebounceMs: 100, backgroundDebounceMs: 500 },
      );
      await svc.getSnapshot();
      expect(builds.count).toBe(1);

      mode.current = "v2";
      void svc.invalidate();
      await sleep(300); // Operator timer fires; the v2 build starts and blocks.
      mode.current = "v3";
      await svc.invalidateBackground(); // Mid-build: must survive as a follow-up.
      releaseBuild?.();
      await sleep(1200);
      expect(builds.count).toBe(3);
      expect((await svc.getSnapshot()).created_at).toBe(333);
      svc.stop();
      svc.unsubscribe();
    },
    30000,
  );
});
