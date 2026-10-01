import { describe, expect, test } from "bun:test";
import { createWebsearchHandler, type WebsearchHandlerDeps } from "../../../src/transport/dispatch/websearch";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";
import type { RouteCandidate } from "../../../src/transport/routing/route-model";
import type { ResolvedApiKey } from "../../../src/security/api-key-auth";
import type { ProviderAdapter, WebSearchOutcome } from "../../../src/providers/provider-registry";
import { GatewayError } from "../../../src/transport/gateway-error";

/**
 * The native web-search route resolves the caller's search model through the
 * routing engine, dispatches through the shared attempt loop, and returns the
 * normalized result envelope. These pin the observable contract: a provider's
 * normalized hits are returned in the envelope, the query reaches the adapter
 * unchanged, and a provider without the capability fails closed before any
 * upstream call.
 */
describe("createWebsearchHandler — native search route", () => {
  const MODEL = "exa-search";

  const authorization: ResolvedApiKey = {
    id: "key",
    tenantId: "tenant",
    scopes: [],
    snapshot: { api_key_id: "key", tenant_id: "tenant" },
  };

  function searchCandidate(): RouteCandidate {
    return {
      provider_id: "exa",
      model_id: MODEL,
      wire_family: "chat",
      service_kind: "websearch",
      endpoint: "/search",
      capability_profile: {},
    };
  }

  function harness(options: {
    readonly body: Record<string, unknown>;
    readonly candidates: RouteCandidate[];
    readonly adapter?: ProviderAdapter;
    readonly commits?: unknown[];
  }) {
    const stateStore = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/search", { method: "POST" });
    const state = stateStore.initialize(request, Date.now(), 60_000);
    state.authorization = authorization;
    state.ingressBody = options.body;
    const admissionService = {
      admit: async () => ({
        reservationId: "lease-1",
        apiKeyId: "key",
        released: false,
        commitUsage: async (usage: unknown) => {
          options.commits?.push(usage);
        },
        release: async () => {},
      }),
    };
    const routingEngine = {
      reserve: async () => ({
        candidate: options.candidates[0],
        lease_id: "reservation",
        expires_at: Date.now() + 60_000,
        acquired_at: Date.now(),
      }),
      release: async () => {},
    };
    const adapter =
      options.adapter ??
      ({
        provider_id: "exa",
        dispatch: async function* () {},
        websearch: async () => ({ results: [{ title: "T", url: "https://x.example", snippet: "s" }] }),
      } as unknown as ProviderAdapter);
    const adapterProviderId = options.candidates[0]?.provider_id ?? "exa";
    const deps = {
      db: {},
      providerAdapters: new Map([[adapterProviderId, adapter]]),
      proxyPreparer: {
        prepareNativeService: async (input: { model: string; serviceKind: string }) => {
          const candidates = options.candidates.filter(
            (c) => (c.service_kind ?? "llm") === input.serviceKind,
          );
          if (candidates.length === 0)
            throw new GatewayError(
              "capability_unsupported",
              400,
              `no eligible route serves the '${input.serviceKind}' service`,
            );
          return {
            authorization,
            candidates,
            plan: {
              revision: 1,
              candidates,
              requested_model: input.model,
              resolved_model: input.model,
              provider_id: candidates[0]!.provider_id,
            },
            estimatedInputTokens: 0,
            estimatedOutputTokens: 0,
            routingEngine,
            admissionService,
          };
        },
      },
      stateStore,
      telemetryBuffer: { enqueue: () => {} },
    } as unknown as WebsearchHandlerDeps;
    return { request, state, handler: createWebsearchHandler(deps) };
  }

  test("returns the normalized envelope and forwards the query to the adapter", async () => {
    let seen: Record<string, unknown> | undefined;
    const adapter = {
      provider_id: "exa",
      dispatch: async function* () {},
      websearch: async (body: Record<string, unknown>): Promise<WebSearchOutcome> => {
        seen = body;
        return {
          results: [
            { title: "First", url: "https://a.example", snippet: "one" },
            { title: "Second", url: "https://b.example", snippet: "two" },
          ],
        };
      },
    } as unknown as ProviderAdapter;
    const { request, handler } = harness({
      body: { model: MODEL, query: "hello", max_results: 2 },
      candidates: [searchCandidate()],
      adapter,
    });

    const response = await handler({ request });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      provider: string;
      results: unknown[];
      total_results: number;
    };
    expect(payload.provider).toBe("exa");
    expect(payload.results).toHaveLength(2);
    expect(payload.total_results).toBe(2);
    expect(seen?.query).toBe("hello");
    expect(seen?.max_results).toBe(2);
  });

  test("fails closed when the provider has no websearch capability", async () => {
    const adapter = {
      provider_id: "exa",
      dispatch: async function* () {},
    } as unknown as ProviderAdapter;
    const { request, handler } = harness({
      body: { model: MODEL, query: "hello" },
      candidates: [searchCandidate()],
      adapter,
    });
    await expect(handler({ request })).rejects.toMatchObject({ status: 400 });
  });

  test("rejects a missing query before any dispatch", async () => {
    const { request, handler } = harness({
      body: { model: MODEL },
      candidates: [searchCandidate()],
    });
    await expect(handler({ request })).rejects.toMatchObject({ status: 400 });
  });

  test("strips a thinking suffix from the search model", async () => {
    let seen: Record<string, unknown> | undefined;
    const adapter = {
      provider_id: "exa",
      dispatch: async function* () {},
      websearch: async (body: Record<string, unknown>): Promise<WebSearchOutcome> => {
        seen = body;
        return { results: [] };
      },
    } as unknown as ProviderAdapter;
    const { request, handler } = harness({
      body: { model: `${MODEL}(high)`, query: "q" },
      candidates: [searchCandidate()],
      adapter,
    });
    await handler({ request });
    expect(seen?.model).toBe(MODEL);
  });
});
