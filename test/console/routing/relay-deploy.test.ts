import { describe, expect, test } from "bun:test";
import {
  deployRelay,
  RELAY_WORKER_SOURCE,
  RELAY_DENO_SOURCE,
  isRelayTarget,
  RELAY_TARGETS,
} from "../../../src/console/routing/pools/relay-deploy";
import { GatewayError } from "../../../src/transport/gateway-error";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("relay worker source", () => {
  test("forwards via the x-relay-target contract the pool dispatcher speaks", () => {
    expect(RELAY_WORKER_SOURCE).toContain("x-relay-target");
    expect(RELAY_WORKER_SOURCE).toContain("x-relay-path");
    // The relay headers and host must not leak to the upstream.
    expect(RELAY_WORKER_SOURCE).toContain('headers.delete("x-relay-target")');
    expect(RELAY_WORKER_SOURCE).toContain('headers.delete("host")');
  });

  test("the Deno entry serves the same handler", () => {
    expect(RELAY_DENO_SOURCE).toContain("Deno.serve");
    expect(RELAY_DENO_SOURCE).toContain("handler.fetch");
  });
});

describe("isRelayTarget", () => {
  test("accepts exactly the declared targets", () => {
    for (const target of RELAY_TARGETS) expect(isRelayTarget(target)).toBe(true);
    expect(isRelayTarget("aws")).toBe(false);
    expect(isRelayTarget(1)).toBe(false);
  });
});

describe("deployRelay", () => {
  test("cloudflare: uploads the worker and returns its workers.dev URL", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.endsWith("/workers/subdomain")) return jsonResponse({ result: { subdomain: "acme" } });
      return jsonResponse({ success: true });
    }) as unknown as (url: string, init: RequestInit) => Promise<Response>;

    const result = await deployRelay(fetchImpl, {
      target: "cloudflare",
      token: "cf-token",
      accountId: "acct-1",
      projectName: "my-relay",
    });
    expect(result.relayUrl).toBe("https://my-relay.acme.workers.dev");
    expect(calls.some((u) => u.includes("/accounts/acct-1/workers/scripts/my-relay"))).toBe(true);
  });

  test("cloudflare without an account id is rejected", async () => {
    const fetchImpl = (async () => jsonResponse({})) as unknown as (url: string, init: RequestInit) => Promise<Response>;
    await expect(
      deployRelay(fetchImpl, { target: "cloudflare", token: "t" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("vercel: returns the deployment URL", async () => {
    const fetchImpl = (async () => jsonResponse({ url: "my-relay.vercel.app" })) as unknown as (
      url: string,
      init: RequestInit,
    ) => Promise<Response>;
    const result = await deployRelay(fetchImpl, { target: "vercel", token: "v", projectName: "my-relay" });
    expect(result.relayUrl).toBe("https://my-relay.vercel.app");
  });

  test("deno: returns the deployment URL", async () => {
    const fetchImpl = (async () => jsonResponse({ url: "https://my-relay.deno.dev" })) as unknown as (
      url: string,
      init: RequestInit,
    ) => Promise<Response>;
    const result = await deployRelay(fetchImpl, { target: "deno", token: "d", projectName: "my-relay" });
    expect(result.relayUrl).toBe("https://my-relay.deno.dev");
  });

  test("a provider error surfaces as a typed GatewayError with the upstream status", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ errors: [{ message: "bad token" }] }, 401)) as unknown as (
      url: string,
      init: RequestInit,
    ) => Promise<Response>;
    await expect(
      deployRelay(fetchImpl, { target: "cloudflare", token: "t", accountId: "a" }),
    ).rejects.toBeInstanceOf(GatewayError);
  });

  test("an empty token is rejected before any request", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as (url: string, init: RequestInit) => Promise<Response>;
    await expect(deployRelay(fetchImpl, { target: "vercel", token: "  " })).rejects.toMatchObject({
      status: 400,
    });
    expect(called).toBe(false);
  });
});
