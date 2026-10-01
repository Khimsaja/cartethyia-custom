import { describe, test, expect, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { getDb } from "../../../src/persistence/postgres";
import { dbDescribe } from "../../helpers/db-gate";
import { apiKeys, tenants } from "../../../src/persistence/schema";
import { hashSecret } from "../../../src/security/crypto";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";
import { createTransportPipeline } from "../../../src/transport/middleware/pipeline";
import { GatewayError } from "../../../src/transport/gateway-error";

import { getConsoleLogSnapshot, resetConsoleLogsForTests } from "../../../src/observability/log-ring";
import {
  readIngressBody,
} from "../../../src/transport/middleware/body-policy";
import {
  createApiKeyAuthenticationMiddleware,
  createConsoleMutationLimiterMiddleware,
} from "../../../src/transport/middleware/gateway-guards";
import {
  createErrorNormalizationMiddleware,
  registerTelemetryLifecycle,
} from "../../../src/transport/middleware/error-lifecycle";
import {
  createRequestContextMiddleware,
} from "../../../src/transport/middleware/request-context";

describe("context.test.ts", () => {
  function requestWithBody(body: ReadableStream<Uint8Array>): Request {
    return new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  describe("bounded ingress body reader", () => {
    test("reads chunked JSON once and preserves parsing semantics", async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"model":"gpt-test",'));
          controller.enqueue(new TextEncoder().encode('"stream":false}'));
          controller.close();
        },
      });

      await expect(readIngressBody(requestWithBody(body))).resolves.toEqual({
        model: "gpt-test",
        stream: false,
      });
    });

    test("cancels as soon as a chunk exceeds the remaining limit", async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('{"oversized":true}'));
        },
        cancel() {
          cancelled = true;
        },
      });

      await expect(readIngressBody(requestWithBody(body), { maxBodyBytes: 8 })).rejects.toMatchObject(
        {
          status: 413,
        },
      );
      expect(cancelled).toBe(true);
    });

    test("rejects overflow after earlier chunks without decoding the body", async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(6));
          controller.enqueue(new Uint8Array(3));
        },
        cancel() {
          cancelled = true;
        },
      });

      await expect(readIngressBody(requestWithBody(body), { maxBodyBytes: 8 })).rejects.toMatchObject(
        {
          status: 413,
        },
      );
      expect(cancelled).toBe(true);
    });

    test("recognizes Responses compact as a JSON ingress route", async () => {
      const request = new Request("http://localhost/v1/responses/compact", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      });
      await expect(readIngressBody(request)).rejects.toMatchObject({ status: 415 });
    });
  });
});

