/**
 * Routed web-search fallback for chat clients.
 *
 * A client that declares a hosted `web_search` tool expects the selected route
 * to execute it. When that route can, it must keep doing so — the fallback is
 * not a shortcut around a working native search. When it cannot, the search is
 * served by a configured search provider and injected into the conversation, so
 * the selected model still writes the answer instead of reporting that it
 * cannot browse.
 *
 * These are the three contracts that matter to a client and are each easy to
 * break in the wrong direction:
 *
 * - a search-capable selected route stays first and keeps its native tool;
 * - an incapable selected route receives the configured provider's results,
 *   and the chat adapter still sees the selected route's model;
 * - a configured provider that fails advances to the next configured one, and
 *   an exhausted fallback never fails the chat turn.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestGateway, type TestGateway } from "../helpers/gateway";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe } from "../helpers/database";
import { RoutingEngine } from "../../src/transport/routing/router";
import { GatewayError } from "../../src/transport/gateway-error";
import type { CanonicalEvent, CanonicalRequest } from "../../src/transport/canonical-model";
import type { RouteCandidate, RouteSnapshot } from "../../src/transport/routing/route-model";

/** A Messages request that declares Anthropic's hosted web-search tool. */
function messagesSearchRequest(model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 1024,
    stream: false,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: "Coba cari siapa itu risuncode" }],
  };
}

/** A minimal chat candidate; only the fields routing reads are meaningful. */
function candidate(overrides: Record<string, unknown> = {}): RouteCandidate {
  return {
    provider_id: "p",
    model_id: "m",
    wire_family: "chat",
    endpoint: "/v1/chat/completions",
    capability_profile: { tools: true },
    ...overrides,
  } as RouteCandidate;
}

function snapshot(candidates: readonly RouteCandidate[]): RouteSnapshot {
  return { revision: 1, candidates, aliases: {}, combos: {}, created_at: Date.now() };
}

describe("RoutingEngine web-search planning", () => {
  const engine = new RoutingEngine();

  test("a search-capable selected route is marked native and stays first", async () => {
    const capable = candidate({
      provider_id: "claude",
      model_id: "claude-opus-5",
      capability_profile: { tools: true, webSearch: true },
    });
    const fallback = candidate({
      provider_id: "exa",
      model_id: "exa-search",
      service_kind: "websearch",
      capability_profile: { webSearch: true },
    });
    const plan = await engine.plan("claude/claude-opus-5", snapshot([capable, fallback]), null, [], false, undefined, true);
    expect(plan.candidates[0]?.provider_id).toBe("claude");
    expect(plan.candidates[0]?.search_route).toBe("native");
    expect(plan.candidates[1]?.search_route).toBe("fallback");
  });

  test("an incapable selected route stays first and gets configured fallbacks", async () => {
    const incapable = candidate({ provider_id: "p", model_id: "m", capability_profile: { tools: true } });
    const exa = candidate({
      provider_id: "exa",
      model_id: "exa-search",
      service_kind: "websearch",
      capability_profile: { webSearch: true },
    });
    const codex = candidate({
      provider_id: "codex",
      model_id: "codex-search",
      service_kind: "websearch",
      capability_profile: { webSearch: true },
    });
    const plan = await engine.plan("p/m", snapshot([incapable, codex, exa]), null, [], false, undefined, true);
    expect(plan.candidates[0]?.provider_id).toBe("p");
    expect(plan.candidates[0]?.search_route).toBeUndefined();
    expect(plan.candidates.slice(1).map((item) => item.provider_id)).toEqual(["exa", "codex"]);
  });

  test("no configured provider leaves the request on its original route", async () => {
    const incapable = candidate({ provider_id: "p", model_id: "m", capability_profile: { tools: true } });
    const plan = await engine.plan("p/m", snapshot([incapable]), null, [], false, undefined, true);
    expect(plan.candidates.map((item) => item.provider_id)).toEqual(["p"]);
  });
});

