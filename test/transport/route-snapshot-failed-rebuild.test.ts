/**
 * A failing snapshot build must still collect its partial snapshot.
 *
 * The snapshot rebuild follows upstream (no minimum rebuild interval):
 * a second invalidation retries after the debounce, so a failing catalog
 * can retry on every invalidation. The partial snapshot from each failed
 * attempt is still collected via Bun.gc, so the garbage does not pile up
 * (2026-11-14: 8 failed attempts in 10 minutes took the gateway from
 * 1.4GB to 9.2GB RSS because nothing collected the partial snapshots).
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
      // A second invalidation retries after the debounce: there is no
      // minimum rebuild interval, so the failed attempt does not block
      // the retry.
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
