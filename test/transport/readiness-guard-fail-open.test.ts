/**
 * The dependency readiness guard — fail-open on probe timeout.
 *
 * A probe that times out under load says nothing about the dependencies: it
 * could not get a backend in time, usually because the event loop is busy
 * rebuilding the route snapshot. The old behavior surfaced that as 503
 * `overloaded`, which turned a transient slow probe into a buyer-facing 503
 * storm on a host with ample headroom (6/10 localhost probes 503ing, ~48%
 * of nginx chat traffic 503 in the same window, while RSS sat at ~1.4 GiB
 * of a 15 GiB host). These lock the split: a timed-out probe lets the
 * request through, a hard dependency failure still 503s, and a ready
 * dependency stays inert.
 */
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createDependencyReadinessMiddleware } from "../../src/transport/guards/readiness-guard";
import { createErrorNormalizationMiddleware } from "../../src/transport/guards/error-lifecycle";
import type { ReadinessCheckResult } from "../../src/persistence/readiness";
import { ProxyRequestStateStore } from "../../src/transport/request/state";

function appWith(readiness: () => Promise<ReadinessCheckResult>) {
  const stateStore = new ProxyRequestStateStore(undefined);
  return new Elysia()
    .use(createErrorNormalizationMiddleware({ stateStore }))
    .use(createDependencyReadinessMiddleware({ readiness }))
    .post("/v1/chat/completions", () => new Response("gateway", { status: 200 }));
}

const notReady = (reason: string): ReadinessCheckResult => ({
  status: "not_ready",
  db: "disconnected",
  migrations: "pending",
  redis: "disconnected",
  reason,
});

describe("readiness guard — probe timeout fails open", () => {
  test("a timed-out database probe lets the request through", async () => {
    const response = await appWith(async () => notReady("database probe timed out")).handle(
      new Request("https://gateway.test/v1/chat/completions", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(200);
  });

  test("a timed-out migrations probe lets the request through", async () => {
    const response = await appWith(async () => notReady("migrations probe timed out")).handle(
      new Request("https://gateway.test/v1/chat/completions", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(200);
  });

  test("a hard dependency failure still 503s as platform_unavailable", async () => {
    const response = await appWith(async () => notReady("database not connected")).handle(
      new Request("https://gateway.test/v1/chat/completions", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("platform_unavailable");
  });

  test("a ready dependency stays inert", async () => {
    const response = await appWith(async () => ({
      status: "ready",
      db: "connected",
      migrations: "applied",
      redis: "connected",
    })).handle(
      new Request("https://gateway.test/v1/chat/completions", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(200);
  });
});
