import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApiKeysPanel } from "../../src/components/ApiKeysPanel";
import { queryKeys } from "../../src/data/query-keys";
import type { ApiKeyResponse, SessionUser } from "../../src/data/contracts";

const ACTIVE_KEY: ApiKeyResponse = {
  id: "key-active-0001",
  keyMode: "personal",
  label: "ci-key",
  scopes: ["dashboard:read"],
  keyPrefix: "ctk_",
  requestsPerMinute: 120,
  dailyTokenLimit: 1_000_000,
  monthlyTokenLimit: 10_000_000,
  maxConcurrentRequests: 4,
  modelAllowlist: ["openai/gpt-5", "anthropic/claude-x"],
  createdAt: "2026-01-02T00:00:00.000Z",
  tokensConsumed: 2_500_000,
};

const REVOKED_KEY: ApiKeyResponse = {
  id: "key-revoked-0002",
  keyMode: "personal",
  label: "old-key",
  scopes: ["dashboard:read"],
  keyPrefix: "rk_",
  createdAt: "2025-12-01T00:00:00.000Z",
  revokedAt: "2026-01-05T00:00:00.000Z",
  tokensConsumed: 10,
};
const SHARE_TEMPLATE: ApiKeyResponse = {
  id: "key-share-0003",
  keyMode: "share",
  label: "team-share",
  scopes: ["routing:invoke"],
  keyPrefix: "rk_",
  createdAt: "2026-01-03T00:00:00.000Z",
  tokensConsumed: 0,
};

function session(isPlatformAdmin: boolean): SessionUser {
  return {
    id: "user-1",
    username: "operator",
    email: "operator@example.test",
    displayName: null,
    isFirstBoot: false,
    sessionExpiresAt: "2026-12-31T00:00:00.000Z",
    isPlatformAdmin,
  };
}

function render(
  keys: readonly ApiKeyResponse[] | undefined,
  isPlatformAdmin = false,
): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (keys) queryClient.setQueryData(queryKeys.apiKeys.all, keys);
  queryClient.setQueryData(queryKeys.session.current, session(isPlatformAdmin));
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(ApiKeysPanel)),
  );
}

describe("API keys panel", () => {
  test("renders key rows with status, prefix and limits", () => {
    const markup = render([ACTIVE_KEY, REVOKED_KEY]);
    expect(markup).toContain("API Credentials");
    expect(markup).toContain("ci-key");
    expect(markup).toContain("old-key");
    expect(markup).toContain(">active<");
    expect(markup).toContain(">revoked<");
    expect(markup).toContain("ctk_…");
    expect(markup).toContain("Edit");
    expect(markup).toContain("Revoke");
  });

  test("offers a share entry point on every live key, labelled by kind", () => {
    // A personal key carries a handoff link; a share template carries an
    // enrollment link. Both are reached from the same control.
    expect(render([SHARE_TEMPLATE])).toContain("Recipients");
    const personal = render([ACTIVE_KEY]);
    expect(personal).toContain("Share");
    // A revoked key cannot be shared.
    expect(render([REVOKED_KEY])).not.toContain("Share</button>");
  });

  test("offers Rotate on a live personal key, before Revoke", () => {
    const markup = render([ACTIVE_KEY]);
    expect(markup).toContain("Rotate");
    // Rotating a credential is a distinct action from revoking it: the button
    // must sit before Revoke so the destructive control stays last.
    expect(markup.indexOf("Rotate")).toBeLessThan(markup.indexOf("Revoke"));
    // A revoked key has no live credential left to rotate.
    expect(render([REVOKED_KEY])).not.toContain("Rotate");
    // A share template has no credential of its own — its rotation is the link,
    // reached through the share dialog, so the row must not offer Rotate.
    expect(render([SHARE_TEMPLATE])).not.toContain("Rotate");
  });

  test("never renders a secret or key hash", () => {
    const markup = render([ACTIVE_KEY]);
    expect(markup).not.toContain("keyHash");
    expect(markup).not.toContain("key_hash");
    expect(markup).not.toContain("keyEncrypted");
  });

  test("does not render aggregate KPI tiles", () => {
    const markup = render([ACTIVE_KEY, REVOKED_KEY]);
    expect(markup).not.toContain("Active keys");
    expect(markup).not.toContain("Total usage");
    expect(markup).not.toContain("Total requests");
    expect(markup).not.toContain("issued credentials");
  });

  test("renders the empty state when no keys exist", () => {
    const markup = render([]);
    expect(markup).toContain("No API keys issued");
    expect(markup).toContain("Create Key");
  });

  test("renders a loading state before the key list resolves", () => {
    const markup = render(undefined);
    expect(markup).toContain("Loading API keys");
  });

  test("offers the cross-tenant ban list only to a platform admin", () => {
    // Bans are keyed on the client address, so they span every tenant; the
    // entry point is hidden for a tenant-scoped viewer.
    const admin = render([ACTIVE_KEY], true);
    expect(admin).toContain("Banned Users");
    // It sits beside Create Key, not in place of it.
    expect(admin).toContain("Create Key");
    expect(admin.indexOf("Banned Users")).toBeLessThan(admin.indexOf("Create Key"));
    expect(render([ACTIVE_KEY], false)).not.toContain("Banned Users");
  });
});