dbDescribe("web-search fallback dispatch", () => {
  let gateway: TestGateway;
  let world: GatewayWorld;

  beforeAll(async () => {
    world = await createWorld();
    gateway = await createTestGateway();
  });

  afterAll(async () => {
    await gateway?.close();
    await world?.cleanup();
  });

  /** Registers the selected route as search-incapable, plus a search provider. */
  function routesWithSearchProvider(
    overrides: { readonly capabilities?: Readonly<Record<string, boolean>> } = {},
  ): void {
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: world.accountId,
        capabilities: overrides.capabilities ?? { tools: true, webSearch: false },
      },
      {
        providerId: "exa",
        modelId: "exa-search",
        accountId: world.accountId,
        serviceKind: "websearch",
        capabilities: { webSearch: true },
      },
    ]);
  }

  test("a search-capable route keeps the native tool and is not rewritten", async () => {
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: world.accountId,
        capabilities: { tools: true, webSearch: true },
      },
    ]);
    let seen: CanonicalRequest | undefined;
    gateway.adapter(world.providerId, {
      onDispatch: (record) => {
        seen = record.request;
      },
    });
    const response = await gateway.json(
      "/v1/messages",
      messagesSearchRequest(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    expect(seen?.tools?.some((tool) => tool.name === "web_search")).toBe(true);
    expect(seen?.messages.length).toBe(1);
  });

  test("an incapable route answers from the configured search provider's results", async () => {
    routesWithSearchProvider();
    let seen: CanonicalRequest | undefined;
    gateway.adapter(world.providerId, {
      onDispatch: (record) => {
        seen = record.request;
      },
      events: (request): readonly CanonicalEvent[] => [
        { type: "message_start", sequence_number: 0, model: request.model },
        { type: "content_delta", sequence_number: 1, content: { kind: "text", text: "risuncode is a developer" } },
        { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "stop" },
      ],
    });
    const searchAdapter = gateway.adapter("exa", {
      searchResults: [
        { title: "risuncode", url: "https://example.com/risuncode", snippet: "Profile" },
      ],
    });
    const response = await gateway.json(
      "/v1/messages",
      messagesSearchRequest(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    // The search ran on the configured provider, with the caller's query.
    expect(searchAdapter.searches).toEqual(["Coba cari siapa itu risuncode"]);
    // The selected route still answers, now with the results in context. They
    // arrive as a plain user turn, not a replayed tool round: replaying a
    // `web_search` call taught the model to answer with raw tool-call syntax
    // instead of prose.
    expect(seen?.model).toBe(world.modelId);
    expect(seen?.tools === undefined || seen.tools.length === 0).toBe(true);
    const injectedTurn = seen?.messages.at(-1);
    expect(injectedTurn?.role).toBe("user");
    const injectedText = injectedTurn?.content.find((part) => part.kind === "text");
    expect(injectedText !== undefined).toBe(true);
    if (injectedText?.kind === "text") {
      expect(injectedText.text).toContain("https://example.com/risuncode");
    }
    // No synthetic assistant tool call is left in the transcript.
    expect(
      seen?.messages.some((message) =>
        message.content.some((part) => part.kind === "toolCall" || part.kind === "toolResult"),
      ),
    ).toBe(false);
    const body = (await response.json()) as { content: { type: string; text?: string }[] };
    expect(body.content.some((block) => block.text?.includes("risuncode is a developer"))).toBe(true);
  });

  test("a failing configured provider advances to the next configured one", async () => {
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: world.accountId,
        capabilities: { tools: true, webSearch: false },
      },
      {
        providerId: "codex",
        modelId: "codex-search",
        accountId: world.accountId,
        serviceKind: "websearch",
        capabilities: { webSearch: true },
      },
      {
        providerId: "exa",
        modelId: "exa-search",
        accountId: world.accountId,
        serviceKind: "websearch",
        capabilities: { webSearch: true },
      },
    ]);
    gateway.adapter(world.providerId, {
      events: (request): readonly CanonicalEvent[] => [
        { type: "message_start", sequence_number: 0, model: request.model },
        { type: "content_delta", sequence_number: 1, content: { kind: "text", text: "answered" } },
        { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "stop" },
      ],
    });
    gateway.adapter("codex", {
      failSearchWith: () =>
        new GatewayError("platform_unavailable", 502, "codex search unreachable"),
    });
    const exa = gateway.adapter("exa", {
      searchResults: [{ title: "exa hit", url: "https://example.com/exa", snippet: "Snippet" }],
    });
    const response = await gateway.json(
      "/v1/messages",
      messagesSearchRequest(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    expect(exa.searches).toEqual(["Coba cari siapa itu risuncode"]);
  });

  test("an exhausted fallback still completes the chat turn", async () => {
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: world.accountId,
        capabilities: { tools: true, webSearch: false },
      },
      {
        providerId: "exa",
        modelId: "exa-search",
        accountId: world.accountId,
        serviceKind: "websearch",
        capabilities: { webSearch: true },
      },
    ]);
    gateway.adapter(world.providerId, {
      events: (request): readonly CanonicalEvent[] => [
        { type: "message_start", sequence_number: 0, model: request.model },
        { type: "content_delta", sequence_number: 1, content: { kind: "text", text: "no search needed" } },
        { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "stop" },
      ],
    });
    gateway.adapter("exa", {
      failSearchWith: () => new GatewayError("platform_unavailable", 502, "exa unreachable"),
    });
    const response = await gateway.json(
      "/v1/messages",
      messagesSearchRequest(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { content: { type: string; text?: string }[] };
    expect(body.content.some((block) => block.text?.includes("no search needed"))).toBe(true);
  });
});
