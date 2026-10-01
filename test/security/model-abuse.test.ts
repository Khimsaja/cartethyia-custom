import { describe, expect, test } from "bun:test";
import {
  InMemoryModelAbuseStore,
  ModelStrikeService,
  modelAbuseBannedError,
} from "../../src/security/model-abuse";

/** A service with a controllable clock and a small threshold. */
function makeService(threshold = 3, windowMs = 5 * 60_000) {
  let now = 1_000;
  const store = new InMemoryModelAbuseStore(() => now);
  const service = new ModelStrikeService(store, { threshold, windowMs });
  return { service, store, advance: (ms: number) => (now += ms) };
}

const ip = "203.0.113.9";
const key = "key-1";

describe("ModelStrikeService — graduated strikes", () => {
  test("bans on the third consecutive invalid model, per IP and per key", async () => {
    const { service } = makeService(3);
    const first = await service.noteInvalid({ ip, apiKeyId: key });
    expect(first.banned).toBe(false);
    expect(first.ipStrikes).toBe(1);
    const second = await service.noteInvalid({ ip, apiKeyId: key });
    expect(second.ipStrikes).toBe(2);
    const third = await service.noteInvalid({ ip, apiKeyId: key });
    expect(third.banned).toBe(true);
    expect(third.bannedNow).toBe(true);
    // Both identities are banned, so a fresh key from the same IP and a fresh
    // IP reusing the key are both refused.
    expect(await service.check({ ip, apiKeyId: "other-key" })).toBe("ip");
    expect(await service.check({ ip: "198.51.100.4", apiKeyId: key })).toBe("api_key");
  });

  test("a valid model request resets the consecutive counter", async () => {
    const { service } = makeService(3);
    await service.noteInvalid({ ip, apiKeyId: key });
    await service.noteInvalid({ ip, apiKeyId: key });
    // The client corrects itself: the count clears, so a later typo starts over.
    await service.noteValid({ ip, apiKeyId: key });
    const after = await service.noteInvalid({ ip, apiKeyId: key });
    expect(after.ipStrikes).toBe(1);
    expect(after.banned).toBe(false);
  });

  test("one invalid hit then a valid one never accumulates toward a ban", async () => {
    const { service } = makeService(3);
    for (let i = 0; i < 10; i += 1) {
      await service.noteInvalid({ ip, apiKeyId: key });
      await service.noteValid({ ip, apiKeyId: key });
    }
    expect(await service.check({ ip, apiKeyId: key })).toBeNull();
  });

  test("a strike expires after the quiet window", async () => {
    const { service, advance } = makeService(3, 60_000);
    await service.noteInvalid({ ip, apiKeyId: key });
    await service.noteInvalid({ ip, apiKeyId: key });
    advance(60_001);
    // The window lapsed, so the next invalid is a fresh count, not the third.
    const after = await service.noteInvalid({ ip, apiKeyId: key });
    expect(after.ipStrikes).toBe(1);
    expect(after.banned).toBe(false);
  });

  test("a banned identity short-circuits without extending its own counters", async () => {
    const { service } = makeService(2);
    await service.noteInvalid({ ip, apiKeyId: key });
    await service.noteInvalid({ ip, apiKeyId: key }); // bans
    const again = await service.noteInvalid({ ip, apiKeyId: key });
    expect(again.banned).toBe(true);
    expect(again.bannedNow).toBe(false);
  });

  test("the ban is permanent until an operator lifts it", async () => {
    const { service, advance } = makeService(1, 60_000);
    await service.noteInvalid({ ip, apiKeyId: key });
    expect(await service.check({ ip, apiKeyId: key })).toBe("ip");
    // No TTL: a long quiet period does not lift it.
    advance(10 * 365 * 24 * 3600_000);
    expect(await service.check({ ip, apiKeyId: key })).toBe("ip");
    // The operator's escape hatch. Both identities were banned, so both must
    // be lifted before the caller is clean again.
    expect(await service.unban("ip", ip)).toBe(true);
    expect(await service.check({ ip, apiKeyId: key })).toBe("api_key");
    expect(await service.unban("api_key", key)).toBe(true);
    expect(await service.check({ ip, apiKeyId: key })).toBeNull();
    expect(await service.unban("ip", ip)).toBe(false);
  });

  test("bans are listed for the console", async () => {
    const { service } = makeService(1);
    await service.noteInvalid({ ip, apiKeyId: key });
    const bans = await service.listBans();
    expect(bans).toContainEqual({ scope: "ip", identity: ip });
    expect(bans).toContainEqual({ scope: "api_key", identity: key });
  });

  test("independent identities do not share a counter", async () => {
    const { service } = makeService(3);
    await service.noteInvalid({ ip: "10.0.0.1", apiKeyId: "k1" });
    await service.noteInvalid({ ip: "10.0.0.2", apiKeyId: "k2" });
    await service.noteInvalid({ ip: "10.0.0.2", apiKeyId: "k2" });
    // Two for 10.0.0.2/k2; 10.0.0.1/k1 still has one and is not near the ban.
    expect(await service.check({ ip: "10.0.0.1", apiKeyId: "k1" })).toBeNull();
  });

  test("threshold 1 bans on the first invalid model", async () => {
    const { service } = makeService(1);
    const outcome = await service.noteInvalid({ ip, apiKeyId: key });
    expect(outcome.banned).toBe(true);
  });
});

describe("modelAbuseBannedError", () => {
  test("is a typed 403 naming the scope", () => {
    expect(modelAbuseBannedError("ip")).toMatchObject({ code: "model_abuse_banned", status: 403 });
    expect(modelAbuseBannedError("api_key").message).toContain("API key");
  });
});
