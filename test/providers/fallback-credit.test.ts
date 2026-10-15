/**
 * Fallback-credit token cache tests.
 */
import { describe, expect, test } from "bun:test";
import {
  FallbackCreditCache,
  hashBody,
} from "../../src/providers/integrations/claude/fallback-credit";

describe("hashBody", () => {
  test("produces stable hashes for identical bodies", () => {
    expect(hashBody('{"model":"claude-sonnet-4-6"}')).toBe(
      hashBody('{"model":"claude-sonnet-4-6"}'),
    );
  });

  test("produces different hashes for different bodies", () => {
    expect(hashBody('{"model":"a"}')).not.toBe(hashBody('{"model":"b"}'));
  });

  test("handles empty string", () => {
    // FNV-1a of empty string is the offset basis 0x811c9dc5
    expect(hashBody("")).toBe("ztntfp");
  });
});

describe("FallbackCreditCache", () => {
  test("stores and retrieves a token", () => {
    const cache = new FallbackCreditCache();
    cache.set("key1", "token-abc");
    expect(cache.get("key1")).toBe("token-abc");
  });

  test("returns undefined for missing key", () => {
    const cache = new FallbackCreditCache();
    expect(cache.get("missing")).toBeUndefined();
  });

  test("returns undefined for expired token", async () => {
    const cache = new FallbackCreditCache({ ttlMs: 50 });
    cache.set("key1", "token-abc");
    // Token is present immediately
    expect(cache.get("key1")).toBe("token-abc");
    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cache.get("key1")).toBeUndefined();
  });

  test("evicts oldest entry when at capacity", () => {
    const cache = new FallbackCreditCache({ maxSize: 3 });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    expect(cache.size).toBe(3);
    cache.set("d", "4"); // should evict "a"
    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("d")).toBe("4");
  });

  test("refreshes LRU position on get", () => {
    const cache = new FallbackCreditCache({ maxSize: 3 });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    // Access "a" to refresh its position
    cache.get("a");
    // Add "d" — should evict "b" (now the oldest)
    cache.set("d", "4");
    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBeUndefined();
  });

  test("clear removes all entries", () => {
    const cache = new FallbackCreditCache();
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  test("overwriting an existing key does not grow size", () => {
    const cache = new FallbackCreditCache();
    cache.set("a", "1");
    cache.set("a", "2");
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBe("2");
  });
});