describe("createRequestContextMiddleware — /v1 scoping", () => {

  function buildContextApp(stateStore: ProxyRequestStateStore): Elysia {
    return new Elysia()
      .use(createRequestContextMiddleware({ stateStore }))
      .all("/*", () => ({ ok: true }));
  }

  test("initializes proxy state without counting before provider dispatch", async () => {
    const stateStore = new ProxyRequestStateStore();
    const app = buildContextApp(stateStore);
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST" });
    const response = await app.handle(req);
    expect(response.status).toBe(200);
    expect(stateStore.get(req)).toBeDefined();
    expect(stateStore.inFlightCount()).toBe(0);
  });

  test("skips proxy state for health, console, and static paths", async () => {
    const stateStore = new ProxyRequestStateStore();
    const app = buildContextApp(stateStore);
    for (const pathname of [
      "/health",
      "/metrics",
      "/console/api/usage/summary",
      "/console/usage",
      "/assets/app.js",
      "/",
    ]) {
      const req = new Request(`http://localhost${pathname}`);
      const response = await app.handle(req);
      expect(response.status).toBe(200);
      expect(stateStore.get(req)).toBeUndefined();
    }
    expect(stateStore.inFlightCount()).toBe(0);
  });

  /**
   * The lifecycle must be mounted at the ROOT, not on the `/v1` gateway
   * plugin. A plugin-scoped `afterResponse` only fires for a request that
   * matched a registered route, so an unregistered `/v1/*` path — the cheapest
   * request an abuser can send — was admitted by the root `request` hook and
   * never cleaned up. That lifecycle leak made the process-local request tracker
   * permanently one higher for the life of the process.
   *
   * This drives the real pipeline (not a hand-built app) because the defect
   * was precisely which app the lifecycle was registered on.
   */
  describe("in-flight accounting is symmetric for every /v1 path", () => {

    function buildPipelineApp(stateStore: ProxyRequestStateStore): Elysia {
      const pipeline = createTransportPipeline({
        db: {} as never,
        stateStore,
        surfaceRegistry: { detectOnce: () => ({ surface: "chat" }) } as never,
        adapters: new Map(),
        preparer: {} as never,
        readiness: async () => ({ migrations: "applied" }) as never,
        trustedProxyBoundary: { mode: "none" } as never,
        telemetry: { enqueue: () => undefined } as never,
      });
      const app = new Elysia();
      pipeline.mountRoot(app);
      app.use(
        pipeline.createGateway((routes) => {
          routes.post("/chat/completions", () => ({ ok: true }));
        }),
      );
      // Stands in for the root catch-all that answers an unmatched /v1 path.
      app.all("/*", ({ request }) => {
        const path = new URL(request.url).pathname;
        if (path === "/v1" || path.startsWith("/v1/"))
          return new Response(JSON.stringify({ error: { code: "not_found" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        return { ok: true };
      });
      return app;
    }

    test("an unmatched /v1 path releases its flight", async () => {
      const stateStore = new ProxyRequestStateStore();
      const app = buildPipelineApp(stateStore);
      for (const path of ["/v1/not-a-real-route", "/v1", "/v1/another-junk"]) {
        const response = await app.handle(new Request(`http://localhost${path}`, { method: "POST" }));
        expect(response.status).toBe(404);
        expect(stateStore.inFlightCount()).toBe(0);
        expect(stateStore.activeCount()).toBe(0);
      }
    });

    test("a burst of unmatched paths cannot inflate the gauge", async () => {
      const stateStore = new ProxyRequestStateStore();
      const app = buildPipelineApp(stateStore);
      for (let i = 0; i < 25; i += 1) {
        await app.handle(new Request(`http://localhost/v1/probe-${i}`, { method: "POST" }));
      }
      // The whole point: the gauge returns to zero instead of climbing.
      expect(stateStore.inFlightCount()).toBe(0);
      expect(stateStore.activeCount()).toBe(0);
    });

    test("a matched dispatch route still finalizes and releases", async () => {
      const stateStore = new ProxyRequestStateStore();
      const app = buildPipelineApp(stateStore);
      // The stage chain rejects an unauthenticated request before dispatch, so
      // the handler does not run — what matters is that the flight is released
      // rather than left behind by a route that *did* match.
      const response = await app.handle(
        new Request("http://localhost/v1/chat/completions", { method: "POST" }),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(stateStore.inFlightCount()).toBe(0);
      expect(stateStore.activeCount()).toBe(0);
    });
  });
});

dbDescribe("checks.test.ts", () => {
  /** Real end-to-end test of the `/v1/*` route-policy gate: builds an Elysia
   * app with the middleware installed, backed by real API-key rows in
   * Postgres, and drives requests through `app.handle()`. */
  function buildApp(stateStore: ProxyRequestStateStore): Elysia {
    const db = getDb();
    return new Elysia()
      .use(createErrorNormalizationMiddleware({ stateStore }))
      .use(createApiKeyAuthenticationMiddleware({ db, stateStore }))
      .all("/*", () => ({ ok: true }));
  }

  function requestFor(pathname: string, headers: Record<string, string> = {}): Request {
    return new Request(`http://localhost${pathname}`, { headers });
  }

  describe("createApiKeyAuthenticationMiddleware — routing:invoke enforcement", () => {
    const cleanupTenantIds: string[] = [];

    afterEach(async () => {
      const db = getDb();
      for (const tenantId of cleanupTenantIds.splice(0)) {
        await db.delete(apiKeys).where(eq(apiKeys.tenantId, tenantId));
        await db.delete(tenants).where(eq(tenants.id, tenantId));
      }
    });

    async function createTenantWithKey(
      scopes: readonly string[],
      clientRouterDenylist?: readonly string[],
    ): Promise<{ tenantId: string; token: string }> {
      const db = getDb();
      const [tenant] = await db
        .insert(tenants)
        .values({ name: `auth-mw-test-${crypto.randomUUID()}`, status: "active" })
        .returning();
      if (!tenant) throw new Error("failed to create test tenant");
      cleanupTenantIds.push(tenant.id);
      const token = `test-token-${crypto.randomUUID()}`;
      await db.insert(apiKeys).values({
        tenantId: tenant.id,
        keyHash: hashSecret(token),
        label: "auth middleware test key",
        scopes,
        ...(clientRouterDenylist === undefined
          ? {}
          : { clientRouterDenylist }),
      });
      return { tenantId: tenant.id, token };
    }

    /**
     * The per-key client-router denylist: a request whose fingerprint names a
     * refused router is rejected with 403 before routing, while the same key
     * still serves every other caller. Both directions matter — a check that
     * only ever denies would pass a deny-only test while breaking the key.
     */
    test("refuses a request whose fingerprint names a denied client router", async () => {
      const { token } = await createTenantWithKey(["routing:invoke"], ["9router"]);
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/chat/completions", {
        authorization: `Bearer ${token}`,
        "x-msh-platform": "9router",
      });
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(403);
      const body = (await response.json()) as {
        error?: { code?: string; message?: string; origin?: string };
      };
      expect(body.error?.code).toBe("client_router_denied");
      expect(body.error?.origin).toBe("cartethyia");
      // Public message is `code: explanatory`; never product-branded, never
      // names the matched router.
      expect(body.error?.message ?? "").toContain("No API invocation access for this client.");
      expect(body.error?.message ?? "").toStartWith("client_router_denied:");
      expect(body.error?.message ?? "").not.toInclude("Cartethyia");
    });

    test("refuses a bare Node User-Agent when the key denies the router", async () => {
      const { token } = await createTenantWithKey(["routing:invoke"], ["9router"]);
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/chat/completions", {
        authorization: `Bearer ${token}`,
        "user-agent": "node",
      });
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(403);
      const body = (await response.json()) as {
        error?: { code?: string; message?: string; origin?: string };
      };
      expect(body.error?.code).toBe("client_router_denied");
      expect(body.error?.message ?? "").toContain("No API invocation access for this client.");
    });

    test("serves the bare Node User-Agent through a key that does not list it", async () => {
      const { token } = await createTenantWithKey(["routing:invoke"], []);
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/chat/completions", {
        authorization: `Bearer ${token}`,
        "user-agent": "node",
      });
      stateStore.initialize(req, Date.now(), 30_000);
      expect((await app.handle(req)).status).toBe(200);
    });

    test("serves a versioned node library User-Agent when the router is denied", async () => {
      const { token } = await createTenantWithKey(["routing:invoke"], ["9router"]);
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/chat/completions", {
        authorization: `Bearer ${token}`,
        "user-agent": "node-fetch/1.0",
      });
      stateStore.initialize(req, Date.now(), 30_000);
      expect((await app.handle(req)).status).toBe(200);
    });

    test("serves the same key when the caller is not a denied router", async () => {
      const { token } = await createTenantWithKey(["routing:invoke"], ["9router"]);
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      // A genuine Claude Code caller: the routers imitate these headers, so this
      // must pass. A false positive here would refuse a paying customer.
      const req = requestFor("/v1/chat/completions", {
        authorization: `Bearer ${token}`,
        "user-agent": "claude-cli/2.1.0 (external, cli)",
        "x-anthropic-billing-header": "cc_version=2.1.0; cc_entrypoint=cli; cch=00000;",
      });
      stateStore.initialize(req, Date.now(), 30_000);
      expect((await app.handle(req)).status).toBe(200);
    });

    test("serves a denied router through a key that does not list it", async () => {
      const { token } = await createTenantWithKey(["routing:invoke"]);
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/chat/completions", {
        authorization: `Bearer ${token}`,
        "x-msh-platform": "9router",
      });
      stateStore.initialize(req, Date.now(), 30_000);
      expect((await app.handle(req)).status).toBe(200);
    });

    test("passes through non-/v1/ paths without requiring a credential", async () => {
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/console/api/whatever");
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(200);
    });

    // The restructure (B8) removed the per-route pre-auth 404: the single
    // gateway policy authenticates every /v1/* request first, so an unmapped
    // path without a credential is rejected as 401, not 404.
    test("rejects an unmapped /v1/ route by authenticating first (401 without credential)", async () => {
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/not-a-real-route");
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(401);
    });

    test("rejects a /v1/ request with no credential as 401", async () => {
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/chat/completions");
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(401);
    });

    test("does not bypass API-key authorization for Responses compact", async () => {
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/responses/compact");
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(401);
    });

    test("rejects an unknown/revoked bearer token as 401", async () => {
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/chat/completions", {
        authorization: "Bearer definitely-not-a-real-key",
      });
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(401);
    });

    test("rejects a valid key lacking routing:invoke scope as 403", async () => {
      const { token } = await createTenantWithKey(["dashboard:read"]);
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/chat/completions", { authorization: `Bearer ${token}` });
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(403);
    });

    test("admits a valid key with routing:invoke scope and populates state.authorization", async () => {
      const { tenantId, token } = await createTenantWithKey(["routing:invoke"]);
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/chat/completions", { authorization: `Bearer ${token}` });
      const state = stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(200);
      expect(state.authorization?.tenantId).toBe(tenantId);
      expect(state.authorization?.scopes).toContain("routing:invoke");
    });

    test("accepts credentials via x-api-key as an alternative to Authorization", async () => {
      const { token } = await createTenantWithKey(["routing:invoke"]);
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/messages", { "x-api-key": token });
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(200);
    });

    test("accepts the same key in Authorization and x-api-key", async () => {
      // An Anthropic-compatible client presents one key in both headers so a
      // gateway reading either one works. Rejecting the pair rejected the whole
      // client — every request from an Antigravity IDE install pointed at this
      // gateway through a DNS override failed with 400.
      const { token } = await createTenantWithKey(["routing:invoke"]);
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/messages", {
        authorization: `Bearer ${token}`,
        "x-api-key": token,
      });
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(200);
    });

    test("rejects two different credentials as 400", async () => {
      // Tolerating the pair must not mean tolerating a mismatch: picking one
      // would silently decide which identity the request runs as.
      const { token } = await createTenantWithKey(["routing:invoke"]);
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/messages", {
        authorization: `Bearer ${token}`,
        "x-api-key": `${token}-different`,
      });
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(400);
    });
  });
});

