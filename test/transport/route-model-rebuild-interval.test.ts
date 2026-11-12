/**
 * Minimum rebuild interval: a burst of invalidates must not rebuild more
 * than once per interval. The account-health sweep invalidates whenever any
 * account recovers, and each rebuild re-reads the whole catalog and allocates
 * a fresh frozen snapshot; without a floor the sweep's cadence dominates
 * gateway CPU and heap growth.
 */
import { describe, expect, test } from "bun:test";
import { InMemoryRouteSnapshotService } from "../../src/transport/routing/route-model";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("route snapshot minimum rebuild interval", () => {
  test("invalidates within the interval coalesce into one delayed rebuild", async () => {
    let builds = 0;
    const service = new InMemoryRouteSnapshotService(
      async () => {
        builds += 1;
        return { candidates: [], aliases: {}, combos: {} };
      },
      { rebuildDebounceMs: 10, minRebuildIntervalMs: 1500 },
    );
    try {
      // Cold start builds once and stamps the last-rebuild time.
      await service.getSnapshot();
      expect(builds).toBe(1);

      // Two invalidates right after the build: no rebuild yet.
      await service.invalidate();
      await service.invalidate();
      await sleep(300);
      expect(builds).toBe(1);

      // Still inside the interval: the rebuild has not fired.
      await sleep(700);
      expect(builds).toBe(1);

      // Past the interval: the coalesced rebuild fires exactly once.
      await sleep(800);
      expect(builds).toBe(2);
    } finally {
      service.stop();
    }
  });

  test("an invalidate after the interval rebuilds promptly", async () => {
    let builds = 0;
    const service = new InMemoryRouteSnapshotService(
      async () => {
        builds += 1;
        return { candidates: [], aliases: {}, combos: {} };
      },
      { rebuildDebounceMs: 10, minRebuildIntervalMs: 200 },
    );
    try {
      await service.getSnapshot();
      expect(builds).toBe(1);
      await sleep(300);
      await service.invalidate();
      await sleep(100);
      expect(builds).toBe(2);
    } finally {
      service.stop();
    }
  });
});
