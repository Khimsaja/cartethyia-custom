import { describe, expect, test } from "bun:test";
import {
  InMemoryModelAbuseStore,
  ModelStrikeService,
  modelAbuseBannedError,
} from "../../src/security/model-abuse";

/** A service with a controllable clock and a small threshold. */
function makeService(threshold = 3, windowMs = 5 * 60_000, banTtlMs = 60 * 60_000) {
  let now = 1_000;
  const store = new InMemoryModelAbuseStore(() => now);
  const service = new ModelStrikeService(store, { threshold, windowMs, banTtlMs });
  return { service, store, advance: (ms: number) => (now += ms) };
}

const ip = "203.0.113.9";

describe("ModelStrikeService — graduated strikes", () => {
  test("bans the client address on the threshold-th consecutive invalid model", async () => {
    const { service } = makeService(3);
    const first = await service.noteInvalid({ ip });
    expect(first.banned).toBe(false);
    expect(first.strikes).toBe(1);
    const second = await service.noteInvalid({ ip });
    expect(second.strikes).toBe(2);
    const third = await service.noteInvalid({ ip });
    expect(third.banned).toBe(true);
    expect(third.bannedNow).toBe(true);
    expect(await service.check({ ip })).toBe(true);
  });

  test("the ban follows the address, not the API key that tripped it", async () => {
    const { service } = makeService(1);
    await service.noteInvalid({ ip });
    // The same address is refused regardless of which key it presents...
    expect(await service.check({ ip })).toBe(true);
    // ...and a different address is untouched, so one shared key does not
    // spread one caller's ban to every other caller behind it.
    expect(await service.check({ ip: "198.51.100.4" })).toBe(false);
  });

  test("a valid model request resets the consecutive counter", async () => {
    const { service } = makeService(3);
    await service.noteInvalid({ ip });
    await service.noteInvalid({ ip });
    // The client corrects itself: the count clears, so a later typo starts over.
    await service.noteValid({ ip });
    const after = await service.noteInvalid({ ip });
    expect(after.strikes).toBe(1);
    expect(after.banned).toBe(false);
  });

  test("one invalid hit then a valid one never accumulates toward a ban", async () => {
    const { service } = makeService(3);
    for (let i = 0; i < 10; i += 1) {
      await service.noteInvalid({ ip });
      await service.noteValid({ ip });
    }
    expect(await service.check({ ip })).toBe(false);
  });

  test("a strike expires after the quiet window", async () => {
    const { service, advance } = makeService(3, 60_000);
    await service.noteInvalid({ ip });
    await service.noteInvalid({ ip });
    advance(60_001);
    // The window lapsed, so the next invalid is a fresh count, not the third.
    const after = await service.noteInvalid({ ip });
    expect(after.strikes).toBe(1);
    expect(after.banned).toBe(false);
  });

  test("a banned address short-circuits without extending its own counter", async () => {
    const { service } = makeService(2);
    await service.noteInvalid({ ip });
    await service.noteInvalid({ ip }); // bans
    const again = await service.noteInvalid({ ip });
    expect(again.banned).toBe(true);
    expect(again.bannedNow).toBe(false);
  });

  test("the ban lapses on its own after the TTL", async () => {
    const { service, advance } = makeService(1, 60_000, 3_600_000);
    await service.noteInvalid({ ip });
    expect(await service.check({ ip })).toBe(true);
    // Still inside the TTL: a quiet period shorter than it changes nothing.
    advance(3_599_999);
    expect(await service.check({ ip })).toBe(true);
    // Past the TTL the address is clean, and the next strike starts over.
    advance(2);
    expect(await service.check({ ip })).toBe(false);
    const after = await service.noteInvalid({ ip });
    expect(after.strikes).toBe(1);
  });

  test("an operator can lift a ban before it lapses", async () => {
    const { service } = makeService(1);
    await service.noteInvalid({ ip });
    expect(await service.unban(ip)).toBe(true);
    expect(await service.check({ ip })).toBe(false);
    expect(await service.unban(ip)).toBe(false);
  });

  test("bans are listed for the console with their expiry", async () => {
    const { service } = makeService(1);
    await service.noteInvalid({ ip });
    const bans = await service.listBans();
    expect(bans).toHaveLength(1);
    expect(bans[0]?.ip).toBe(ip);
    expect(bans[0]?.expiresAt).toBeGreaterThan(0);
  });

  test("a lapsed ban is not listed", async () => {
    const { service, advance } = makeService(1, 60_000, 60_000);
    await service.noteInvalid({ ip });
    advance(60_001);
    expect(await service.listBans()).toEqual([]);
  });

  test("independent addresses do not share a counter", async () => {
    const { service } = makeService(3);
    await service.noteInvalid({ ip: "10.0.0.1" });
    await service.noteInvalid({ ip: "10.0.0.2" });
    await service.noteInvalid({ ip: "10.0.0.2" });
    // Two for 10.0.0.2; 10.0.0.1 still has one and is not near the ban.
    expect(await service.check({ ip: "10.0.0.1" })).toBe(false);
  });

  test("threshold 1 bans on the first invalid model", async () => {
    const { service } = makeService(1);
    const outcome = await service.noteInvalid({ ip });
    expect(outcome.banned).toBe(true);
  });

  test("the default threshold is ten strikes", async () => {
    const store = new InMemoryModelAbuseStore(() => 1_000);
    const service = new ModelStrikeService(store);
    expect(service.limit).toBe(10);
    for (let i = 1; i <= 9; i += 1) {
      const outcome = await service.noteInvalid({ ip });
      expect(outcome.banned).toBe(false);
      expect(outcome.strikes).toBe(i);
    }
    expect((await service.noteInvalid({ ip })).banned).toBe(true);
  });
});

describe("modelAbuseBannedError", () => {
  test("is a typed 403 naming the banned address", () => {
    expect(modelAbuseBannedError()).toMatchObject({ code: "model_abuse_banned", status: 403 });
    expect(modelAbuseBannedError().message).toContain("client address");
  });
});