describe("security header middleware", () => {
  test("normalized error responses carry CSP and clickjacking headers", async () => {
    const stateStore = new ProxyRequestStateStore();
    const app = new Elysia()
      .use(createErrorNormalizationMiddleware({ stateStore }))
      .get("/boom", () => {
        throw new Error("boom");
      });
    const response = await app.handle(new Request("http://localhost/boom"));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: {
        code: "internal_error",
        message: "internal_error: Internal server error",
      },
    });
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("normalizes parse-stage input errors to 400 invalid_request", async () => {
    const stateStore = new ProxyRequestStateStore();
    const app = new Elysia()
      .use(createErrorNormalizationMiddleware({ stateStore }))
      .post("/v1/chat/completions", ({ request }) => {
        stateStore.initialize(request, Date.now(), 30_000);
        throw new Error("Chat request malformed content");
      });
    const response = await app.handle(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invalid: true }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "invalid_request",
        message: "invalid_request: Chat request malformed content",
      },
    });
  });
});

describe("retry-after emission on normalized errors", () => {
  function appWith(error: unknown) {
    return new Elysia()
      .use(createErrorNormalizationMiddleware({ stateStore: new ProxyRequestStateStore() }))
      .get("/boom", () => {
        throw error;
      });
  }

  test("publishes the upstream's own wait hint, not only on a literal 429", async () => {
    // A 503 `admission_unavailable` is retryable and can carry a measured wait;
    // the client used to receive no `retry-after` at all because the header was
    // gated on status === 429.
    const response = await appWith(
      new GatewayError("admission_unavailable", 503, "store unreachable", { retryAfterMs: 2500 }),
    ).handle(new Request("http://localhost/boom"));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("3");
  });

  test("converts an absolute retryAt into whole seconds", async () => {
    const retryAt = new Date(Date.now() + 7000).toISOString();
    const response = await appWith(
      new GatewayError("proxy_pool_capacity_exceeded", 429, "at capacity", { retryAt }),
    ).handle(new Request("http://localhost/boom"));
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(6);
    expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(7);
  });

  test("keeps the one-second floor for a 429 with no measured evidence", async () => {
    const response = await appWith(
      new GatewayError("quota_exceeded", 429, "slow down"),
    ).handle(new Request("http://localhost/boom"));
    expect(response.headers.get("retry-after")).toBe("1");
  });

  test("invents no header for a failure that carries no wait evidence", async () => {
    // A fabricated backoff is worse than none: the client would wait for a
    // number nobody measured.
    const response = await appWith(
      new GatewayError("platform_unavailable", 502, "upstream broke"),
    ).handle(new Request("http://localhost/boom"));
    expect(response.status).toBe(502);
    expect(response.headers.get("retry-after")).toBeNull();
  });
});

