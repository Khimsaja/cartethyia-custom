/**
 * Routed web-search fallback for chat clients.
 *
 * Declaring a hosted `web_search` tool does not affect chat routing. Only an
 * actual model function call can dispatch a configured fallback provider.
 *
 * These are the three contracts that matter to a client and are each easy to
 * break in the wrong direction:
 *
 * - search providers stay outside chat route planning;
 * - an actual model function call can use a configured fallback provider;
 * - a configured provider that fails advances to the next configured one, and
 *   an exhausted fallback never fails the chat turn.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestGateway, type TestGateway } from "../helpers/gateway";
import { createAccount, createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe, getTestPool } from "../helpers/database";
import { RoutingEngine } from "../../src/transport/routing/router";
import { GatewayError } from "../../src/protocol/gateway-error";
import type { CanonicalEvent, CanonicalRequest } from "../../src/protocol/canonical-model";
import { isWebSearchTool, isWebSearchToolName } from "../../src/transport/translation/search";
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

/** A Messages request declaring a gateway-executable search function. */
function messagesFunctionSearchRequest(model: string, stream = false): Record<string, unknown> {
  return {
    model,
    max_tokens: 1024,
    stream,
    tools: [{ name: "web_search", input_schema: { type: "object", properties: { query: { type: "string" } } } }],
    messages: [{ role: "user", content: "Coba cari siapa itu risuncode" }],
  };
}

function functionSearchEvents(request: CanonicalRequest, answer: string): readonly CanonicalEvent[] {
  if (request.tools?.some((tool) => tool.name === "web_search")) {
    return [
      { type: "message_start", sequence_number: 0, model: request.model },
      {
        type: "tool_call_delta",
        sequence_number: 1,
        call_id: "model_search",
        name: "web_search",
        arguments_delta: JSON.stringify({ query: "siapa itu risuncode" }),
      },
      { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "tool_use" },
    ];
  }
  return [
    { type: "message_start", sequence_number: 0, model: request.model },
    { type: "content_delta", sequence_number: 1, content: { kind: "text", text: answer } },
    { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "stop" },
  ];
}

