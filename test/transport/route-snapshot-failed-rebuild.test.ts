/**
 * A failing snapshot build must not spin the gateway into a rebuild loop.
 *
 * 2026-11-14: with the minimum rebuild interval stamped only on success,
 * a failing catalog retried on every invalidation; each attempt allocated
 * a fresh ~1GB snapshot that nothing collected (8 failed attempts in 10
 * minutes took the gateway from 1.4GB to 9.2GB RSS, and the pool timeouts
 * that failed the builds kept coming). A failed attempt must count against
 * the interval, and its partial snapshot must be collected.
 */
import { describe, expect, test } from "bun:test";
import { InMemoryRouteSnapshotService } from "../../src/transport/routing/route-model";

describe("failed snapshot rebuild", () => {
  test("a failed build is collected and does not retry before the interval", async () => {
    let builds = 0;
    const service = new InMemoryRouteSnapshotService(
      async () => {
        builds += 1;
        throw new Error("boom");
      },
      { rebuildDebounceMs: 5, minRebuildIntervalMs: 200 },
    );
    const originalGc = Bun.gc;
    let gcCalls = 0;
    (Bun as unknown as { gc: (force?: boolean) => void }).gc = () => {
      gcCalls += 1;
    };
    try {
      await service.invalidate();
      await Bun.sleep(50);
      expect(builds).toBe(1);
      expect(gcCalls).toBeGreaterThanOrEqual(1);
      // A second invalidation right after the failure must not rebuild
      // immediately: the failed attempt counts against the interval.
      await service.invalidate();
      await Bun.sleep(50);
      expect(builds).toBe(1);
      // ...but the retry still happens once the interval elapses.
      await Bun.sleep(200);
      expect(builds).toBe(2);
    } finally {
      (Bun as unknown as { gc: (force?: boolean) => void }).gc = originalGc;
      service.stop();
    }
  });
});