describe("console mutation limiter middleware", () => {
  function app() {
    return new Elysia()
      .use(createConsoleMutationLimiterMiddleware())
      .use(createErrorNormalizationMiddleware({ stateStore: new ProxyRequestStateStore() }))
      .post("/console/api/providers", () => ({ ok: true }))
      .get("/console/api/providers", () => ({ ok: true }));
  }

  function authed(method: string, session: string): Request {
    return new Request("http://localhost/console/api/providers", {
      method,
      headers: { cookie: `session_token=${session}` },
    });
  }

  test("allows a burst of 30 mutations then 429s with retry-after", async () => {
    const session = `limiter-test-${crypto.randomUUID()}`;
    const a = app();
    for (let i = 0; i < 240; i++) {
      const response = await a.handle(authed("POST", session));
      expect(response.status).toBe(200);
    }
    const limited = await a.handle(authed("POST", session));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("10");
  });

  test("tracks sessions independently and ignores safe methods", async () => {
    const a = app();
    const other = `limiter-other-${crypto.randomUUID()}`;
    for (let i = 0; i < 240; i++) {
      await a.handle(authed("POST", other));
    }
    // A different session still has budget.
    const fresh = `limiter-fresh-${crypto.randomUUID()}`;
    expect((await a.handle(authed("POST", fresh))).status).toBe(200);
    // Safe methods never consume budget.
    for (let i = 0; i < 6; i++) {
      expect((await a.handle(authed("GET", other))).status).toBe(200);
    }
    expect((await a.handle(authed("POST", other))).status).toBe(429);
  });

  test("mutations without a session pass through to downstream auth", async () => {
    const a = app();
    for (let i = 0; i < 6; i++) {
      const response = await a.handle(
        new Request("http://localhost/console/api/providers", { method: "POST" }),
      );
      expect(response.status).toBe(200);
    }
  });
});

