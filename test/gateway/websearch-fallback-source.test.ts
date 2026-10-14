/**
 * A search round is served by the fallback route, never by a chat model.
 *
 * The provider-level "supports web search" list is gone. Two surfaces used to
 * smuggle `llm` rows in as if they were search routes, and both are now
 * restricted to a row that declares `service_kind: "websearch"`:
 *
 * - `RoutingEngine.webSearchFallbackCandidates` — the sources the bridge runs
 *   after a model emits a `web_search` call.
 * - `ProxyRequestPreparer.prepareNativeService` — the routes eligible to
 *   answer `POST /v1/search`.
 *
 * The provider that loses the most is the one whose adapter *can* search but
 * whose catalog declares only chat rows: Codex and Antigravity were fallback
 * sources purely by virtue of that list. They now take the ordinary fallback
 * set (Exa / Parallel / Gemini) like every other chat model. Pinned here so
 * the boundary does not drift back.
 */
import { describe, expect, test } from "bun:test";
import { RoutingEngine } from "../../src/transport/routing/router";
import type { RouteCandidate, RouteSnapshot } from "../../src/transport/routing/route-model";

function candidate(overrides: Record<string, unknown> = {}): RouteCandidate {
  return {
    provider_id: "exa",
    model_id: "exa",
    service_kind: "websearch",
    endpoint: "/search",
    wire_family: "chat",
    capability_profile: {},
    ...overrides,
  } as unknown as RouteCandidate;
}

/**
 * One declared search route (Exa) plus two chat rows from providers whose
 * adapters implement `websearch` but whose catalogs declare chat only.
 */
function snapshot(): RouteSnapshot {
  return {
    revision: 1,
    candidates: [
      candidate(),
      candidate({
        provider_id: "codex",
        model_id: "gpt-5",
        service_kind: "llm",
        endpoint: "/responses",
        wire_family: "responses",
      }),
      candidate({
        provider_id: "antigravity",
        model_id: "claude-sonnet-4-5",
        service_kind: "llm",
        endpoint: "/v1/messages",
        wire_family: "messages",
      }),
      // Gemini declares a real search row, so it stays.
      candidate({
        provider_id: "gemini",
        model_id: "gemini-2.5-flash",
        service_kind: "websearch",
        endpoint: "/v1beta/models/gemini-2.5-flash:generateContent",
      }),
    ],
    aliases: {},
    combos: {},
    created_at: Date.now(),
  } as unknown as RouteSnapshot;
}

describe("web search fallback sources", () => {
  test("a chat row is never a fallback source", () => {
    const providers = new RoutingEngine()
      .webSearchFallbackCandidates(snapshot(), null)
      .map((entry) => entry.provider_id);
    // Exa and Gemini declare search rows; Codex and Antigravity do not.
    expect(providers.sort()).toEqual(["exa", "gemini"]);
  });

  test("a tenant-scoped search route is visible to its tenant only", () => {
    const snap = snapshot();
    const tenantScoped = {
      ...snap,
      candidates: [candidate({ tenant_id: "t1" }), candidate({ provider_id: "gemini", model_id: "gemini-2.5-flash", tenant_id: "t2" })],
    } as unknown as RouteSnapshot;
    const providers = new RoutingEngine()
      .webSearchFallbackCandidates(tenantScoped, "t1")
      .map((entry) => entry.provider_id);
    expect(providers).toEqual(["exa"]);
  });

  test("one provider contributes at most one source", () => {
    const snap = snapshot();
    const duplicated = {
      ...snap,
      candidates: [
        candidate({ model_id: "exa" }),
        candidate({ model_id: "exa-search" }),
      ],
    } as unknown as RouteSnapshot;
    const providers = new RoutingEngine()
      .webSearchFallbackCandidates(duplicated, null)
      .map((entry) => entry.provider_id);
    expect(providers).toEqual(["exa"]);
  });
});
