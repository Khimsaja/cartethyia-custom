import { describe, expect, test } from "bun:test";
import { fetchAntigravityQuota } from "../../../../src/providers/integrations/antigravity/antigravity-quota";

/**
 * Antigravity serves quota from two endpoints, and each carries a window the
 * other does not:
 *
 * - `v1internal:fetchAvailableModels` — per-model windows, keyed by deployment
 *   id (`gemini-3.8-flash-low`, `…-medium`, `…-low` are three entries for one
 *   catalog model).
 * - `v1internal:retrieveUserQuotaSummary` — the weekly summary groups. This is
 *   the *only* quota a free-tier account has, because the upstream omits
 *   per-model quota for it.
 *
 * The collector used to call the summary endpoint first but parse only a
 * `models` key, so a free-tier account reported zero windows and a paid one
 * showed three rows per model. These tests pin both windows and the collapse.
 */

const CREDENTIAL = JSON.stringify({ accessToken: "access-token", projectId: "project-1" });

interface Call {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** Routes each endpoint to a canned body; unlisted paths fail the request. */
function stubFetcher(bodies: {
  readonly models?: unknown;
  readonly summary?: unknown;
}): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    if (url.includes("retrieveUserQuotaSummary")) {
      if (bodies.summary === undefined) return new Response("nope", { status: 500 });
      return Response.json(bodies.summary);
    }
    if (url.includes("fetchAvailableModels")) {
      if (bodies.models === undefined) return new Response("nope", { status: 500 });
      return Response.json(bodies.models);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function modelEntry(remainingFraction: number, resetTime: string): Record<string, unknown> {
  return { quotaInfo: { remainingFraction, resetTime } };
}

describe("antigravity quota — summary windows", () => {
  test("reads both the session and weekly groups the summary endpoint returns", async () => {
    const { fetcher } = stubFetcher({
      summary: {
        groups: [
          {
            displayName: "Gemini",
            buckets: [
              {
                bucketId: "gemini-weekly",
                displayName: "Gemini weekly",
                remainingFraction: 0.25,
                resetTime: "2026-03-02T00:00:00Z",
              },
              {
                bucketId: "gemini-5h",
                displayName: "5 hour window",
                remainingFraction: 0.75,
                resetTime: "2026-03-01T05:00:00Z",
              },
            ],
          },
          {
            displayName: "Claude & GPT",
            buckets: [
              {
                bucketId: "claude-weekly",
                displayName: "Claude weekly",
                remainingFraction: 0.5,
                resetTime: "2026-03-02T00:00:00Z",
              },
            ],
          },
        ],
      },
    });

    const result = await fetchAntigravityQuota(CREDENTIAL, fetcher);
    const byLabel = new Map(result.windows.map((window) => [window.label, window]));
    // Both windows are read, per family, and labelled with the same shape.
    expect([...byLabel.keys()].sort()).toEqual([
      "Claude & GPT (Weekly)",
      "Gemini (5 Hour)",
      "Gemini (Weekly)",
    ]);
    // remainingFraction 0.25 → 25% remaining, 75% used.
    expect(byLabel.get("Gemini (Weekly)")?.remainingPercent).toBeCloseTo(25, 5);
    expect(byLabel.get("Gemini (Weekly)")?.usedPercent).toBeCloseTo(75, 5);
    expect(byLabel.get("Gemini (5 Hour)")?.remainingPercent).toBeCloseTo(75, 5);
    expect(byLabel.get("Claude & GPT (Weekly)")?.remainingPercent).toBeCloseTo(50, 5);
    expect(byLabel.get("Gemini (Weekly)")?.resetsAt).toBe("2026-03-02T00:00:00.000Z");
  });

  test("a free-tier account reports its summary windows even with no per-model quota", async () => {
    // The upstream omits per-model quota for free-tier accounts, so a parser
    // that read only `models` reported no windows at all for them.
    const { fetcher } = stubFetcher({
      summary: {
        groups: [
          {
            displayName: "Gemini",
            buckets: [
              {
                bucketId: "gemini-weekly",
                displayName: "Weekly",
                remainingFraction: 1,
                resetTime: "2026-03-02T00:00:00Z",
              },
            ],
          },
        ],
      },
    });

    const result = await fetchAntigravityQuota(CREDENTIAL, fetcher);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.label).toBe("Gemini (Weekly)");
  });

  test("keeps both a session and a weekly bucket in the same group", async () => {
    const { fetcher } = stubFetcher({
      summary: {
        groups: [
          {
            displayName: "Gemini",
            buckets: [
              { bucketId: "gemini-5h", displayName: "5 hour window", remainingFraction: 0.1 },
              { bucketId: "gemini-weekly", displayName: "Weekly", remainingFraction: 0.9 },
            ],
          },
        ],
      },
    });

    const result = await fetchAntigravityQuota(CREDENTIAL, fetcher);
    expect(result.windows).toHaveLength(2);
    const weekly = result.windows.find((window) => window.label === "Gemini (Weekly)");
    const session = result.windows.find((window) => window.label === "Gemini (5 Hour)");
    expect(weekly?.remainingPercent).toBeCloseTo(90, 5);
    expect(session?.remainingPercent).toBeCloseTo(10, 5);
  });

  test("keeps a disabled session bucket at 0% and skips a disabled weekly bucket", async () => {
    // A disabled session bucket means the 5-hour lane is blocked (usually
    // because the weekly was hit); the operator still needs to see that row.
    // A disabled weekly bucket is genuinely gone.
    const { fetcher } = stubFetcher({
      summary: {
        groups: [
          {
            displayName: "Gemini",
            buckets: [
              { bucketId: "gemini-5h", displayName: "5 hour window", remainingFraction: 0.4, disabled: true },
              { bucketId: "weekly", displayName: "Weekly", remainingFraction: 0.4, disabled: true },
            ],
          },
        ],
      },
    });

    const result = await fetchAntigravityQuota(CREDENTIAL, fetcher);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.label).toBe("Gemini (5 Hour)");
    expect(result.windows[0]?.remainingPercent).toBeCloseTo(0, 5);
  });
});

