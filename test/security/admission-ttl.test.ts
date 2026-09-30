import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import type { RedisClient } from "../../src/persistence/redis";
import { RedisAdmissionCounterStore } from "../../src/security/admission";

/**
 * Redis-gated regression suite for the token-budget counter TTLs.
 *
 * The defect this pins: the bucket counters are the only thing bounding
 * `admission:lifetime:*`, and two writes used to drop that bound. The reserve
 * script seeded a missing lifetime counter with a plain `SET` (no TTL), and
 * `RECONCILE_SCRIPT` wrote every bucket with a plain `SET`, which replaces the
 * key and strips the expiry the reserve script had just armed. A counter with
 * no expiry is never reclaimed, so a busy key's lifetime total leaked in Redis
 * forever — and a rejected reserve leaked it too, because the seed runs before
 * the budget check that returns early.
 *
 * That is why this suite talks to a real server: `TTL` is server state, so a
 * scripted fake cannot witness the bug. It is gated on the same opt-in as the
 * other live-service checks — no `CARTETHYIA_TEST_REDIS_URL`, no run.
 *
 * Every key is namespaced per run and the teardown removes exactly this run's
 * keys. That matters more than it looks: the store builds its keys from the
 * api-key id (`admission:lifetime:<id>`), so a fixed id would let one run's
 * counters survive into the next and make an assertion pass against leftover
 * state instead of the code under test. A per-run token makes every run start
 * from an empty namespace, which is what makes the assertions mean anything.
 */

const url = process.env.CARTETHYIA_TEST_REDIS_URL?.trim();

if (!url) {
  console.info(
    "[redis-admission-ttl] skipped: set CARTETHYIA_TEST_REDIS_URL to an isolated Redis to run live TTL checks",
  );
}

const redisDescribe = url ? describe : describe.skip;

