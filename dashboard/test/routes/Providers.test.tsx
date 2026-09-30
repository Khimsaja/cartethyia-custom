import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import Providers from "../../src/features/providers/ProvidersPage";
import { queryKeys } from "../../src/data/query-keys";
import type { ProviderAccountResponse, ProviderResponse } from "../../src/data/contracts";

/**
 * Two defects in the provider list card are covered here, both of which only
 * showed up in the list and never on the provider's own detail page:
 *
 * 1. A model-scoped throttle keeps `status: "active"` and leaves
 *    `cooldownUntil` untouched (`account-health-service.ts` writes only
 *    `modelCooldowns`), so the card's rollup — built from `status` — reported
 *    the account as a healthy connection while the detail page said models were
 *    cooling.
 * 2. `.provider-grid` stretches every card in a row to the tallest one, but the
 *    card's `<Link>` was only as tall as its own content, so the strip below a
 *    shorter card was not part of the link and swallowed clicks.
 */

const USAGE = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };

function account(overrides: Partial<ProviderAccountResponse>): ProviderAccountResponse {
  return {
    id: "acct-1",
    providerId: "openai",
    tenantId: null,
    label: "main",
    credentialKind: "api_key",
    status: "active",
    usageToday: USAGE,
    usageAllTime: USAGE,
    createdAt: "2026-01-01T00:00:00.000Z",
    sortIndex: 0,
    ...overrides,
  };
}

const PROVIDER: ProviderResponse = {
  providerId: "openai",
  enabled: true,
  isBuiltIn: true,
  requiresAccount: true,
  hasAdapterUserAgent: false,
  supportsModelDiscovery: true,
};

const CUSTOM_PROVIDER: ProviderResponse = {
  providerId: "custom-openai",
  label: "Custom OpenAI",
  enabled: true,
  isBuiltIn: false,
  requiresAccount: true,
  hasAdapterUserAgent: false,
  supportsModelDiscovery: true,
};

const inMinutes = (minutes: number): string =>
  new Date(Date.now() + minutes * 60_000).toISOString();

function renderProviders(
  accounts: readonly ProviderAccountResponse[],
  provider: ProviderResponse = PROVIDER,
  options: {
    models?: readonly string[];
    modelError?: boolean;
    accountError?: boolean;
    modelsPending?: boolean;
    accountsPending?: boolean;
  } = {},
): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
  queryClient.setQueryData(queryKeys.providers.all, [provider]);
  const modelsQuery = queryClient.getQueryCache().build(queryClient, {
    queryKey: queryKeys.providers.models(provider.providerId),
    queryFn: async () => options.models ?? [],
  });
  modelsQuery.setState({
    data: options.modelsPending ? undefined : options.models ?? [],
    status: options.modelsPending ? "pending" : options.modelError ? "error" : "success",
    fetchStatus: options.modelsPending ? "fetching" : "idle",
    error: options.modelError ? new Error("models unavailable") : null,
    errorUpdateCount: options.modelError ? 1 : 0,
    dataUpdateCount: options.modelError ? 0 : options.modelsPending ? 0 : 1,
    fetchFailureCount: options.modelError ? 1 : 0,
    fetchFailureReason: options.modelError ? new Error("models unavailable") : null,
    fetchMeta: null,
    isInvalidated: false,
    dataUpdatedAt: options.modelsPending ? 0 : Date.now(),
    errorUpdatedAt: options.modelError ? Date.now() : 0,
  });
  const accountsQuery = queryClient.getQueryCache().build(queryClient, {
    queryKey: queryKeys.providers.accounts(provider.providerId),
    queryFn: async () => accounts,
  });
  accountsQuery.setState({
    data: options.accountsPending ? undefined : accounts,
    status: options.accountsPending ? "pending" : options.accountError ? "error" : "success",
    fetchStatus: options.accountsPending ? "fetching" : "idle",
    error: options.accountError ? new Error("accounts unavailable") : null,
    errorUpdateCount: options.accountError ? 1 : 0,
    dataUpdateCount: options.accountError ? 0 : options.accountsPending ? 0 : 1,
    fetchFailureCount: options.accountError ? 1 : 0,
    fetchFailureReason: options.accountError ? new Error("accounts unavailable") : null,
    fetchMeta: null,
    isInvalidated: false,
    dataUpdatedAt: options.accountsPending ? 0 : Date.now(),
    errorUpdatedAt: options.accountError ? Date.now() : 0,
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        { initialEntries: ["/providers"] },
        createElement(Providers),
      ),
    ),
  );
}

