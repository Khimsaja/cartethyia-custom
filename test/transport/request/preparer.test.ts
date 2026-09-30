import { describe, expect, test } from "bun:test";

import { ProxyRequestPreparer } from "../../../src/transport/request/preparer";
import { GatewayError } from "../../../src/transport/gateway-error";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";
import type { RouteCandidate, RoutePlan } from "../../../src/transport/routing/route-model";
import type { ResolvedApiKey } from "../../../src/security/api-key-auth";

const authorization: ResolvedApiKey = {
  id: "key-tenant-a",
  tenantId: "tenant-a",
  scopes: ["routing:invoke"],
  snapshot: {
    api_key_id: "key-tenant-a",
    tenant_id: "tenant-a",
  },
};

/**
 * The admission estimate is derived from content that carries no `text` field:
 * a tool result, a document and an image. A text-only walk priced all three at
 * zero, so a request whose weight was mostly a pasted document could be
 * admitted while its true usage was far above the reserve.
 */
function preparerForEstimate(): ProxyRequestPreparer {
  return new ProxyRequestPreparer({
    snapshotService: { getSnapshot: async () => ({ revision: 1 }) } as never,
    routingEngine: {
      plan: async () =>
        ({
          revision: 1,
          requested_model: "gpt-4o",
          resolved_model: "openai/gpt-4o",
          provider_id: "openai",
          candidates: [
            {
              provider_id: "openai",
              model_id: "gpt-4o",
              wire_family: "chat",
              endpoint: "/v1/chat/completions",
              capability_profile: { image: true, document: true, tools: true },
            },
          ],
        }) as RoutePlan,
    } as never,
    admissionService: {} as never,
  });
}

const codexRouteCandidate: RouteCandidate = {
  provider_id: "codex",
  model_id: "gpt-5.6-sol",
  wire_family: "responses",
  endpoint: "/backend-api/codex/responses",
  provider_account_id: "tenant-a-codex-account",
  capability_profile: {},
};

const nonCodexRouteCandidate: RouteCandidate = {
  ...codexRouteCandidate,
  provider_id: "openai",
  provider_account_id: "other-provider-account",
};

describe("native compact routing preparation", () => {
  test("uses the tenant routing plan's Codex account candidates without touching the native body", async () => {
    let plannedTenant: string | null | undefined;
    const plan: RoutePlan = {
      revision: 1,
      requested_model: "gpt-5.6-sol",
      resolved_model: "gpt-5.6-sol",
      provider_id: "codex",
      candidates: [codexRouteCandidate, nonCodexRouteCandidate],
    };
    const preparer = new ProxyRequestPreparer({
      snapshotService: {
        getSnapshot: async () => ({ revision: 1 }),
      } as never,
      routingEngine: {
        plan: async (_model: string, _snapshot: unknown, tenantId?: string | null) => {
          plannedTenant = tenantId;
          return plan;
        },
      } as never,
      admissionService: {} as never,
    });

    const prepared = await preparer.prepareNativeCompact({
      model: "gpt-5.6-sol",
      authorization,
    });

    expect(plannedTenant).toBe("tenant-a");
    expect(prepared.candidates).toEqual([codexRouteCandidate]);
    expect(prepared.candidates[0]?.provider_account_id).toBe("tenant-a-codex-account");
  });

  test("the admission estimate counts tool results, documents and images", async () => {
    const prepared = await preparerForEstimate().prepare({
      canonicalRequest: {
        model: "gpt-4o",
        messages: [
          { role: "user", content: [{ kind: "text", text: "look at this" }] },
          // The call must precede the result, or the incomplete-round repair
          // drops the orphan result before the estimate ever runs.
          {
            role: "assistant",
            content: [{ kind: "toolCall", call_id: "c1", name: "read", arguments: { path: "a" } }],
          },
          {
            role: "tool",
            content: [
              { kind: "toolResult", call_id: "c1", content: "x".repeat(4_000) },
              { kind: "document", data: "b64", media_type: "application/pdf", title: "spec" },
              { kind: "image", payload: "b64" },
            ],
          },
        ],
        generation_controls: {},
        stream: false,
        source_surface: "chat",
      },
      authorization,
      deadlineMs: 60_000,
    });

    // 4_000 chars of tool result alone is ~1_000 tokens; the text-only walk
    // returned 4 for the same request.
    expect(prepared.estimatedInputTokens).toBeGreaterThan(1_000);
  });

  test("rejects a tenant route that has no eligible Codex account candidate", async () => {
    const preparer = new ProxyRequestPreparer({
      snapshotService: { getSnapshot: async () => ({ revision: 1 }) } as never,
      routingEngine: {
        plan: async () => ({
          revision: 1,
          requested_model: "gpt-5.6-sol",
          resolved_model: "gpt-5.6-sol",
          provider_id: "openai",
          candidates: [nonCodexRouteCandidate],
        }),
      } as never,
      admissionService: {} as never,
    });

    expect(preparer.prepareNativeCompact({ model: "gpt-5.6-sol", authorization })).rejects.toMatchObject({
      code: "capability_unsupported",
      status: 400,
    });
  });

});

