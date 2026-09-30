import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApiKeyResponse, SharedKeyActivityDetail } from "../../src/data/contracts";

const activity: SharedKeyActivityDetail = {
  models: [
    {
      providerId: "openai",
      modelId: "gpt-5",
      retainedRequests: 8,
      retainedErrors: 1,
      retainedTokens: 270,
      todayRequests: 4,
      todayErrors: 0,
      todayTokens: 125,
    },
  ],
  requests: [
    {
      requestId: "event-1",
      startedAt: "2026-09-25T12:30:00.000Z",
      providerId: "openai",
      modelId: "gpt-5",
      status: "success",
      httpStatus: 200,
      clientIp: "203.0.113.*",
      inputTokens: 10,
      outputTokens: 15,
      totalTokens: 25,
    },
  ],
};

/** Records the key ids the recipients query was enabled for, per render. */
const sharedKeysCalls: Array<string | null> = [];

const usage = { requests: 1, errors: 0, inputTokens: 10, outputTokens: 20, totalTokens: 30 };

/** Whether the recipients query reports a refetch in flight (drives the spinner). */
let sharedKeysFetching = false;

/** Two live recipients and one revoked, to pin what "active" counts. */
const recipients = [
  {
    id: "child-1",
    label: "child-1",
    keyPrefix: "cart_live",
    issuedClientIp: "203.0.113.1",
    createdAt: "2026-01-02T00:00:00.000Z",
    revokedAt: null,
    allTime: usage,
    today: usage,
    lastUsedAt: "2026-01-02T00:00:00.000Z",
  },
  {
    id: "child-2",
    label: "child-2",
    keyPrefix: "cart_live",
    issuedClientIp: "203.0.113.2",
    createdAt: "2026-01-02T00:00:00.000Z",
    revokedAt: null,
    allTime: usage,
    today: usage,
    lastUsedAt: "2026-01-02T00:00:00.000Z",
  },
  {
    id: "child-3",
    label: "child-3",
    keyPrefix: "cart_dead",
    issuedClientIp: "203.0.113.3",
    createdAt: "2026-01-02T00:00:00.000Z",
    revokedAt: "2026-01-03T00:00:00.000Z",
    allTime: usage,
    today: usage,
    lastUsedAt: "2026-01-02T00:00:00.000Z",
  },
];

mock.module("../../src/hooks/api-keys", () => ({
  useShareApiKey: () => ({
    isPending: false,
    mutate: () => undefined,
    mutateAsync: async () => undefined,
  }),
  useRegenerateApiKey: () => ({
    isPending: false,
    mutate: () => undefined,
    mutateAsync: async () => undefined,
  }),
  useShareLink: () => ({ data: null, isPending: false, isError: false }),
  useRevokeSharedKey: () => ({
    isPending: false,
    mutate: () => undefined,
    mutateAsync: async () => undefined,
  }),
  useSharedKeys: (keyId: string | null) => {
    sharedKeysCalls.push(keyId);
    return {
      data: recipients,
      isPending: keyId !== null,
      isFetching: sharedKeysFetching,
      isError: false,
      refetch: () => undefined,
    };
  },
  useSharedKeyActivity: () => ({ data: activity, isPending: false, isError: false }),
}));

const { ChildDetail, ShareManagementContent, regenerateWarning } = await import(
  "../../src/components/ShareManagementDialog"
);

function renderNode(node: ReturnType<typeof createElement>): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, node));
}

function render(): string {
  return renderNode(createElement(ChildDetail, { parentId: "parent-id", childId: "child-id" }));
}

function key(overrides: Partial<ApiKeyResponse>): ApiKeyResponse {
  return {
    id: "key-1",
    label: "my key",
    keyMode: "personal",
    scopes: [],
    createdAt: "2026-01-02T00:00:00.000Z",
    tokensConsumed: 12_345,
    ...overrides,
  } as ApiKeyResponse;
}