/** A previous assistant tool call in history; it should not be re-executed. */
function messagesSearchInvocationRequest(model: string): Record<string, unknown> {
  return {
    ...messagesSearchRequest(model),
    messages: [
      { role: "user", content: "Coba cari siapa itu risuncode" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_search", name: "web_search", input: { query: "siapa itu risuncode" } },
        ],
      },
    ],
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

describe("RoutingEngine chat planning and model-requested search", () => {
  const engine = new RoutingEngine();

  test("chat route planning ignores search capability and search providers", async () => {
    const capable = candidate({
      provider_id: "claude",
      model_id: "claude-opus-5",
      capability_profile: { tools: true, webSearch: true },
    });
    const fallback = candidate({
      provider_id: "exa",
      model_id: "exa",
      service_kind: "websearch",
      capability_profile: { webSearch: true },
    });
    const plan = await engine.plan("claude/claude-opus-5", snapshot([capable, fallback]));
    expect(plan.candidates.map((item) => item.provider_id)).toEqual(["claude"]);
  });

  test("fallback providers are resolved separately for model-requested search", () => {
    const exa = candidate({
      provider_id: "exa",
      model_id: "exa",
      service_kind: "websearch",
      capability_profile: { webSearch: true },
    });
    expect(engine.webSearchFallbackCandidates(snapshot([exa]), null).map((item) => item.provider_id))
      .toEqual(["exa"]);
  });
});

dbDescribe("web-search fallback dispatch", () => {
  let gateway: TestGateway;
  let world: GatewayWorld;
  /**
   * Real account rows owned by the search providers themselves. The fallback
   * bridge resolves a candidate's credential from the database, and the cache
   * keys by provider+account: a candidate cannot borrow another provider's
   * account id (production's route catalog never emits one), so the fixture
   * gives each search provider its own account.
   */
  let exaAccountId: string;
  let codexAccountId: string;

  beforeAll(async () => {
    world = await createWorld();
    gateway = await createTestGateway();
    const pool = await getTestPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const label = `websearch-${world.runId}`;
      exaAccountId = await createAccount(client, "exa", { label });
      codexAccountId = await createAccount(client, "codex", { label });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await gateway?.close();
    // The search-provider accounts are global rows (tenantless, like the
    // bundled providers they belong to), so they are removed by label rather
    // than by the world's tenant cascade.
    if (world) {
      const teardown = await getTestPool();
      await teardown
        .query("delete from provider_accounts where label = $1", [`websearch-${world.runId}`])
        .catch(() => undefined);
    }
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
        modelId: "exa",
        accountId: exaAccountId,
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

  test("a hosted tool declaration alone does not search", async () => {
    routesWithSearchProvider();
    gateway.adapter(world.providerId, {
      events: (request): readonly CanonicalEvent[] => [
        { type: "message_start", sequence_number: 0, model: request.model },
        { type: "content_delta", sequence_number: 1, content: { kind: "text", text: "loveuuu!" } },
        { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "stop" },
      ],
    });
    const searchAdapter = gateway.adapter("exa", {
      searchResults: [{ title: "unexpected", url: "https://example.com/unexpected", snippet: "Unexpected" }],
    });
    const request = messagesSearchRequest(world.qualifiedModel);
    request.messages = [{ role: "user", content: "loveuuu!" }];
    const response = await gateway.json(
      "/v1/messages",
      request,
      { token: world.token },
    );
    expect(response.status).toBe(200);
    expect(searchAdapter.searches).toEqual([]);
    const body = (await response.json()) as { content: { type: string; text?: string }[] };
    expect(body.content.some((block) => block.text?.includes("loveuuu!"))).toBe(true);
  });

  test("a prior search tool call in history is not executed again", async () => {
    routesWithSearchProvider();
    const searchAdapter = gateway.adapter("exa", {
      searchResults: [
        { title: "risuncode", url: "https://example.com/risuncode", snippet: "Profile" },
      ],
    });
    const response = await gateway.json(
      "/v1/messages",
      messagesSearchInvocationRequest(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    expect(searchAdapter.searches).toEqual([]);
  });

  test("a streamed fallback echoes the search hits before the model answer", async () => {
    routesWithSearchProvider();
    gateway.adapter(world.providerId, {
      events: (request): readonly CanonicalEvent[] => functionSearchEvents(request, "answered from hits"),
    });
    gateway.adapter("exa", {
      searchResults: [
        { title: "risuncode", url: "https://example.com/risuncode", snippet: "Profile" },
      ],
    });
    const response = await gateway.json(
      "/v1/messages",
      messagesFunctionSearchRequest(world.qualifiedModel, true),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.indexOf("web_search_tool_result")).toBeGreaterThan(-1);
    expect(text.indexOf("https://example.com/risuncode")).toBeLessThan(text.indexOf("answered from hits"));
    expect(text).toContain("risuncode — https://example.com/risuncode");
  });

  test("a declared but unused search tool does not buffer the streamed answer", async () => {
    routesWithSearchProvider();
    let upstreamFinished = false;
    gateway.adapter(world.providerId, {
      streamEvents: async function* (request) {
        yield { type: "message_start", sequence_number: 0, model: request.model };
        await Bun.sleep(40);
        yield {
          type: "content_delta",
          sequence_number: 1,
          content: { kind: "text", text: "first streamed token" },
        };
        await Bun.sleep(40);
        yield { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "stop" };
        upstreamFinished = true;
      },
    });
    gateway.adapter("exa", {
      searchResults: [
        { title: "risuncode", url: "https://example.com/risuncode", snippet: "Profile" },
      ],
    });

    const response = await gateway.json(
      "/v1/messages",
      messagesFunctionSearchRequest(world.qualifiedModel, true),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    expect(upstreamFinished).toBe(false);
    const text = await response.text();
    expect(text).toContain("first streamed token");
    expect(upstreamFinished).toBe(true);
  });

  test("a search function call emitted by the model uses its own query", async () => {
    routesWithSearchProvider();
    gateway.adapter(world.providerId, {
      events: (request): readonly CanonicalEvent[] =>
        request.tools?.some((tool) => tool.name === "web_search")
          ? [
              { type: "message_start", sequence_number: 0, model: request.model },
              {
                type: "tool_call_delta",
                sequence_number: 1,
                call_id: "model_search",
                name: "web_search",
                arguments_delta: JSON.stringify({ query: "RisuCode GitHub profile" }),
              },
              { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "tool_use" },
            ]
          : [
              { type: "message_start", sequence_number: 0, model: request.model },
              {
                type: "content_delta",
                sequence_number: 1,
                content: { kind: "text", text: "answered from model-requested search" },
              },
              { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "stop" },
            ],
    });
    const searchAdapter = gateway.adapter("exa", {
      searchResults: [{ title: "RisuCode", url: "https://example.com/profile", snippet: "Profile" }],
    });
    const response = await gateway.json(
      "/v1/messages",
      { ...messagesSearchRequest(world.qualifiedModel), stream: true },
      { token: world.token },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(searchAdapter.searches).toEqual(["RisuCode GitHub profile"]);
    expect(text.indexOf("https://example.com/profile")).toBeLessThan(
      text.indexOf("answered from model-requested search"),
    );
  });

  test("a streamed Responses fallback keeps event sequence numbers increasing", async () => {
    routesWithSearchProvider();
    gateway.adapter(world.providerId, {
      events: (request): readonly CanonicalEvent[] =>
        request.tools?.some((tool) => tool.name === "web_search")
          ? [
              { type: "response_start", sequence_number: 1, model: request.model },
              {
                type: "tool_call_delta",
                sequence_number: 2,
                call_id: "call_search",
                name: "web_search",
                arguments_delta: JSON.stringify({ query: "siapa itu risuncode" }),
              },
              { type: "terminal", sequence_number: 3, state: "complete", stop_reason: "tool_use" },
            ]
          : [
              { type: "response_start", sequence_number: 1, model: request.model },
              {
                type: "content_delta",
                sequence_number: 2,
                content: { kind: "text", text: "answered from fallback hits" },
              },
              { type: "terminal", sequence_number: 3, state: "complete", stop_reason: "stop" },
            ],
    });
    gateway.adapter("exa", {
      searchResults: [{ title: "risuncode", url: "https://example.com/risuncode", snippet: "Profile" }],
    });
    const response = await gateway.json(
      "/v1/responses",
      {
        model: world.qualifiedModel,
        stream: true,
        tools: [{ type: "function", name: "web_search", parameters: { type: "object", properties: { query: { type: "string" } } } }],
        input: [{ role: "user", content: [{ type: "input_text", text: "Coba cari siapa itu risuncode" }] }],
      },
      { token: world.token },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: response.completed");
    expect(text).toContain("answered from fallback hits");
    expect(text).toContain("https://example.com/risuncode");
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
        modelId: "gpt-5.6-luna",
        accountId: codexAccountId,
        serviceKind: "websearch",
        capabilities: { webSearch: true },
      },
      {
        providerId: "exa",
        modelId: "exa",
        accountId: exaAccountId,
        serviceKind: "websearch",
        capabilities: { webSearch: true },
      },
    ]);
    gateway.adapter(world.providerId, {
      events: (request): readonly CanonicalEvent[] => functionSearchEvents(request, "answered"),
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
      messagesFunctionSearchRequest(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    expect(exa.searches).toEqual(["siapa itu risuncode"]);
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
        modelId: "exa",
        accountId: exaAccountId,
        serviceKind: "websearch",
        capabilities: { webSearch: true },
      },
    ]);
    gateway.adapter(world.providerId, {
      events: (request): readonly CanonicalEvent[] => functionSearchEvents(request, "no search needed"),
    });
    gateway.adapter("exa", {
      failSearchWith: () => new GatewayError("platform_unavailable", 502, "exa unreachable"),
    });
    const response = await gateway.json(
      "/v1/messages",
      messagesFunctionSearchRequest(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { content: { type: string; text?: string }[] };
    expect(body.content.length).toBeGreaterThan(0);
  });

  test("a native route that answers without searching is not searched on its behalf", async () => {
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: world.accountId,
        capabilities: { tools: true, webSearch: true },
      },
      {
        providerId: "exa",
        modelId: "exa",
        accountId: exaAccountId,
        serviceKind: "websearch",
        capabilities: { webSearch: true },
      },
    ]);
    // The route is marked native, so it is trusted first and may decide not to
    // search. The gateway must not treat the tool declaration as a search call.
    let attempts = 0;
    gateway.adapter(world.providerId, {
      events: (request): readonly CanonicalEvent[] => {
        attempts += 1;
        return [
          { type: "message_start", sequence_number: 0, model: request.model },
          {
            type: "content_delta",
            sequence_number: 1,
            content: { kind: "text", text: attempts === 1 ? "I have no browsing ability" : "risuncode is a developer" },
          },
          { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "stop" },
        ];
      },
    });
    const searchAdapter = gateway.adapter("exa", {
      searchResults: [{ title: "risuncode", url: "https://github.com/risunCode", snippet: "Profile" }],
    });
    const response = await gateway.json(
      "/v1/messages",
      messagesSearchRequest(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    expect(searchAdapter.searches).toEqual([]);
    expect(attempts).toBe(1);
    const body = (await response.json()) as { content: { type: string; text?: string }[] };
    expect(body.content.some((block) => block.text?.includes("I have no browsing ability"))).toBe(true);
  });

  test("a native route that really searched is not re-dispatched", async () => {
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: world.accountId,
        capabilities: { tools: true, webSearch: true },
      },
      {
        providerId: "exa",
        modelId: "exa",
        accountId: exaAccountId,
        serviceKind: "websearch",
        capabilities: { webSearch: true },
      },
    ]);
    let attempts = 0;
    gateway.adapter(world.providerId, {
      events: (request): readonly CanonicalEvent[] => {
        attempts += 1;
        return [
          { type: "message_start", sequence_number: 0, model: request.model },
          // An inline citation is search evidence: the upstream really looked.
          {
            type: "content_delta",
            sequence_number: 1,
            content: { kind: "text", text: "risuncode is at https://github.com/risunCode" },
          },
          { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "stop" },
        ];
      },
    });
    const searchAdapter = gateway.adapter("exa", {
      searchResults: [{ title: "risuncode", url: "https://github.com/risunCode", snippet: "Profile" }],
    });
    const response = await gateway.json(
      "/v1/messages",
      messagesSearchRequest(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    // Native search worked: no fallback, no second dispatch.
    expect(attempts).toBe(1);
    expect(searchAdapter.searches).toEqual([]);
  });
});

describe("web-search tool identity", () => {
  test("keeps a client-side WebSearch tool instead of consuming it", () => {
    // executes locally, with no hosted type marker. Treating it as hosted ran
    // the fallback bridge and stripped the declaration, so the upstream model
    // lost the tool and answered "I don't have a WebSearch tool".
    const clientSide = { name: "WebSearch", description: "Search the web" };
    const hosted = { name: "web_search", native_type: "web_search_20250305" };
    const wireHosted = { name: "anything", tool_type: "web_search" };

    expect(isWebSearchTool(clientSide as never)).toBe(false);
    expect(isWebSearchTool(hosted as never)).toBe(true);
    expect(isWebSearchTool(wireHosted as never)).toBe(true);
    expect(isWebSearchToolName("WebSearch")).toBe(true);
  });
});
