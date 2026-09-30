import { describe, expect, test } from "bun:test";
import { createSystemoneHandler, type SystemoneHandlerDeps } from "../../../src/transport/dispatch/systemone";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";
import type { RouteCandidate } from "../../../src/transport/routing/route-model";
import type { ResolvedApiKey } from "../../../src/security/api-key-auth";
import type { ProviderAdapter } from "../../../src/providers/provider-registry";
import { GatewayError } from "../../../src/transport/gateway-error";

/**
 * The native System One route posts an opaque `{state, questions}` decision body
 * through the shared attempt loop and returns the upstream `{answers}` body.
 * These pin the observable contract: the body is forwarded unchanged (with the
 * thinking suffix stripped), a decision response is returned verbatim, and a
 * chat-shaped body or a provider without the capability fails closed before any
 * upstream call.
 */
describe("createSystemoneHandler — native decision route", () => {
  const MODEL = "typesafe/jev-1.13";

  const authorization: ResolvedApiKey = {
    id: "key",
    tenantId: "tenant",
    scopes: [],
    snapshot: { api_key_id: "key", tenant_id: "tenant" },
  };

  function systemoneCandidate(): RouteCandidate {
    return {
      provider_id: "openrouter",
      model_id: MODEL,
      wire_family: "chat",
      service_kind: "systemone",
      endpoint: "/systemone",
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
    const request = new Request("https://gateway.test/v1/systemone", { method: "POST" });
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
        provider_id: "openrouter",
        dispatch: async function* () {},
        systemone: async () =>
          new Response(
            JSON.stringify({ model: MODEL, answers: { probe: { type: "noul", noul: 0.9 } } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      } as unknown as ProviderAdapter);
    const adapterProviderId = options.candidates[0]?.provider_id ?? "openrouter";
    const deps = {
      db: {},
      providerAdapters: new Map([[adapterProviderId, adapter]]),
      proxyPreparer: {
        prepareNativeService: async (input: { model: string; serviceKind: string }) => {
          // The route filters to candidates whose row is the systemone kind, so
          // a mismatched kind yields an empty set — mirror that here.
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
            estimatedInputTokens: 10,
            estimatedOutputTokens: 10,
            routingEngine,
            admissionService,
          };
        },
      },
      stateStore,
      telemetryBuffer: { enqueue: () => {} },
    } as unknown as SystemoneHandlerDeps;
    return { request, state, handler: createSystemoneHandler(deps) };
  }

  const validBody = {
    model: MODEL,
    state: "Customer was charged twice.",
    questions: { probe: { type: "noul", instructions: "Billing problem?" } },
  };

  test("forwards the decision body and returns the upstream answers verbatim", async () => {
    let seen: Record<string, unknown> | undefined;
    const adapter = {
      provider_id: "openrouter",
      dispatch: async function* () {},
      systemone: async (body: Record<string, unknown>) => {
        seen = body;
        return new Response(
          JSON.stringify({ model: MODEL, answers: { probe: { type: "noul", noul: 0.9 } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    } as unknown as ProviderAdapter;
    const { request, handler } = harness({
      body: validBody,
      candidates: [systemoneCandidate()],
      adapter,
    });

    const response = await handler({ request });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      model: MODEL,
      answers: { probe: { type: "noul", noul: 0.9 } },
    });
    // The decision payload reaches the adapter untouched.
    expect(seen).toEqual(validBody);
  });

  test("strips a thinking suffix from the model before dispatch", async () => {
    let seen: Record<string, unknown> | undefined;
    const adapter = {
      provider_id: "openrouter",
      dispatch: async function* () {},
      systemone: async (body: Record<string, unknown>) => {
        seen = body;
        return new Response(JSON.stringify({ answers: { probe: { type: "noul", noul: 1 } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    } as unknown as ProviderAdapter;
    const { request, handler } = harness({
      body: { ...validBody, model: `${MODEL}(high)` },
      candidates: [systemoneCandidate()],
      adapter,
    });

    await handler({ request });
    expect(seen?.model).toBe(MODEL);
  });

  test("rewrites the caller's prefixed model to the row's own upstream id", async () => {
    // The caller names the model with its provider prefix
    // (`opencodeft/jev-1.13-free`); upstream expects the bare row id. Every
    // canonical dispatch rewrites `model` to `candidate.model_id`, so the
    // native body must too or the decision endpoint answers "not supported".
    let seen: Record<string, unknown> | undefined;
    const adapter = {
      provider_id: "opencodeft",
      dispatch: async function* () {},
      systemone: async (body: Record<string, unknown>) => {
        seen = body;
        return new Response(JSON.stringify({ answers: { probe: { type: "noul", noul: 1 } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    } as unknown as ProviderAdapter;
    const bareCandidate: RouteCandidate = {
      provider_id: "opencodeft",
      model_id: "jev-1.13-free",
      wire_family: "chat",
      service_kind: "systemone",
      endpoint: "/zen/v1/systemone",
      capability_profile: {},
    };
    const { request, handler } = harness({
      body: { ...validBody, model: "opencodeft/jev-1.13-free" },
      candidates: [bareCandidate],
      adapter,
    });

    await handler({ request });
    expect(seen?.model).toBe("jev-1.13-free");
  });

  test("rejects a body missing state or questions before any upstream call", async () => {
    let called = false;
    const adapter = {
      provider_id: "openrouter",
      dispatch: async function* () {},
      systemone: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    } as unknown as ProviderAdapter;
    for (const body of [
      { model: MODEL, questions: validBody.questions },
      { model: MODEL, state: validBody.state },
      { model: MODEL, state: validBody.state, questions: [] },
    ]) {
      const { request, handler } = harness({
        body,
        candidates: [systemoneCandidate()],
        adapter,
      });
      await expect(handler({ request })).rejects.toMatchObject({ status: 400 });
    }
    expect(called).toBe(false);
  });

  test("fails closed when the model's row is not a systemone service", async () => {
    // A chat model named on the systemone route finds no candidate: the route
    // filters on the row's own service kind, so a chat row never dispatches a
    // decision body to a chat endpoint.
    const chatCandidate: RouteCandidate = {
      provider_id: "openrouter",
      model_id: "openai/gpt-5",
      wire_family: "chat",
      endpoint: "/chat/completions",
      capability_profile: {},
    };
    const { request, handler } = harness({
      body: { ...validBody, model: "openai/gpt-5" },
      candidates: [chatCandidate],
    });
    await expect(handler({ request })).rejects.toMatchObject({ code: "capability_unsupported" });
  });

  test("reports the upstream decision error status to the client", async () => {
    const adapter = {
      provider_id: "openrouter",
      dispatch: async function* () {},
      systemone: async () =>
        new Response('{"error":{"message":"No cookie auth credentials found"}}', { status: 401 }),
    } as unknown as ProviderAdapter;
    const { request, handler } = harness({
      body: validBody,
      candidates: [systemoneCandidate()],
      adapter,
    });
    await expect(handler({ request })).rejects.toMatchObject({ status: 401 });
  });
});
