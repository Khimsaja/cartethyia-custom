import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShareEnrollmentData, ShareHandoffData, ShareLinkData } from "../../../src/hooks/share-data";

(globalThis as { window?: unknown }).window = {
  location: { pathname: "/share/public-token", origin: "https://gateway.example" },
  localStorage: { getItem: () => null, setItem: () => undefined },
};

interface ShareState { data: ShareLinkData | null; error: string | null; loading: boolean }
let shareState: ShareState = { data: null, error: null, loading: true };
/** The stats section is a second hook call; it is routed by path, not shared. */
let statsState: { data: unknown; error: string | null; loading: boolean } = {
  data: null,
  error: null,
  loading: true,
};
mock.module("../../../src/hooks/share-data", () => ({
  useShareData: (path: string): ShareState =>
    (path.endsWith("/stats") ? statsState : shareState) as ShareState,
}));
// Load after mock.module so the page captures the mocked data hook.
const { SharePage, tokenFromPathname } = await import("../../../src/apps/share/page");
function render(): string { return renderToStaticMarkup(createElement(SharePage)); }

const data: ShareEnrollmentData = {
  kind: "enroll",
  name: "Team Access", keyPrefix: "ctk", canIssue: true, alreadyIssued: false,
  dailyLimit: 50_000, monthlyLimit: null, oneTimeLimit: null, requestsPerMinute: 20, maxConcurrentRequests: 3,
  modelAllowlist: ["gpt-5"], modelDenylist: null, modelPrefix: "gpt-", notes: { title: null, subtitle: "Shared access", body: "Use responsibly" },
  sharePopup: { enabled: false, hasImage: false, title: null, body: null },
  expiresAt: null,
};

const statsFixture = {
  totals: {
    requests: 128,
    errors: 3,
    inputTokens: 80_000,
    outputTokens: 4_200,
    totalTokens: 84_200,
    lastHourRequests: 37,
    todayTokens: 12_000,
    monthTokens: 40_000,
  },
  recipients: { total: 5, active: 4 },
  hourly: Array.from({ length: 24 }, (_unused, index) => ({
    hour: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
    requests: index,
  })),
  models: [{ providerId: "anthropic", modelId: "claude-sonnet", requests: 90, tokens: 70_000 }],
  clientIps: [{ ip: "203.0.113.xxx", requests: 90, tokens: 70_000, lastSeenAt: null }],
};

const handoff: ShareHandoffData = {
  kind: "handoff",
  name: "Personal key", keyPrefix: "rk_", key: "rk_handed_over_secret",
  dailyLimit: null, monthlyLimit: null, oneTimeLimit: null, requestsPerMinute: null, maxConcurrentRequests: null,
  modelAllowlist: ["gpt-5"], modelDenylist: null, modelPrefix: null, notes: { title: null, subtitle: null, body: null },
  sharePopup: { enabled: false, hasImage: false, title: null, body: null },
  expiresAt: null,
};

