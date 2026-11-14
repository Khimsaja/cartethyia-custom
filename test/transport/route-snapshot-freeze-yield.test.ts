/**
 * Snapshot builds must not block the event loop.
 *
 * Freezing a ~750k-candidate snapshot in one synchronous pass blocked the
 * loop for ~2s (measured 2026-11-14), long enough for pool checkout timers
 * to expire and queued requests to flood the pool at once — the connect
 * timeouts behind the `/v1/models` 503 bursts. A build must yield while it
 * freezes, so a timer scheduled during the build fires before the build
 * resolves.
 */
import { describe, expect, test } from "bun:test";
import {
  InMemoryRouteSnapshotService,
  type RouteCandidate,
} from "../../src/transport/routing/route-model";

const CANDIDATE_COUNT = 150_000;

function makeCandidates(count: number): RouteCandidate[] {
  const profile = { image: true, tools: true };
  const candidates: RouteCandidate[] = [];
  for (let index = 0; index < count; index += 1) {
    candidates.push({
      provider_id: "qoder",
      model_id: "qwen3.8-flash",
      wire_family: "openai",
      service_kind: "llm",
      endpoint: "/v1/chat/completions",
      capability_profile: profile,
      tenant_id: null,
      owner_tenant_id: null,
      provider_account_id: `acc-${index % 1500}`,
    } as unknown as RouteCandidate);
  }
  return candidates;
}

describe("snapshot build event-loop yield", () => {
  test("a timer scheduled during a large build fires before the build resolves", async () => {
    const service = new InMemoryRouteSnapshotService(async () => ({
      candidates: makeCandidates(CANDIDATE_COUNT),
      aliases: {},
      combos: {},
    }));
    try {
      let timerFired = false;
      setTimeout(() => {
        timerFired = true;
      }, 0);
      const snapshot = await service.getSnapshot();
      expect(timerFired).toBe(true);
      expect(snapshot.candidates.length).toBe(CANDIDATE_COUNT);
      // The yield must not weaken the freeze: the published snapshot is
      // still fully frozen.
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.candidates)).toBe(true);
      expect(Object.isFrozen(snapshot.candidates[0])).toBe(true);
      expect(Object.isFrozen(snapshot.candidates[CANDIDATE_COUNT - 1])).toBe(true);
    } finally {
      service.stop();
    }
  });
});