describe("share management dialog", () => {
  test("expanded recipient exposes token usage without credential material", () => {
    const markup = render();
    expect(markup).toContain("Top models");
    expect(markup).toContain("gpt-5");
    expect(markup).toContain("Recent requests");
    // Token totals only: the detail deliberately drops the per-event client IP
    // and error fields the owner does not act on.
    expect(markup).toContain("25");
    expect(markup).not.toContain("203.0.113.*");
    expect(markup).not.toContain("child-id");
  });

  test("a personal key shows its own usage and never queries recipients", () => {
    sharedKeysCalls.length = 0;
    const markup = renderNode(
      createElement(ShareManagementContent, { parent: key({}) }),
    );
    // `/shared-keys` is a share-template route that 404s for a personal key, so
    // the query must be disabled rather than surfacing an error over the modal.
    expect(sharedKeysCalls).toEqual([null]);
    expect(markup).toContain("Usage");
    expect(markup).not.toContain("Recipients");
    expect(markup).toContain("Create link");
    // Lifetime tokens are real data for a personal key, not a placeholder.
    expect(markup).toContain("12.35K");
  });

  test("a share template lists recipients and its own link", () => {
    sharedKeysCalls.length = 0;
    const markup = renderNode(
      createElement(ShareManagementContent, {
        parent: key({ id: "template-1", keyMode: "share", label: "share template" }),
      }),
    );
    expect(sharedKeysCalls).toEqual(["template-1"]);
    expect(markup).toContain("Recipients");
    expect(markup).not.toContain("Usage");
    expect(markup).toContain("Create link");
  });

  test("a share template shows the parent quota bar above recipients", () => {
    // Three mocked recipients at 30 tokens each: the total is 90 against the
    // parent's budget, and the pill names what is left.
    const markup = renderNode(
      createElement(ShareManagementContent, {
        parent: key({
          id: "template-1",
          keyMode: "share",
          label: "share template",
          lifetimeTokenBudget: 1_000,
        }),
      }),
    );
    expect(markup).toContain("Total quota");
    expect(markup).toContain("90 / 1K");
    expect(markup).toContain("910 left");
    expect(markup).toContain('role="progressbar"');
  });

  test("the parent quota bar without a budget shows only the total", () => {
    const markup = renderNode(
      createElement(ShareManagementContent, {
        parent: key({
          id: "template-1",
          keyMode: "share",
          label: "share template",
          lifetimeTokenBudget: undefined,
        }),
      }),
    );
    expect(markup).toContain("Total quota used");
    expect(markup).not.toContain("left");
  });

  test("the lifetime budget renders as a bar with both figures", () => {
    const markup = renderNode(
      createElement(ShareManagementContent, {
        parent: key({ tokensConsumed: 8_400_000, lifetimeTokenBudget: 20_000_000 }),
      }),
    );
    // A bar is only honest for the lifetime budget: daily and monthly are
    // in-memory admission windows that never reach the console.
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain("8.4M / 20M");
    expect(markup).toContain('aria-valuenow="42"');
    expect(markup).toContain("width:42%");
  });

  test("an unlimited lifetime budget renders a full bar, not an empty one", () => {
    const markup = renderNode(
      createElement(ShareManagementContent, { parent: key({ lifetimeTokenBudget: undefined }) }),
    );
    // Nothing is consumed against a limit, so the bar reads as headroom: full
    // width, and never the exhausted tone.
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="100"');
    expect(markup).toContain("Unlimited");
    expect(markup).not.toContain("share-bar-fill--exhausted");
  });

  test("an exhausted budget caps the bar at 100 and marks it exhausted", () => {
    const markup = renderNode(
      createElement(ShareManagementContent, {
        parent: key({ tokensConsumed: 25_000_000, lifetimeTokenBudget: 20_000_000 }),
      }),
    );
    expect(markup).toContain('aria-valuenow="100"');
    expect(markup).toContain("share-bar-fill--exhausted");
  });

  test("the refresh button spins only while a refetch is in flight", () => {
    // The icon is inert without the class: `animate-spin` is a Tailwind utility,
    // so an unconditional icon looked identical idle and busy.
    expect(
      renderNode(
        createElement(ShareManagementContent, {
          parent: key({ id: "template-1", keyMode: "share" }),
        }),
      ),
    ).not.toContain("animate-spin");
    sharedKeysFetching = true;
    try {
      expect(
        renderNode(
          createElement(ShareManagementContent, {
            parent: key({ id: "template-1", keyMode: "share" }),
          }),
        ),
      ).toContain("animate-spin");
    } finally {
      sharedKeysFetching = false;
    }
  });

  test("the active-user count excludes revoked recipients", () => {
    const markup = renderNode(
      createElement(ShareManagementContent, {
        parent: key({ id: "template-1", keyMode: "share" }),
      }),
    );
    // Two live children and one revoked: the revoked key is still listed for its
    // usage history, but it can no longer be used, so counting it would overstate
    // who can still call the gateway.
    expect(markup).toContain("Active users: 2");
  });

  test("regenerating a personal key warns that the credential is rotated", () => {
    const warning = regenerateWarning(true);
    // The confirmation must describe the personal-mode consequence: the old
    // secret stops working. It must not claim recipients keep their keys, which
    // is the share-mode story and would be dangerous here.
    expect(warning.title).toBe("Regenerate this key?");
    expect(warning.message).toContain("rotates the key credential");
    expect(warning.message).toContain("401");
    expect(warning.message).not.toContain("Recipients keep the keys");
  });

  test("regenerating a share link warns the URL dies and recipients survive", () => {
    const warning = regenerateWarning(false);
    // Share-mode regenerate updates `share_links` in place: the URL stops
    // resolving but nothing the recipients hold is deleted. Claiming otherwise
    // would overstate the damage and scare the operator out of a safe action.
    expect(warning.title).toBe("Regenerate this link?");
    expect(warning.message).toContain("Recipients keep the keys");
    expect(warning.message).not.toContain("rotates the key credential");
  });
});