describe("public share enrollment page", () => {
  test("shows a loading state while enrollment policy is fetched", () => {
    shareState = { data: null, error: null, loading: true };
    const markup = render();
    expect(markup).toContain("Loading enrollment policy…");
    expect(markup).not.toContain("Generate API Key");
  });

  test("offers the public endpoint and key generation action", () => {
    shareState = { data, error: null, loading: false };
    const markup = render();
    // The recipient is told to call the origin they reached this page by.
    expect(markup).toContain("https://gateway.example/v1");
    expect(markup).toContain("Base URL");
    expect(markup).toContain("Generate API Key");
  });

  test("shows family quota in the hero and a collapsed stats section", () => {
    shareState = { data, error: null, loading: false };
    statsState = { data: statsFixture, error: null, loading: false };
    const markup = render();
    // Quota rows live in the hero, using the family total against the policy limit.
    expect(markup).toContain("share-quota");
    expect(markup).toContain("Daily");
    expect(markup).toContain("84.2K");
    // Stats are present but collapsed: the toggle exists, its body does not.
    expect(markup).toContain("STATS &amp; ACTIVITY");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("TOP MODELS");
    expect(markup).not.toContain("203.0.113.xxx");
  });
  test("requires a display name before enabling shared key issuance", () => {
    shareState = { data, error: null, loading: false };
    const markup = render();
    expect(markup).toContain("required");
    expect(markup).toContain("disabled=\"\"");
    expect(markup).toContain("Enter your name to generate a personal key.");
  });
  test("renders an image popup trigger with owner-edited copy", () => {
    shareState = {
      data: {
        ...data,
        sharePopup: {
          enabled: true,
          hasImage: true,
          title: "Keep it online",
          body: "Your support covers hosting.",
        },
      },
      error: null,
      loading: false,
    };
    const markup = render();
    expect(markup).toContain("Open popup");
    expect(markup).toContain("Keep it online");
    expect(markup).toContain("share-support-trigger");
    expect(markup).not.toContain("share-support-dialog");
    // The popup has no action button: title, message, and dismiss only.
    expect(markup).not.toContain("share-support-action");
  });

  test("shows the repository link beside Home, and drops the policy and prefix panels", () => {
    shareState = { data, error: null, loading: false };
    const markup = render();
    const github = markup.indexOf("Cartethyia on GitHub");
    const home = markup.indexOf("share-home-link");
    expect(github).toBeGreaterThan(-1);
    expect(home).toBeGreaterThan(-1);
    // The badge sits in the topbar actions, immediately before the Home link.
    expect(github).toBeLessThan(home);
    expect(markup).toContain("https://img.shields.io/github/stars/risunCode/Cartethyia");
    // The enrollment terms panel and the key prefix pill are gone.
    expect(markup).not.toContain("Your enrollment terms");
    expect(markup).not.toContain("Requests / minute");
    expect(markup).not.toContain("Prefix ctk");
    // "Ready to enroll" is the ordinary state and is not announced.
    expect(markup).not.toContain("Ready to enroll");
  });

  test("shows policy and explicit child-key generation without disclosing any credential", () => {
    shareState = { data, error: null, loading: false };
    const markup = render();
    expect(markup).toContain("Team Access");
    expect(markup).toContain("Generate API Key");
    expect(markup).toContain("Allowed models");
    expect(markup).toContain("gpt-5");
    expect(markup).toContain("Required model prefix: gpt-");
    // The trust copy was removed; the credential-hiding guarantee it described
    // still holds, so assert the secret never renders rather than the sentence.
    expect(markup).not.toContain("parentSecret");
    expect(markup).not.toContain("sk-parent-raw");
    expect(markup).not.toContain("telemetry");
  });

  test("defaults the model list to raw full ids and offers a grouped switch", () => {
    shareState = {
      data: { ...data, modelAllowlist: ["codex/gpt-5.5", "claude/claude-sonnet-5"] },
      error: null,
      loading: false,
    };
    const markup = render();
    // Raw is the default, so the exact id a client must send is on screen and
    // the provider-bucketed headings are not.
    expect(markup).toContain("codex/gpt-5.5");
    expect(markup).toContain("claude/claude-sonnet-5");
    expect(markup).toContain("share-model-list-raw");
    expect(markup).not.toContain("share-model-groups");
    // Both readings are reachable from the switch beside Copy all.
    expect(markup).toContain("share-view-switch");
    expect(markup).toContain("Grouped");
    expect(markup).toContain("Copy all");
  });

  test("announces an already-claimed enrollment", () => {
    shareState = { data: { ...data, canIssue: false, alreadyIssued: true }, error: null, loading: false };
    const markup = render();
    expect(markup).toContain("An active key has already been issued from this IP.");
    expect(markup).not.toContain("Generate API Key");
  });

  test("reveals the key a handoff link carries, with no issuance action", () => {
    shareState = { data: handoff, error: null, loading: false };
    const markup = render();
    // A personal key's link exists to reveal that key, so the page shows it
    // rather than offering to mint one.
    expect(markup).toContain("rk_handed_over_secret");
    expect(markup).toContain("SHARED ACCESS / KEY");
    expect(markup).not.toContain("Generate API Key");
    expect(markup).not.toContain("An active key has already been issued from this IP.");
    expect(markup).toContain("https://gateway.example/v1");
  });

  test("says a handoff link cannot reveal a key when its ciphertext is gone", () => {
    shareState = { data: { ...handoff, key: null }, error: null, loading: false };
    const markup = render();
    expect(markup).toContain("This link can no longer reveal its key.");
    expect(markup).not.toContain("Generate API Key");
  });

  test("shows a useful unavailable state", () => {
    shareState = { data: null, error: "This enrollment link has expired.", loading: false };
    expect(render()).toContain("This enrollment link has expired.");
  });

  test("extracts the enrollment token from the pathname", () => {
    expect(tokenFromPathname("/share/public-token/")).toBe("public-token");
    expect(tokenFromPathname("/share/public-token")).toBe("public-token");
  });
});
