import { describe, expect, test } from "bun:test";
import { createSearchAdapter, searchParamsFromBody } from "../../../src/providers/search/search-provider";
import { SEARCH_PROVIDER_SPECS } from "../../../src/providers/search/search-providers";
import { GatewayError } from "../../../src/transport/gateway-error";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
  ProviderId,
  ResolvedCredential,
} from "../../../src/providers/provider-registry";

function target(providerId: string): ProviderDispatchTarget {
  return {
    provider_id: providerId as ProviderId,
    model_id: `${providerId}-search`,
    wire_family: "chat",
    endpoint_path: "/search",
    capabilities: {},
  };
}

function credential(providerId: string, secret = "tok"): ResolvedCredential {
  return {
    provider_id: providerId as ProviderId,
    credential_kind: "api_key",
    secret: new TextEncoder().encode(secret),
  };
}

function context(credentialValue: ResolvedCredential, fetchImpl: typeof fetch): ProviderDispatchContext {
  return {
    credential: credentialValue,
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetchImpl,
  } as ProviderDispatchContext;
}

describe("searchParamsFromBody", () => {
  test("rejects an empty query", () => {
    expect(() => searchParamsFromBody({ query: "   " })).toThrow(GatewayError);
  });

  test("defaults max_results to 10 and clamps to 50", () => {
    expect(searchParamsFromBody({ query: "x" }).maxResults).toBe(10);
    expect(searchParamsFromBody({ query: "x", max_results: 500 }).maxResults).toBe(50);
    expect(searchParamsFromBody({ query: "x", max_results: 0 }).maxResults).toBe(1);
  });

  test("reads search_type, country, language, and domain filter", () => {
    const params = searchParamsFromBody({
      query: "q",
      search_type: "news",
      country: "US",
      language: "en",
      domain_filter: ["example.com", "-spam.com"],
    });
    expect(params.searchType).toBe("news");
    expect(params.country).toBe("US");
    expect(params.language).toBe("en");
    expect(params.domainFilter).toEqual(["example.com", "-spam.com"]);
  });
});

describe("createSearchAdapter", () => {
  test("fails closed on a chat dispatch — a search provider serves no chat wire", () => {
    const adapter = createSearchAdapter(SEARCH_PROVIDER_SPECS.exa);
    expect(() =>
      adapter.dispatch(
        { model: "exa-search", messages: [], generation_controls: {}, stream: false, source_surface: "chat" },
        target("exa"),
        context(credential("exa"), (async () => new Response()) as unknown as typeof fetch),
      ),
    ).toThrow(GatewayError);
  });

  test("exa: posts the mapped body to /search with the x-api-key header and normalizes results", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          results: [
            { title: "First", url: "https://a.example/1", text: "body text", score: 0.9 },
            { title: "Second", url: "https://b.example/2", highlights: ["snippet two"] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const adapter = createSearchAdapter(SEARCH_PROVIDER_SPECS.exa);
    const outcome = await adapter.websearch!(
      { query: "hello world", max_results: 5, search_type: "web", domain_filter: ["a.example"] },
      target("exa"),
      context(credential("exa", "exa-key"), fetchImpl),
    );

    expect(captured?.url).toBe("https://api.exa.ai/search");
    expect(captured?.init.method).toBe("POST");
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("exa-key");
    const sent = JSON.parse(String(captured?.init.body));
    expect(sent.query).toBe("hello world");
    expect(sent.numResults).toBe(5);
    expect(sent.includeDomains).toEqual(["a.example"]);

    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[0]).toMatchObject({ title: "First", url: "https://a.example/1", score: 0.9 });
    expect(outcome.results[1]).toMatchObject({ url: "https://b.example/2", snippet: "snippet two" });
  });

  test("brave: GETs the web search endpoint with the subscription token header", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ web: { results: [{ title: "T", url: "https://c.example", description: "d" }] } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const adapter = createSearchAdapter(SEARCH_PROVIDER_SPECS.brave);
    const outcome = await adapter.websearch!(
      { query: "q", max_results: 3 },
      target("brave"),
      context(credential("brave", "brave-key"), fetchImpl),
    );
    expect(captured?.url).toContain("https://api.search.brave.com/web/search");
    expect(captured?.url).toContain("q=q");
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers["x-subscription-token"]).toBe("brave-key");
    expect(outcome.results[0]?.url).toBe("https://c.example");
  });

  test("a non-2xx upstream becomes a typed GatewayError carrying the upstream status", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const adapter = createSearchAdapter(SEARCH_PROVIDER_SPECS.tavily);
    await expect(
      adapter.websearch!({ query: "q" }, target("tavily"), context(credential("tavily"), fetchImpl)),
    ).rejects.toMatchObject({ status: 401 });
  });
});
