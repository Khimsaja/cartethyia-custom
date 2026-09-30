import { describe, expect, test } from "bun:test";
import { fetchClaudeQuota } from "../../../../src/providers/integrations/claude/claude-quota";
import type { FetchLike } from "../../../../src/providers/quota/quota-contracts";

const QUOTA_BODY = JSON.stringify({
  five_hour: { utilization: 10, resets_at: "2030-01-01T00:00:00Z" },
  seven_day: { utilization: 20, resets_at: "2030-01-08T00:00:00Z" },
});

function mockFetch(status: number, calls: { count: number }): FetchLike {
  return (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    calls.count++;
    return new Response(status === 200 ? QUOTA_BODY : JSON.stringify({ error: "slow down" }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike;
}

describe("fetchClaudeQuota caching", () => {
  test("second call within TTL serves the cache without fetching", async () => {
    const calls = { count: 0 };
    const credential = `cache-cred-${crypto.randomUUID()}`;
    const first = await fetchClaudeQuota(credential, mockFetch(200, calls));
    const second = await fetchClaudeQuota(credential, mockFetch(200, calls));
    expect(calls.count).toBe(1);
    expect(second).toBe(first);
  });

  test("429 arms a cooldown that fails fast without fetching", async () => {
    const calls = { count: 0 };
    const credential = `cooldown-cred-${crypto.randomUUID()}`;
    await expect(fetchClaudeQuota(credential, mockFetch(429, calls))).rejects.toThrow();
    expect(calls.count).toBe(1);
    await expect(fetchClaudeQuota(credential, mockFetch(429, calls))).rejects.toThrow(/cooled down/);
    expect(calls.count).toBe(1);
  });

  test("a 429 cooldown and a cached quota stay scoped to their own credential", async () => {
    const calls = { count: 0 };
    const cooled = `cooled-cred-${crypto.randomUUID()}`;
    const other = `other-cred-${crypto.randomUUID()}`;
    await expect(fetchClaudeQuota(cooled, mockFetch(429, calls))).rejects.toThrow();
    // The cooled credential fails fast; a different credential still fetches.
    await expect(fetchClaudeQuota(cooled, mockFetch(429, calls))).rejects.toThrow(/cooled down/);
    expect(calls.count).toBe(1);
    const result = await fetchClaudeQuota(other, mockFetch(200, calls));
    expect(calls.count).toBe(2);
    expect(result).toBeDefined();
  });
});

describe("fetchClaudeQuota window de-duplication", () => {
  test("a payload reporting the same scope twice renders each window once", async () => {
    // Real Claude usage payloads carry BOTH the fixed keys (`five_hour`,
    // `seven_day`) and a dynamic `limits[]` array describing the same session
    // and weekly scopes in a different vocabulary (`session`, `weekly_all`).
    // Nothing marked them as the same window, so the quota card rendered
    // "5 Hour / 7 Day / 5 Hour / 7 Day".
    const body = JSON.stringify({
      five_hour: { utilization: 94, resets_at: "2030-01-01T00:00:00Z" },
      seven_day: { utilization: 71, resets_at: "2030-01-08T00:00:00Z" },
      limits: [
        { kind: "session", percent: 94, resets_at: "2030-01-01T00:00:00Z" },
        { kind: "weekly_all", percent: 71, resets_at: "2030-01-08T00:00:00Z" },
      ],
    });
    const fetcher = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as FetchLike;

    const result = await fetchClaudeQuota(`dedup-${crypto.randomUUID()}`, fetcher);
    const labels = result.windows.map((window) => window.label);
    expect(labels.filter((label) => label === "5 Hour")).toHaveLength(1);
    expect(labels.filter((label) => label === "7 Day")).toHaveLength(1);
    expect(new Set(labels).size).toBe(labels.length);
    // The declarative window wins, so its percentage survives.
    expect(result.windows.find((w) => w.label === "5 Hour")?.usedPercent).toBe(94);
  });

  test("a payload reporting only limits[] still shows its windows", async () => {
    // No earlier label to match, so nothing may be dropped.
    const body = JSON.stringify({
      limits: [{ kind: "session", percent: 42, resets_at: "2030-01-01T00:00:00Z" }],
    });
    const fetcher = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as FetchLike;

    const result = await fetchClaudeQuota(`limits-only-${crypto.randomUUID()}`, fetcher);
    expect(result.windows.map((window) => window.label)).toEqual(["5 Hour"]);
  });
});
