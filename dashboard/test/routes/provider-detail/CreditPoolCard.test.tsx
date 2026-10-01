import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QuotaEntry, QuotaWindow } from "../../../src/hooks/quota";

const windows: QuotaWindow[] = [
  { label: "Credit", remainingPercent: 64, usedPercent: 36, resetsAt: null, limit: 6370, used: 2276.64 },
];

const account: QuotaEntry = {
  id: "quota-account",
  provider: "workbuddy",
  name: "quota@example.test",
  credentialHint: "oauth",
  active: true,
  quota: {
    source: "billing",
    status: "ready",
    plan: null,
    windows,
    fetchedAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    error: null,
  },
  health: { status: "active" },
  providerName: "WorkBuddy",
  providerIcon: "workbuddy",
};

mock.module("../../../src/hooks/quota", () => ({
  useQuotaOverview: () => ({ data: { accounts: [account] }, error: null, loading: false }),
}));

const { CreditPoolCard } = await import("../../../src/routes/provider-detail/CreditPool");

/**
 * The headline is the sentence the operator reads first. It must say what the
 * number *is* — a bare `4,093.36 / 6,370` under a "Credits remaining" label was
 * ambiguous about which figure was which and what the denominator meant.
 */
describe("CreditPoolCard headline", () => {
  test("reads the remaining figure as a sentence naming both quantities", () => {
    const markup = renderToStaticMarkup(createElement(CreditPoolCard, { providerId: "workbuddy" }));
    expect(markup).toContain("4,093.36");
    expect(markup).toContain("credits available of");
    expect(markup).toContain("6,370");
    expect(markup).toContain("total");
    // The spent figure belongs to the caption, not the headline.
    expect(markup).toContain("2,276.64 used (36%) across 1 account");
  });
});
