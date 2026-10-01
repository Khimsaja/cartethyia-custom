import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The card reads the routing strategy through one hook; mock it so the render
// exercises the credit-floor field's presence and value without a live API.
let creditFloor: number | null = null;
let maxInflight: number | null = null;

mock.module("../../../src/hooks/use-routing-strategy", () => ({
  ROUTING_ACTIVE_LABEL: { fallback: "Failover", roundRobin: "Round robin" },
  PROXY_UNSUPPORTED_HINT_PROVIDERS: new Set<string>(),
  useRoutingStrategy: () => ({
    strategy: "fallback",
    roundRobinEnabled: false,
    setRoundRobinEnabled: () => undefined,
    rotateCount: 1,
    setRotateCount: () => undefined,
    maxInflight,
    creditFloor,
    bypassProxy: false,
    userAgent: "codex_cli_rs/0.156.1",
    setUserAgent: () => undefined,
    isLoading: false,
    isError: false,
    isSaving: false,
    saveFailed: false,
    refetch: () => undefined,
    setMaxInflight: () => undefined,
    setCreditFloor: () => undefined,
    setBypassProxy: () => undefined,
  }),
}));

const { RoutingStrategyCard } = await import(
  "../../../src/routes/provider-detail/RoutingStrategyCard"
);

describe("RoutingStrategyCard credit floor", () => {
  test("renders the credit-floor field with an empty placeholder when unset", () => {
    creditFloor = null;
    const html = renderToStaticMarkup(
      createElement(RoutingStrategyCard, { providerId: "openai", showUserAgent: false }),
    );
    expect(html).toContain("Credit floor / account");
    // No value set → the input shows its placeholder, not a number.
    expect(html).toContain('placeholder="None"');
  });

  test("reflects the saved credit-floor value", () => {
    creditFloor = 30;
    const html = renderToStaticMarkup(
      createElement(RoutingStrategyCard, { providerId: "openai", showUserAgent: false }),
    );
    expect(html).toContain('id="routing-credit-floor"');
    expect(html).toContain('value="30"');
  });
});