describe("provider list card — per-model cooldown", () => {
  test("an account cooling one model is reported, not shown as healthy", () => {
    const markup = renderProviders([
      account({ modelCooldowns: { "gpt-5": inMinutes(10) } }),
    ]);

    expect(markup).toContain("Cooling");
    // The account is still routable for its other models, so "Connected" stays
    // true at the same time — the two badges describe different facts.
    expect(markup).toContain("1 Connected");
  });

  test("an expired per-model deadline is not reported", () => {
    const markup = renderProviders([
      account({ modelCooldowns: { "gpt-5": new Date(Date.now() - 60_000).toISOString() } }),
    ]);

    expect(markup).not.toContain("Cooling");
    expect(markup).toContain("1 Connected");
  });

  test("counts cooling accounts, not the backoffs they carry", () => {
    // One account cooling three models is one row the operator has to look at;
    // counting raw entries would report a single account as three problems.
    const markup = renderProviders([
      account({ modelCooldowns: { a: inMinutes(5), b: inMinutes(10), c: inMinutes(15) } }),
    ]);

    expect(markup).toContain(">1 Cooling<");
  });

  test("an account with no live backoff adds no cooling badge", () => {
    const markup = renderProviders([account({})]);

    expect(markup).not.toContain("Cooling");
    expect(markup).toContain("1 Connected");
  });
});

describe("provider list card — clickable area", () => {
  /** The `<a>` wrapping a provider card's content. */
  function providerLink(markup: string): string {
    const match = markup.match(/<a style="[^"]*" href="\/providers\/[^"]*"/);
    if (match === null) throw new Error("provider card link not found");
    return match[0];
  }

  test("the card is a column so the link can stretch to the grid row height", () => {
    const markup = renderProviders([account({})]);

    // Both halves are required: the card must be a flex column for `flex: 1`
    // on the link to have anything to grow into.
    expect(markup).toContain('class="card-solid" style="position:relative;overflow:hidden;display:flex;flex-direction:column');
    expect(providerLink(markup)).toContain("flex:1");
  });

  test("a short card still fills its grid cell", () => {
    // The reported case: a provider whose badges wrap to a second line makes
    // its row taller than a sibling card's content. The sibling must still be
    // clickable across its whole height.
    const tall = renderProviders([
      account({ id: "a", label: "one", modelCooldowns: { m: inMinutes(5) } }),
      account({ id: "b", label: "two", status: "cooldown" }),
    ]);
    const short = renderProviders([account({})]);

    expect(providerLink(tall)).toContain("flex:1");
    expect(providerLink(short)).toContain("flex:1");
  });
});

describe("provider list card — secondary query states", () => {
  test("pending model and account queries are explicit", () => {
    const markup = renderProviders([], PROVIDER, { modelsPending: true, accountsPending: true });

    expect(markup).toContain("Loading models");
    expect(markup).toContain("Loading connections");
    expect(markup).not.toContain("No models");
    expect(markup).not.toContain("No connections");
  });

  test("successful empty model and account queries are explicit", () => {
    const markup = renderProviders([], PROVIDER, { models: [] });

    expect(markup).toContain("No models");
    expect(markup).toContain("No connections");
    expect(markup).not.toContain("Loading models");
    expect(markup).not.toContain("Models unavailable");
  });

  test("a secondary query error is unavailable rather than empty", () => {
    const markup = renderProviders([], PROVIDER, { modelError: true, accountError: true });

    expect(markup).toContain("Models unavailable");
    // An error after a cached empty response keeps that stale result visible,
    // alongside the explicit unavailable marker.
    expect(markup).toContain("Connections unavailable");
    expect(markup).toContain("No connections");
    expect(markup).not.toContain("No models");
  });

  test("custom provider cards use the same secondary states", () => {
    const markup = renderProviders([], CUSTOM_PROVIDER, { modelError: true, accountError: true });

    expect(markup).toContain("Models unavailable");
    expect(markup).toContain("Connections unavailable");
    expect(markup).toContain("Custom OpenAI");
  });

  test("custom provider cards show loading and empty states", () => {
    const loading = renderProviders([], CUSTOM_PROVIDER, {
      modelsPending: true,
      accountsPending: true,
    });
    expect(loading).toContain("Loading models");
    expect(loading).toContain("Loading connections");

    const empty = renderProviders([], CUSTOM_PROVIDER, { models: [] });
    expect(empty).toContain("No models");
    expect(empty).toContain("No connections");
  });
});