describe("canonical request preparation", () => {
  test("rejects a model the key is not allowed to use before route planning", async () => {
    const preparer = new ProxyRequestPreparer({
      snapshotService: { getSnapshot: async () => ({ revision: 1 }) } as never,
      routingEngine: { plan: async () => { throw new Error("must not plan"); } } as never,
      admissionService: {} as never,
    });
    expect(
      preparer.prepare({
        canonicalRequest: {
          model: "gpt-5.6-sol",
          messages: [],
          generation_controls: {},
          stream: false,
          source_surface: "chat",
        },
        authorization: {
          ...authorization,
          snapshot: { ...authorization.snapshot, model_allowlist: ["gpt-4o"] },
        },
        deadlineMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: "model_not_found", status: 404 });
  });

  test("CLI remapping admits a target outside the allowlist for routing:cli_mapping keys", async () => {
    const keyId = "key-tenant-a";
    const tenantId = "tenant-a";
    const preparer = new ProxyRequestPreparer({
      snapshotService: {
        getSnapshot: async () => ({
          revision: 1,
          candidates: [
            {
              provider_id: "workbuddy",
              model_id: "deepseek-v4.1-flash",
              wire_family: "chat",
              endpoint: "/v2/chat/completions",
              capability_profile: {},
            },
          ],
          aliases: {},
          cli_aliases: {
            [`${tenantId}:${keyId}`]: { opus: "workbuddy/deepseek-v4.1-flash" },
          },
          combos: {},
        }),
      } as never,
      routingEngine: {
        plan: async () =>
          ({
            revision: 1,
            requested_model: "claude-opus-5-5[1m]",
            resolved_model: "workbuddy/deepseek-v4.1-flash",
            provider_id: "workbuddy",
            candidates: [
              {
                provider_id: "workbuddy",
                model_id: "deepseek-v4.1-flash",
                wire_family: "chat",
                endpoint: "/v2/chat/completions",
                capability_profile: {},
              },
            ],
          }) as RoutePlan,
      } as never,
      admissionService: {} as never,
    });
    const result = await preparer.prepare({
      canonicalRequest: {
        model: "claude-opus-5-5[1m]",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        generation_controls: {},
        stream: false,
        source_surface: "messages",
      },
      authorization: {
        ...authorization,
        id: keyId,
        tenantId,
        scopes: ["routing:invoke", "routing:cli_mapping"],
        snapshot: {
          ...authorization.snapshot,
          model_allowlist: ["gpt-4o"],
          scopes: ["routing:cli_mapping"],
        },
      },
      deadlineMs: 60_000,
      clientUserAgent: "claude-cli/2.1.280 (external, cli)",
    });
    expect(result.plan.resolved_model).toBe("workbuddy/deepseek-v4.1-flash");
  });

  test("CLI remapping stays off for non-Claude User-Agents even with routing:cli_mapping", async () => {
    const keyId = "key-tenant-a";
    const tenantId = "tenant-a";
    let plannedWithCli = false;
    const preparer = new ProxyRequestPreparer({
      snapshotService: {
        getSnapshot: async () => ({
          revision: 1,
          candidates: [
            {
              provider_id: "workbuddy",
              model_id: "deepseek-v4.1-flash",
              wire_family: "chat",
              endpoint: "/v2/chat/completions",
              capability_profile: {},
            },
            {
              provider_id: "anthropic",
              model_id: "claude-opus-4",
              wire_family: "messages",
              endpoint: "/v1/messages",
              capability_profile: {},
            },
          ],
          aliases: {
            [tenantId]: { opus: "anthropic/claude-opus-4" },
          },
          cli_aliases: {
            [`${tenantId}:${keyId}`]: { opus: "workbuddy/deepseek-v4.1-flash" },
          },
          combos: {},
        }),
      } as never,
      routingEngine: {
        plan: async (
          _model: string,
          _snapshot: unknown,
          _tenantId: string,
          _required: unknown,
          allowCliMappings?: boolean,
        ) => {
          plannedWithCli = allowCliMappings === true;
          return {
            revision: 1,
            requested_model: "opus",
            resolved_model: "anthropic/claude-opus-4",
            provider_id: "anthropic",
            candidates: [
              {
                provider_id: "anthropic",
                model_id: "claude-opus-4",
                wire_family: "messages",
                endpoint: "/v1/messages",
                capability_profile: {},
              },
            ],
          } as RoutePlan;
        },
      } as never,
      admissionService: {} as never,
    });
    // Same key + mapping as Claude, but Codex UA must not consume the Claude
    // remap — otherwise `opus` can never reach the real Anthropic alias.
    const result = await preparer.prepare({
      canonicalRequest: {
        model: "opus",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        generation_controls: {},
        stream: false,
        source_surface: "chat",
      },
      authorization: {
        ...authorization,
        id: keyId,
        tenantId,
        scopes: ["routing:invoke", "routing:cli_mapping"],
        snapshot: {
          ...authorization.snapshot,
          model_allowlist: ["opus", "anthropic/claude-opus-4", "workbuddy/deepseek-v4.1-flash"],
          scopes: ["routing:cli_mapping"],
        },
      },
      deadlineMs: 60_000,
      clientUserAgent: "codex_cli_rs/0.155.1",
    });
    expect(plannedWithCli).toBe(false);
    expect(result.plan.resolved_model).toBe("anthropic/claude-opus-4");
  });

  test("CLI remapping rejects outside-allowlist targets when User-Agent is missing", async () => {
    const keyId = "key-tenant-a";
    const tenantId = "tenant-a";
    const preparer = new ProxyRequestPreparer({
      snapshotService: {
        getSnapshot: async () => ({
          revision: 1,
          candidates: [
            {
              provider_id: "workbuddy",
              model_id: "deepseek-v4.1-flash",
              wire_family: "chat",
              endpoint: "/v2/chat/completions",
              capability_profile: {},
            },
          ],
          aliases: {},
          cli_aliases: {
            [`${tenantId}:${keyId}`]: { opus: "workbuddy/deepseek-v4.1-flash" },
          },
          combos: {},
        }),
      } as never,
      routingEngine: {
        plan: async () => {
          throw new Error("plan must not run when remapping is gated off");
        },
      } as never,
      admissionService: {} as never,
    });
    await expect(
      preparer.prepare({
        canonicalRequest: {
          model: "opus",
          messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
          generation_controls: {},
          stream: false,
          source_surface: "messages",
        },
        authorization: {
          ...authorization,
          id: keyId,
          tenantId,
          scopes: ["routing:invoke", "routing:cli_mapping"],
          snapshot: {
            ...authorization.snapshot,
            // DeepSeek is the remap target; without UA the request stays `opus`
            // and must not launder through the remapping allowlist grant.
            model_allowlist: ["workbuddy/deepseek-v4.1-flash"],
            scopes: ["routing:cli_mapping"],
          },
        },
        deadlineMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: "model_not_found", status: 404 });
  });

  test("degrades an unsupported extension content part and re-plans rather than failing", async () => {
    const plannedRequired: string[][] = [];
    const preparer = new ProxyRequestPreparer({
      snapshotService: { getSnapshot: async () => ({ revision: 1 }) } as never,
      routingEngine: {
        plan: async (
          _model: string,
          _snapshot: unknown,
          _tenantId: string,
          required: readonly string[],
        ): Promise<RoutePlan> => {
          plannedRequired.push([...required]);
          // A route that cannot serve the extension part: the preparer must
          // retry with the degraded variant instead of failing the request.
          if (required.some((capability) => capability.startsWith("extension:")))
            throw new GatewayError(
              "capability_unsupported",
              400,
              "no eligible route supports this request's capabilities",
            );
          return { candidates: [codexRouteCandidate] } as never;
        },
      } as never,
      admissionService: {} as never,
    });
    const result = await preparer.prepare({
      canonicalRequest: {
        model: "gpt-5.6-sol",
        messages: [
          {
            role: "user",
            content: [
              { kind: "text", text: "hello" },
              { kind: "extension", name: "server_tool_use", payload: { id: "srv-1" } },
            ],
          },
        ],
        generation_controls: {},
        stream: false,
        source_surface: "messages",
      },
      authorization,
      deadlineMs: 60_000,
    });
    // The full requirement is planned first; only the degraded variant plans.
    expect(plannedRequired[0]).toContain("extension:server_tool_use");
    expect(plannedRequired[1]).not.toContain("extension:server_tool_use");
    expect(result.degradedCapabilities).toEqual(["extension:server_tool_use"]);
    // The unsupported part is stripped; the sibling text part survives.
    const content = result.canonicalRequest.messages[0]?.content ?? [];
    expect(content.some((part) => part.kind === "extension")).toBe(false);
    expect(content).toContainEqual({ kind: "text", text: "hello" });
  });

  test("applies the caller omit flag before planning, even when the route supports encrypted reasoning", async () => {
    const plannedRequired: string[][] = [];
    const preparer = new ProxyRequestPreparer({
      snapshotService: { getSnapshot: async () => ({ revision: 1 }) } as never,
      routingEngine: {
        plan: async (
          _model: string,
          _snapshot: unknown,
          _tenantId: string,
          required: readonly string[],
        ): Promise<RoutePlan> => {
          plannedRequired.push([...required]);
          return { candidates: [codexRouteCandidate] } as never;
        },
      } as never,
      admissionService: {} as never,
    });
    const result = await preparer.prepare({
      canonicalRequest: {
        model: "gpt-5.6-sol",
        messages: [
          {
            role: "user",
            content: [
              { kind: "reasoning", payload: null, encrypted_content: "opaque-blob", summary: "prior thought" },
            ],
          },
        ],
        generation_controls: { "extension:omit_encrypted_reasoning": true },
        stream: false,
        source_surface: "responses",
      },
      authorization,
      deadlineMs: 60_000,
    });
    // One plan only, and it never required the encrypted capability: the strip
    // happened up front, not as a capability fallback.
    expect(plannedRequired).toHaveLength(1);
    expect(plannedRequired[0]).not.toContain("reasoning.encrypted_content");
    expect(result.degradedCapabilities).toEqual(["reasoning.encrypted_content"]);
    const content = result.canonicalRequest.messages[0]?.content ?? [];
    expect(content.some((part) => part.kind === "reasoning" && "encrypted_content" in part)).toBe(false);
  });

  test("projects against the chosen candidate, not the intersection of the fallback list", async () => {
    // The regression this test exists for: the chosen candidate is a `chat`
    // wire, which supports `stop`, while a later fallback in the same plan is a
    // `responses` wire, which does not. Projecting against the intersection of
    // every candidate rejected the request with `capability_unsupported` for a
    // control its own winning route can express — a universal router must send
    // the request, not fail it because some other candidate is less capable.
    //
    // The fallback MUST be a different wire family for this to discriminate:
    // with two `responses` candidates the intersection equals the chosen
    // candidate's capabilities and any projection passes.
    const chatCandidate: RouteCandidate = {
      ...codexRouteCandidate,
      provider_id: "acme",
      wire_family: "chat",
      endpoint: "/v1/chat/completions",
      provider_account_id: "chosen-account",
    };
    const responsesFallback: RouteCandidate = {
      ...codexRouteCandidate,
      provider_id: "openai",
      wire_family: "responses",
      provider_account_id: "fallback-account",
    };
    const preparer = new ProxyRequestPreparer({
      snapshotService: { getSnapshot: async () => ({ revision: 1 }) } as never,
      routingEngine: {
        plan: async (): Promise<RoutePlan> =>
          ({ candidates: [chatCandidate, responsesFallback] }) as never,
      } as never,
      admissionService: {} as never,
    });
    const result = await preparer.prepare({
      canonicalRequest: {
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
        // `stop` is in the `chat` wire's generation-control set and absent from
        // `responses`, so only the chosen candidate can express it.
        generation_controls: { stop: ["END"] },
        stream: false,
        source_surface: "chat",
      },
      authorization,
      deadlineMs: 60_000,
    });
    expect(result.candidate.provider_id).toBe("acme");
    expect(result.canonicalRequest.generation_controls.stop).toEqual(["END"]);
  });
});

describe("thinking suffix on the model name", () => {
  /** A plan whose single candidate carries the requested model through. */
  function suffixPreparer(seen: { model?: string } = {}): ProxyRequestPreparer {
    return new ProxyRequestPreparer({
      snapshotService: { getSnapshot: async () => ({ revision: 1 }) } as never,
      routingEngine: {
        plan: async (requested: string) => {
          seen.model = requested;
          return {
            revision: 1,
            requested_model: requested,
            resolved_model: requested,
            provider_id: "openai",
            candidates: [
              {
                provider_id: "openai",
                model_id: requested,
                wire_family: "chat",
                endpoint: "/v1/chat/completions",
                // `reasoning: true` so a request carrying a thinking intent
                // projects cleanly; without it the router correctly refuses a
                // reasoning request against a reasoning-less route.
                capability_profile: { reasoning: true },
              },
            ],
          } as RoutePlan;
        },
      } as never,
      admissionService: {} as never,
    });
  }

  function chatRequest(model: string, reasoning?: CanonicalRequest["reasoning"]): CanonicalRequest {
    return {
      model,
      messages: [],
      generation_controls: {},
      stream: false,
      source_surface: "chat",
      ...(reasoning === undefined ? {} : { reasoning }),
    };
  }

  test("strips the suffix from the model the router and allowlist see", async () => {
    const seen: { model?: string } = {};
    const preparer = suffixPreparer(seen);
    const prepared = await preparer.prepare({
      canonicalRequest: chatRequest("gpt-4o(high)"),
      authorization: {
        ...authorization,
        snapshot: { ...authorization.snapshot, model_allowlist: ["gpt-4o"] },
      },
      deadlineMs: 60_000,
    });
    // The allowlist contains the bare id, so a name carrying `(high)` would
    // have been rejected here. That it was not is the point of the test.
    expect(prepared.canonicalRequest.model).toBe("gpt-4o");
    expect(seen.model).toBe("gpt-4o");
    expect(prepared.canonicalRequest.reasoning?.effort).toBe("high");
  });

  test("carries the level through to the prepared request", async () => {
    const preparer = suffixPreparer();
    const prepared = await preparer.prepare({
      canonicalRequest: chatRequest("gpt-4o(128000)"),
      authorization: { ...authorization, snapshot: { ...authorization.snapshot, model_allowlist: ["gpt-4o"] } },
      deadlineMs: 60_000,
    });
    // A numeric budget is normalized to a tier before it reaches the wire.
    expect(prepared.canonicalRequest.reasoning?.effort).toBe("max");
  });

  test("overrides an effort the body already carried", async () => {
    const preparer = suffixPreparer();
    const prepared = await preparer.prepare({
      canonicalRequest: chatRequest("gpt-4o(low)", { effort: "max" }),
      authorization: { ...authorization, snapshot: { ...authorization.snapshot, model_allowlist: ["gpt-4o"] } },
      deadlineMs: 60_000,
    });
    expect(prepared.canonicalRequest.reasoning?.effort).toBe("low");
  });

  test("leaves a model without a suffix and without reasoning untouched", async () => {
    const preparer = suffixPreparer();
    const prepared = await preparer.prepare({
      canonicalRequest: chatRequest("gpt-4o"),
      authorization: { ...authorization, snapshot: { ...authorization.snapshot, model_allowlist: ["gpt-4o"] } },
      deadlineMs: 60_000,
    });
    expect(prepared.canonicalRequest.model).toBe("gpt-4o");
    expect(prepared.canonicalRequest.reasoning).toBeUndefined();
  });

  test("an unrecognized suffix does not rescue a disallowed model", async () => {
    // The suffix is ignored, so the full name — parentheses and all — is what
    // the allowlist sees, and it correctly rejects it.
    const preparer = suffixPreparer();
    expect(
      preparer.prepare({
        canonicalRequest: chatRequest("gpt-4o(bogus)"),
        authorization: {
          ...authorization,
          snapshot: { ...authorization.snapshot, model_allowlist: ["gpt-4o"] },
        },
        deadlineMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: "model_not_found", status: 404 });
  });
});