describe("registerTelemetryLifecycle — in-flight release", () => {

  function captureHook(deps: {
    readonly stateStore: ProxyRequestStateStore;
    readonly enqueued: { count: number };
  }): (context: { request: Request }) => Promise<void> {
    let captured: ((context: { request: Request }) => Promise<void>) | undefined;
    const fakeApp = {
      afterResponse(handler: (context: { request: Request }) => Promise<void>) {
        captured = handler;
        return fakeApp;
      },
    };
    registerTelemetryLifecycle(fakeApp as never, {
      stateStore: deps.stateStore,
      telemetryBuffer: {
        enqueue: () => {
          deps.enqueued.count += 1;
        },
      } as never,
    });
    if (!captured) throw new Error("telemetry lifecycle hook was not registered");
    return captured;
  }

  function authorizedState(
    stateStore: ProxyRequestStateStore,
    request: Request,
  ): void {
    const state = stateStore.require(request);
    state.authorization = {
      id: "key",
      tenantId: "tenant",
      scopes: [],
      snapshot: { api_key_id: "key", tenant_id: "tenant" },
    } as never;
  }

  test("a completed non-stream request stays uncounted before dispatch and emits no second telemetry row", async () => {
    const stateStore = new ProxyRequestStateStore();
    const enqueued = { count: 0 };
    const hook = captureHook({ stateStore, enqueued });
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(req, Date.now(), 30_000);
    authorizedState(stateStore, req);
    // Terminal non-stream attempt: telemetry already finalized inside
    // completeAttempt, exactly like production dispatch.
    state.outcome = { status: "completed" };
    state.completed = true;
    expect(stateStore.inFlightCount()).toBe(0);
    await hook({ request: req });
    // The flight is gone (no leak) and no duplicate telemetry row was queued.
    expect(stateStore.inFlightCount()).toBe(0);
    expect(enqueued.count).toBe(0);
    expect(stateStore.get(req)).toBeUndefined();
  });

  test("an early rejection finalizes telemetry and releases its flight", async () => {
    const stateStore = new ProxyRequestStateStore();
    const enqueued = { count: 0 };
    const hook = captureHook({ stateStore, enqueued });
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST" });
    stateStore.initialize(req, Date.now(), 30_000);
    authorizedState(stateStore, req);
    await hook({ request: req });
    expect(enqueued.count).toBe(1);
    expect(stateStore.inFlightCount()).toBe(0);
  });

  test("a live stream stays uncounted until a provider dispatch is acquired", async () => {
    const stateStore = new ProxyRequestStateStore();
    const enqueued = { count: 0 };
    const hook = captureHook({ stateStore, enqueued });
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(req, Date.now(), 30_000);
    authorizedState(stateStore, req);
    state.streaming = true;
    await hook({ request: req });
    // The response lifecycle preserves active streams, but this test never
    // reaches provider dispatch, so no dispatch flight has started.
    expect(stateStore.inFlightCount()).toBe(0);
    expect(enqueued.count).toBe(0);
    state.cleanup();
  });

  test("a non-dispatching /v1 discovery route emits neither telemetry nor a lifecycle event", async () => {
    resetConsoleLogsForTests();
    const stateStore = new ProxyRequestStateStore();
    const enqueued = { count: 0 };
    const hook = captureHook({ stateStore, enqueued });
    const req = new Request("http://localhost/v1/models", { method: "GET" });
    stateStore.initialize(req, Date.now(), 30_000);
    authorizedState(stateStore, req);
    await hook({ request: req });
    // `/v1/models` never dispatches upstream, so it is not a proxy request:
    // no phantom failed row and no request lifecycle event.
    expect(enqueued.count).toBe(0);
    expect(getConsoleLogSnapshot().filter((line) => line.event !== undefined)).toHaveLength(0);
    expect(stateStore.inFlightCount()).toBe(0);
  });

  test("an early rejection records the client's real HTTP status, not a generic 500", async () => {
    resetConsoleLogsForTests();
    const stateStore = new ProxyRequestStateStore();
    const enqueued = { count: 0 };
    const hook = captureHook({ stateStore, enqueued });
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(req, Date.now(), 30_000);
    authorizedState(stateStore, req);
    // What the error-normalization middleware records for a 400 rejection.
    state.outcome = { status: "failed", errorCategory: "invalid_request", httpStatus: 400 };
    await hook({ request: req });
    expect(getConsoleLogSnapshot().at(-1)).toMatchObject({
      event: "request_error",
      status: 400,
      errorCode: "invalid_request",
    });
  });
});
