/**
 * A failing snapshot build must not leak its partial snapshot.
 *
 * The minimum rebuild interval that used to throttle retries was removed
 * by operator decision 2026-11-18 (pure upstream rebuild: debounce only).
 * A failed build therefore retries on the next invalidation; what must
 * still hold is that its partial snapshot is collected instead of piling
 * up (2026-11-14: 8 failed attempts in 10 minutes took the gateway from
 * 1.4GB to 9.2GB RSS when nothing collected the partial snapshots).
 */
import { describe, expect, test } from "bun:test";
import { InMemoryRouteSnapshotService } from "../../src/transport/routing/route-model";

describe("failed snapshot rebuild", () => {
  test("a failed build is collected and retries on the next invalidation", async () => {
    let builds = 0;
    const service = new InMemoryRouteSnapshotService(
      async () => {
        builds += 1;
        throw new Error("boom");
      },
      { rebuildDebounceMs: 5 },
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
      // With no rebuild floor, the next invalidation retries after the
      // debounce — the failed attempt is collected, not left to pile up.
      await service.invalidate();
      await Bun.sleep(50);
      expect(builds).toBe(2);
      expect(gcCalls).toBeGreaterThanOrEqual(2);
    } finally {
      (Bun as unknown as { gc: (force?: boolean) => void }).gc = originalGc;
      service.stop();
    }
  });
});
