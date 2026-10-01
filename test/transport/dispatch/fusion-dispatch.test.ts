import { describe, expect, test } from "bun:test";
import { dispatchFusionRequest, type FusionDispatchDeps } from "../../../src/transport/dispatch/fusion-dispatch";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";
import type { PreparedProxyRequest } from "../../../src/transport/request/preparer";
import type { RouteCandidate } from "../../../src/transport/routing/route-model";
import type { ResolvedApiKey } from "../../../src/security/api-key-auth";
import type { ProviderAdapter } from "../../../src/providers/provider-registry";
import type { CanonicalEvent, CanonicalRequest } from "../../../src/transport/canonical-model";

/**
 * The transport side of a fusion combo: every panel model dispatches through the
 * shared lease/credential path, and the judge synthesizes a final answer whose
 * events the caller encodes. These pin the observable contract — the panel sees
 * the prompt non-streaming with tools stripped, the judge sees every panel
 * answer, and the request is accounted exactly once at the terminal attempt.
 */
describe("dispatchFusionRequest", () => {
  const authorization: ResolvedApiKey = {
    id: "key",
    tenantId: "tenant",
    scopes: [],
    snapshot: { api_key_id: "key", tenant_id: "tenant" },
  };

  function candidate(model: string): RouteCandidate {
    return {
      // Provider id equals the model so the terminal attempt's provider is
      // observable in `state.outcome.providerId`.
      provider_id: model,
      model_id: model,
      wire_family: "chat",
      endpoint: "/v1/chat/completions",
      capability_profile: {},
    };
  }

  function harness(options: {
    readonly panel: readonly string[];
    readonly judge: string;
    readonly canonicalRequest: CanonicalRequest;
    readonly adapterDispatch: (request: CanonicalRequest) => readonly CanonicalEvent[];
    readonly commits?: unknown[];
    readonly telemetry?: unknown[];
  }) {
    const stateStore = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(request, Date.now(), 60_000);
    state.authorization = authorization;
    state.ingressBody = options.canonicalRequest;
    const commits = options.commits ?? [];
    const telemetry = options.telemetry ?? [];
    const admissionService = {
      admit: async () => ({
        reservationId: "lease",
        apiKeyId: "key",
        released: false,
        commitUsage: async (usage: unknown) => {
          commits.push(usage);
        },
        release: async () => {},
      }),
    };
    const routingEngine = {
      reserve: async () => ({
        candidate: candidate("x"),
        lease_id: "reservation",
        expires_at: Date.now() + 60_000,
        acquired_at: Date.now(),
      }),
      release: async () => {},
    };
    const adapter = {
      provider_id: "openai",
      dispatch: async function* (req: CanonicalRequest) {
        for (const event of options.adapterDispatch(req)) yield event;
      },
    } as unknown as ProviderAdapter;
    const seenRequests: CanonicalRequest[] = [];
    const preparer = {
      prepare: async (input: { canonicalRequest: CanonicalRequest }) => {
        seenRequests.push(input.canonicalRequest);
        return {
          canonicalRequest: input.canonicalRequest,
          authorization,
          candidate: candidate(input.canonicalRequest.model),
          eligibleRouteCandidates: [candidate(input.canonicalRequest.model)],
          plan: {
            revision: 1,
            candidates: [candidate(input.canonicalRequest.model)],
            requested_model: input.canonicalRequest.model,
            resolved_model: input.canonicalRequest.model,
            provider_id: input.canonicalRequest.model,
          },
          estimatedInputTokens: 5,
          estimatedOutputTokens: 5,
          deadlineMs: state.deadlineMs,
          routingEngine,
          admissionService,
        } as unknown as PreparedProxyRequest;
      },
    };
    const deps = {
      db: {},
      providerAdapters: new Map(),
      resolveProviderAdapter: async () => adapter,
      proxyPreparer: preparer,
      telemetryBuffer: { enqueue: (row: unknown) => telemetry.push(row) },
    } as unknown as FusionDispatchDeps;
    return { state, deps, seenRequests, commits, telemetry };
  }

  const baseRequest: CanonicalRequest = {
    model: "my-fusion",
    messages: [{ role: "user", content: [{ kind: "text", text: "What is 2+2?" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
  };

  test("panel runs non-streaming with tools stripped; judge sees every answer", async () => {
    const judgePrompts: string[] = [];
    const harnessed = harness({
      panel: ["p1", "p2"],
      judge: "judge",
      canonicalRequest: {
        ...baseRequest,
        stream: true,
        tools: [{ name: "calc", description: "calc", jsonSchema: {} }],
      },
      adapterDispatch: (req) => {
        if (req.model === "judge") {
          judgePrompts.push(
            req.messages.at(-1)!.content.map((p) => (p.kind === "text" ? p.text : "")).join(""),
          );
          return [{ type: "content_delta", sequence_number: 1, content: { kind: "text", text: "JUDGED" } }];
        }
        return [{ type: "content_delta", sequence_number: 1, content: { kind: "text", text: `ans-${req.model}` } }];
      },
    });

    const result = await dispatchFusionRequest({
      state: harnessed.state,
      deps: harnessed.deps,
      prepared: {
        authorization,
        plan: {
          revision: 1,
          candidates: [candidate("judge")],
          requested_model: "my-fusion",
          resolved_model: "my-fusion",
          provider_id: "judge",
          fusion: { panel: ["p1", "p2"], judge: "judge" },
        },
      } as unknown as PreparedProxyRequest,
      canonicalRequest: { ...baseRequest, stream: true, tools: [{ name: "calc", description: "calc", jsonSchema: {} }] },
      inboundHeaders: {},
      fusion: { panel: ["p1", "p2"], judge: "judge" },
    });

    // Panel calls: non-streaming, tools stripped.
    for (const req of harnessed.seenRequests.filter((r) => r.model !== "judge")) {
      expect(req.stream).toBe(false);
      expect(req.tools).toBeUndefined();
    }
    // The judge saw both panel answers.
    expect(judgePrompts).toHaveLength(1);
    expect(judgePrompts[0]).toContain("ans-p1");
    expect(judgePrompts[0]).toContain("ans-p2");
    // The final events are the judge's answer.
    expect(result.events.some((e) => e.type === "content_delta" && e.content.kind === "text" && e.content.text === "JUDGED")).toBe(true);
    // The judge — not a panel model — is the request's terminal provider.
    expect(harnessed.state.outcome?.providerId).toBe("judge");
    // Exactly one telemetry row: the judge's terminal attempt, not the panels'.
    expect(harnessed.telemetry).toHaveLength(1);
  });

  test("multimodal parts survive into every panel dispatch", async () => {
    const imageRequest: CanonicalRequest = {
      ...baseRequest,
      messages: [
        {
          role: "user",
          content: [
            { kind: "text", text: "describe" },
            { kind: "image", payload: { url: "https://img.example/x.png" } },
          ],
        },
      ],
    };
    const harnessed = harness({
      panel: ["p1", "p2"],
      judge: "p1",
      canonicalRequest: imageRequest,
      adapterDispatch: (req) => [
        { type: "content_delta", sequence_number: 1, content: { kind: "text", text: `ans-${req.model}` } },
      ],
    });
    await dispatchFusionRequest({
      state: harnessed.state,
      deps: harnessed.deps,
      prepared: {
        authorization,
        plan: {
          revision: 1,
          candidates: [candidate("p1")],
          requested_model: "my-fusion",
          resolved_model: "my-fusion",
          provider_id: "openai",
          fusion: { panel: ["p1", "p2"], judge: "p1" },
        },
      } as unknown as PreparedProxyRequest,
      canonicalRequest: imageRequest,
      inboundHeaders: {},
      fusion: { panel: ["p1", "p2"], judge: "p1" },
    });
    // Every dispatched request (panel and judge) kept the image part.
    for (const req of harnessed.seenRequests) {
      const hasImage = req.messages.some((m) => m.content.some((p) => p.kind === "image"));
      expect(hasImage).toBe(true);
    }
  });
});
