/**
 * Boot warm-up retries the first snapshot build instead of leaving the
 * snapshot cold after one failed attempt (2026-11-11: the Postgres pool
 * was saturated at boot, so the first /v1/models after a restart paid a
 * ~20 s synchronous build).
 */
import { describe, expect, test } from "bun:test";
import { InMemoryRouteSnapshotService } from "../../src/transport/routing/route-model";

const snapshot = (created_at: number) => ({
  candidates: [],
  aliases: {},
  combos: {},
  created_at,
});

describe("route snapshot warmup", () => {
  test("retries a failing build until it succeeds", async () => {
    let calls = 0;
    const svc = new InMemoryRouteSnapshotService(async () => {
      calls += 1;
      if (calls < 3) throw new Error("boom");
      return snapshot(111);
    });
    await svc.warmup({ attempts: 3, delaysMs: [1, 1] });
    expect(calls).toBe(3);
    expect((await svc.getSnapshot()).created_at).toBe(111);
    svc.unsubscribe();
  });

  test("never throws when every attempt fails", async () => {
    let calls = 0;
    const svc = new InMemoryRouteSnapshotService(async () => {
      calls += 1;
      throw new Error("boom");
    });
    await svc.warmup({ attempts: 3, delaysMs: [1, 1] });
    expect(calls).toBe(3);
    svc.unsubscribe();
  });

  test("succeeds immediately when the first build works", async () => {
    let calls = 0;
    const svc = new InMemoryRouteSnapshotService(async () => {
      calls += 1;
      return snapshot(222);
    });
    await svc.warmup({ attempts: 3, delaysMs: [1, 1] });
    expect(calls).toBe(1);
    expect((await svc.getSnapshot()).created_at).toBe(222);
    svc.unsubscribe();
  });
});