describe("antigravity quota — per-model windows", () => {
  test("collapses effort tiers of one model to a single row", async () => {
    // The upstream lists one entry per effort tier; all three collapse to
    // `gemini-3.8-flash`, so one catalog model must not become three rows.
    const { fetcher } = stubFetcher({
      models: {
        models: {
          "gemini-3.8-flash-high": modelEntry(0.9, "2026-03-01T00:00:00Z"),
          "gemini-3.8-flash-medium": modelEntry(0.6, "2026-03-01T00:00:00Z"),
          "gemini-3.8-flash-low": modelEntry(0.3, "2026-03-01T00:00:00Z"),
        },
      },
    });

    const result = await fetchAntigravityQuota(CREDENTIAL, fetcher);
    expect(result.windows).toHaveLength(1);
    // The worst tier is the one the operator runs out of, so it is the row.
    expect(result.windows[0]?.remainingPercent).toBeCloseTo(30, 5);
    expect(result.windows[0]?.label).toBe("Gemini (Flash / Pro)");
  });

  test("groups Gemini and Claude families separately", async () => {
    const { fetcher } = stubFetcher({
      models: {
        models: {
          "gemini-3.7-flash-high": modelEntry(0.8, "2026-03-01T00:00:00Z"),
          "claude-sonnet-4-6": modelEntry(0.2, "2026-03-01T00:00:00Z"),
          "gpt-oss-120b-medium": modelEntry(0.5, "2026-03-01T00:00:00Z"),
        },
      },
    });

    const result = await fetchAntigravityQuota(CREDENTIAL, fetcher);
    const labels = result.windows.map((window) => window.label).sort();
    expect(labels).toEqual(["Claude (Sonnet / Opus)", "Gemini (Flash / Pro)"]);
    const claude = result.windows.find((window) => window.label.startsWith("Claude"));
    // GPT-OSS draws on the Claude family, and it is the lower of the two.
    expect(claude?.remainingPercent).toBeCloseTo(20, 5);
  });

  test("skips internal deployments and ids the catalog does not serve", async () => {
    // `gemini-2.5-pro` is a real deployment but no longer a catalog model, so
    // a quota row for it would name a model the operator cannot select.
    const { fetcher } = stubFetcher({
      models: {
        models: {
          "gemini-3.8-flash-high": modelEntry(0.5, "2026-03-01T00:00:00Z"),
          "internal-gemini-9": { ...modelEntry(0.1, "2026-03-01T00:00:00Z"), isInternal: true },
          "gemini-2.5-pro": modelEntry(0.1, "2026-03-01T00:00:00Z"),
        },
      },
    });

    const result = await fetchAntigravityQuota(CREDENTIAL, fetcher);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.remainingPercent).toBeCloseTo(50, 5);
  });

  test("merges both endpoints' windows in one result", async () => {
    const { fetcher, calls } = stubFetcher({
      models: {
        models: { "gemini-3.8-flash-high": modelEntry(0.8, "2026-03-01T00:00:00Z") },
      },
      summary: {
        groups: [
          {
            displayName: "Gemini",
            buckets: [
              { bucketId: "weekly", displayName: "Weekly", remainingFraction: 0.2 },
            ],
          },
        ],
      },
    });

    const result = await fetchAntigravityQuota(CREDENTIAL, fetcher);
    expect(result.windows).toHaveLength(2);
    expect(calls.some((call) => call.url.includes("retrieveUserQuotaSummary"))).toBe(true);
    expect(calls.some((call) => call.url.includes("fetchAvailableModels"))).toBe(true);
  });

  test("one endpoint failing does not discard the other's windows", async () => {
    // A summary outage must not blank the per-model rows, and vice versa.
    const { fetcher } = stubFetcher({
      models: {
        models: { "gemini-3.8-flash-high": modelEntry(0.8, "2026-03-01T00:00:00Z") },
      },
    });

    const result = await fetchAntigravityQuota(CREDENTIAL, fetcher);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.label).toBe("Gemini (Flash / Pro)");
  });
});
