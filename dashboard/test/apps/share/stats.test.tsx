import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ShareQuotaPanel,
  formatCount,
  formatRate,
  formatTtft,
} from "../../../src/apps/share/stats";
import type { ShareLinkPolicyData } from "../../../src/hooks/share-data";

/**
 * The share page's stats formatters and quota bar.
 *
 * Requests are read in full (a comma-grouped integer), never compacted: "1.2K"
 * hides the exact figure against a limit. Tokens open on the exact count too —
 * a recipient checking a quota against a limit wants the number — and the unit
 * switch beside the rows is how a viewer opts into the compact reading.
 */
describe("share stats formatters", () => {
  test("counts render in full with thousands separators, never compacted", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(128)).toBe("128");
    expect(formatCount(1_234)).toBe("1,234");
    expect(formatCount(513_260_000)).toBe("513,260,000");
    // Not "1.2K": the exact request count is what a reader checks a limit against.
    expect(formatCount(1_234)).not.toContain("K");
  });

  test("rate is one decimal of tokens per second, em dash when unmeasured", () => {
    expect(formatRate(42.53)).toBe("42.5 t/s");
    expect(formatRate(0)).toBe("—");
    expect(formatRate(null)).toBe("—");
  });

  test("ttft is milliseconds below a second, seconds above, em dash when unmeasured", () => {
    expect(formatTtft(820)).toBe("820ms");
    expect(formatTtft(1500)).toBe("1.5s");
    expect(formatTtft(0)).toBe("—");
    expect(formatTtft(null)).toBe("—");
  });
});

describe("share quota bar", () => {
  const policy = (overrides: Partial<ShareLinkPolicyData>): ShareLinkPolicyData => ({
    name: "Share",
    keyPrefix: "ctk",
    dailyLimit: null,
    monthlyLimit: null,
    oneTimeLimit: null,
    requestsPerMinute: null,
    maxConcurrentRequests: null,
    modelAllowlist: [],
    modelDenylist: null,
    modelPrefix: null,
    notes: { title: null, subtitle: null, body: null },
    sharePopup: { enabled: false, hasImage: false, title: null, body: null },
    expiresAt: null,
    ...overrides,
  });

  const stats = (overrides: Partial<{
    totalTokens: number;
    todayTokens: number;
    monthTokens: number;
  }>): {
    totals: {
      requests: number;
      errors: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      lastHourRequests: number;
      todayTokens: number;
      monthTokens: number;
    };
    recipients: { total: number; active: number };
    hourly: readonly { hour: string; requests: number }[];
    models: readonly {
      modelId: string;
      requests: number;
      tokens: number;
      avgTokensPerSec: number | null;
      avgTtfbMs: number | null;
    }[];
    clientIps: readonly {
      ip: string;
      requests: number;
      tokens: number;
      lastSeenAt: string | null;
      clientType: string | null;
    }[];
  } => ({
    totals: {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: overrides.totalTokens ?? 0,
      lastHourRequests: 0,
      todayTokens: overrides.todayTokens ?? 0,
      monthTokens: overrides.monthTokens ?? 0,
    },
    recipients: { total: 0, active: 0 },
    hourly: [],
    models: [],
    clientIps: [],
  });

  test("token figures open on the exact count, with the unit switch beside them", () => {
    const html = renderToStaticMarkup(
      createElement(ShareQuotaPanel, {
        policy: policy({ dailyLimit: 100_000 }),
        stats: stats({ totalTokens: 84_200, todayTokens: 12_000 }),
      }),
    );
    // The exact count, not a rounded "84K": the number is what reconciles
    // against a limit. The switch is the one click into the compact units.
    expect(html).toContain("84,200");
    expect(html).toContain("12,000");
    expect(html).not.toContain("84.2K");
    expect(html).toContain("share-unit-switch");
    expect(html).toContain("Token unit: currently raw");
  });

  test("a row with no limit renders an unlimited (green) bar with no red fill", () => {
    const html = renderToStaticMarkup(
      createElement(ShareQuotaPanel, { policy: policy({}), stats: stats({ totalTokens: 513_260_000 }) }),
    );
    // Unlimited rows carry the is-unlimited class and no red "used" fill.
    expect(html).toContain("is-unlimited");
    expect(html).not.toContain("share-quota-used");
  });

  test("a limited row shows a red fill proportional to usage over the green allowance", () => {
    const html = renderToStaticMarkup(
      createElement(ShareQuotaPanel, {
        policy: policy({ dailyLimit: 100_000 }),
        stats: stats({ todayTokens: 25_000 }),
      }),
    );
    // 25% used: the red fill is a quarter of the bar over the green track. The
    // Lifetime and Monthly rows have no limit and stay unlimited, so both the
    // red "used" fill and the unlimited marker appear on the same panel.
    expect(html).toContain("share-quota-used");
    expect(html).toContain("width:25%");
    expect(html).toContain("is-unlimited");
  });

  test("a fully spent limited row fills the whole bar red", () => {
    const html = renderToStaticMarkup(
      createElement(ShareQuotaPanel, {
        policy: policy({ dailyLimit: 100_000 }),
        stats: stats({ todayTokens: 100_000 }),
      }),
    );
    expect(html).toContain("width:100%");
  });
});