redisDescribe("admission counter TTLs (live Redis)", () => {
  let redis: Redis;
  let store: RedisAdmissionCounterStore;
  /** Per-run namespace; unique so no run can read another's counters. */
  let run: string;

  beforeAll(async () => {
    redis = new Redis(url!, { maxRetriesPerRequest: 2 });
    await redis.ping();
    store = new RedisAdmissionCounterStore(redis as unknown as RedisClient);
    run = `cartethyia:test:admission-ttl:${process.pid}:${Date.now()}`;
  });

  afterAll(async () => {
    // The store derives its keys from the api-key id, so this run's keys all
    // contain the run token even though their prefixes differ
    // (`admission:lifetime:*`, `admission:lease:*`, `admission:rpm:*`, ...).
    // Matching on the token — not a fixed prefix — is what actually collects
    // them; a prefix glob would miss every one.
    const keys = await redis.keys(`admission:*${run}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  /** A budget request whose only limit is the lifetime budget. */
  function lifetimeRequest(suffix: string) {
    const id = `${run}:${suffix}`;
    return {
      reservationId: `lease-${id}`,
      apiKeyId: `key-${id}`,
      now: Date.now(),
      estimatedTokens: 100,
      rpmLimit: null,
      dailyLimit: null,
      monthlyLimit: null,
      lifetimeBudget: 1_000_000,
      lifetimeConsumed: 0,
      concurrencyLimit: null,
      tenantId: `tenant-${id}`,
      tenantConcurrencyLimit: null,
    };
  }

  test("the lifetime counter is created with an expiry", async () => {
    const request = lifetimeRequest("seed");
    await store.reserve(request);

    // The reserve script's seed write is what this pins: it must carry a TTL.
    const ttl = await redis.ttl(`admission:lifetime:${request.apiKeyId}`);
    expect(ttl).toBeGreaterThan(0);

    await store.release(request.apiKeyId, request.estimatedTokens, request.reservationId);
  });

  test("the concurrency slot outlives the longest possible lease", async () => {
    // The slot must not expire underneath a still-live lease: a later reserve
    // would then INCR from zero and the key could hold more simultaneous
    // requests than `max_concurrent`. Derived from the lease TTL rather than
    // hard-coded, so raising the lease cannot silently reopen the hole.
    const request = { ...lifetimeRequest("conc"), concurrencyLimit: 2 };
    await store.reserve(request);

    const slotTtl = await redis.ttl(`admission:concurrent:${request.apiKeyId}`);
    const leaseTtl = await redis.ttl(`admission:lease:${request.reservationId}`);
    expect(slotTtl).toBeGreaterThan(0);
    expect(slotTtl).toBeGreaterThanOrEqual(leaseTtl);

    await store.release(request.apiKeyId, request.estimatedTokens, request.reservationId);
  });

  test("seeding a bucket never overwrites a live counter", async () => {
    // A counter that already exists is the running total; seeding is only for
    // a bucket that has not been written yet.
    const request = { ...lifetimeRequest("seedbucket"), dailyLimit: 100_000 };
    await store.reserve(request);
    const key = `admission:daily:${request.apiKeyId}:${new Date().toISOString().slice(0, 10)}`;
    const before = await redis.get(key);

    await store.seedBuckets?.({ apiKeyId: request.apiKeyId, now: Date.now(), daily: 1 });
    expect(await redis.get(key)).toBe(before);

    await store.release(request.apiKeyId, request.estimatedTokens, request.reservationId);
  });

  test("a rejected reserve still leaves the seeded counter bounded", async () => {
    // The seed runs before the budget check, so the early `return -4` used to
    // leave a freshly created counter with no expiry and no later write to arm
    // one. This is the path that made the leak permanent rather than transient.
    const request = {
      ...lifetimeRequest("reject"),
      estimatedTokens: 100,
      lifetimeBudget: 50,
      lifetimeConsumed: 0,
    };
    await expect(store.reserve(request)).rejects.toBeDefined();

    const ttl = await redis.ttl(`admission:lifetime:${request.apiKeyId}`);
    expect(ttl).toBeGreaterThan(0);
  });

  test("seeds the lifetime counter from the fresh reader when it is missing", async () => {
    // Snapshot understates the persisted total; the seed must use the fresh
    // number, otherwise a request could exceed its budget by whatever amount
    // committed inside the ≤3s auth-cache window, and stay wrong for 35 days.
    let readerCalls = 0;
    const request = {
      ...lifetimeRequest("fresh-seed"),
      lifetimeConsumed: 0,
      freshLifetimeConsumed: async () => {
        readerCalls += 1;
        return 750;
      },
    };
    await store.reserve(request);
    expect(readerCalls).toBe(1);
    // Reserve script SETs the seed, then INCRBYs `estimatedTokens` (100).
    expect(await redis.get(`admission:lifetime:${request.apiKeyId}`)).toBe(String(750 + 100));
    await store.release(request.apiKeyId, request.estimatedTokens, request.reservationId);
  });

  test("does not call the fresh reader when the lifetime counter already exists", async () => {
    // A second reserve for the same key: the counter is already there, so the
    // callback must not fire — Postgres is off the hot path.
    let readerCalls = 0;
    const first = { ...lifetimeRequest("hot-path"), freshLifetimeConsumed: async () => { readerCalls += 1; return 500; } };
    await store.reserve(first);
    await store.release(first.apiKeyId, first.estimatedTokens, first.reservationId);
    const second = {
      ...first,
      reservationId: `${first.reservationId}-2`,
      freshLifetimeConsumed: async () => { readerCalls += 1; return 500; },
    };
    await store.reserve(second);
    expect(readerCalls).toBe(1);
    await store.release(second.apiKeyId, second.estimatedTokens, second.reservationId);
  });

  test("reconcile keeps the counter TTL instead of stripping it", async () => {
    const request = lifetimeRequest("reconcile");
    await store.reserve(request);

    const key = `admission:lifetime:${request.apiKeyId}`;
    const before = await redis.ttl(key);
    expect(before).toBeGreaterThan(0);

    // The happy path: the reservation settles with actual usage.
    await store.reconcile(request.apiKeyId, request.estimatedTokens, 42, request.reservationId);

    const after = await redis.ttl(key);
    // -1 is the failure this guards: a plain SET replaced the key and dropped
    // its expiry, so the counter would never be reclaimed.
    expect(after).toBeGreaterThan(0);
    expect(await redis.get(key)).toBe("42");
  });

  test("reconcile leaves an existing TTL rather than re-arming it", async () => {
    // A reconcile that re-armed the TTL every time would extend a bucket's
    // lifetime on each request and, for the daily/monthly counters, keep a
    // spent bucket alive indefinitely. The write must preserve, not refresh.
    const request = lifetimeRequest("preserve");
    await store.reserve(request);

    const key = `admission:lifetime:${request.apiKeyId}`;
    await redis.expire(key, 600);
    await store.reconcile(request.apiKeyId, request.estimatedTokens, 10, request.reservationId);

    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
  });
});
