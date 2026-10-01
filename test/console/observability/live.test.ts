import { describe, expect, test } from "bun:test";
import { createLiveRoutes } from "../../../src/console/observability/live";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";
import { NetworkPoolSelector } from "../../../src/network/pool/selector";
import {
  recordPoolBytes,
  resetPoolByteAccounting,
} from "../../../src/network/pool/byte-accounting";
import type { AccessDecision } from "../../../src/security/access-control";

const readerAccess: AccessDecision = {
  id: "test-session",
  tenantId: "tenant-1",
  scopes: ["dashboard:read"],
  admissionIdentity: "test-session",
};

function appWith(
  access: AccessDecision | undefined,
  selector?: NetworkPoolSelector,
  stateStore?: ProxyRequestStateStore,
) {
  return createLiveRoutes({
    accessResolver: () => access,
    ...(selector ? { poolSelector: selector } : {}),
    ...(stateStore ? { stateStore } : {}),
  });
}

/** Starts a tracked flight on a fresh store, returning the store. */
function storeWithFlights(...ips: readonly string[]): ProxyRequestStateStore {
  const store = new ProxyRequestStateStore();
  for (const [index, ip] of ips.entries()) {
    const request = new Request(`http://localhost/v1/chat/completions?r=${index}`, { method: "POST" });
    const state = store.initialize(request, Date.now(), 60_000);
    state.clientIdentity = { address: ip, source: "tcp-peer" };
    state.startProviderFlight();
  }
  return store;
}

describe("live in-flight routes", () => {
  test("snapshot returns the current count and unique IPs", async () => {
    const store = storeWithFlights("1.1.1.1", "1.1.1.1");
    const response = await appWith(readerAccess, undefined, store).handle(
      new Request("http://localhost/live/in-flight"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ inFlight: 2, uniqueIps: 1 });
  });

  test("snapshot rejects unauthenticated callers", async () => {
    const response = await appWith(undefined).handle(
      new Request("http://localhost/live/in-flight"),
    );
    expect(response.status).toBe(401);
  });

  test("stream emits a count snapshot frame first", async () => {
    const store = storeWithFlights("9.9.9.9");
    const response = await appWith(readerAccess, undefined, store).handle(
      new Request("http://localhost/live/in-flight/stream"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    expect(new TextDecoder().decode(first.value)).toContain(`event: count\ndata: {"inFlight":1,"uniqueIps":1}`);
  });

  test("stream subscribes before its snapshot so count changes are not lost", async () => {
    const store = new ProxyRequestStateStore();
    const response = await appWith(readerAccess, undefined, store).handle(
      new Request("http://localhost/live/in-flight/stream"),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const snapshot = await reader.read();
    const request = new Request("http://localhost/v1/chat/completions", { method: "POST" });
    const state = store.initialize(request, Date.now(), 60_000);
    state.clientIdentity = { address: "7.7.7.7", source: "tcp-peer" };
    state.startProviderFlight();
    const update = await reader.read();
    await reader.cancel();
    expect(decoder.decode(snapshot.value)).toContain(`event: count\ndata: {"inFlight":0,"uniqueIps":0}`);
    expect(decoder.decode(update.value)).toContain(`event: count\ndata: {"inFlight":1,"uniqueIps":1}`);
  });

  test("stream rejects unauthenticated callers without opening a stream", async () => {
    const response = await appWith(undefined).handle(
      new Request("http://localhost/live/in-flight/stream"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).not.toBe("text/event-stream");
  });
});

describe("live pool usage routes", () => {
  test("snapshot returns per-pool inflight rows", async () => {
    const selector = new NetworkPoolSelector();
    const slot = selector.acquire("pool-a", 10);
    expect(slot.acquired).toBe(true);
    const response = await appWith(readerAccess, selector).handle(
      new Request("http://localhost/live/pools"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      pools: [{ poolId: "pool-a", currentInflight: 1, bytesSent: 0, bytesReceived: 0 }],
    });
    slot.release();
  });

  test("snapshot is empty when no pool is in use", async () => {
    const selector = new NetworkPoolSelector();
    const response = await appWith(readerAccess, selector).handle(
      new Request("http://localhost/live/pools"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pools: [] });
  });

  test("snapshot rejects unauthenticated callers", async () => {
    const response = await appWith(undefined, new NetworkPoolSelector()).handle(
      new Request("http://localhost/live/pools"),
    );
    expect(response.status).toBe(401);
  });

  test("stream emits a pools snapshot frame first", async () => {
    const selector = new NetworkPoolSelector();
    const slot = selector.acquire("pool-s", 10);
    expect(slot.acquired).toBe(true);
    const response = await appWith(readerAccess, selector).handle(
      new Request("http://localhost/live/pools/stream"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    slot.release();
    expect(new TextDecoder().decode(first.value)).toContain(
      `event: pools\ndata: {"pools":[{"poolId":"pool-s","currentInflight":1,"bytesSent":0,"bytesReceived":0}]}`,
    );
  });

  test("snapshot joins measured egress bytes onto the pool row", async () => {
    resetPoolByteAccounting();
    recordPoolBytes("pool-bytes", "sent", 1_500);
    recordPoolBytes("pool-bytes", "received", 500);
    const selector = new NetworkPoolSelector();
    const slot = selector.acquire("pool-bytes", 10);
    const response = await appWith(readerAccess, selector).handle(
      new Request("http://localhost/live/pools"),
    );
    expect(await response.json()).toEqual({
      pools: [{ poolId: "pool-bytes", currentInflight: 1, bytesSent: 1_500, bytesReceived: 500 }],
    });
    slot.release();
    resetPoolByteAccounting();
  });

  test("stream rejects unauthenticated callers without opening a stream", async () => {
    const response = await appWith(undefined, new NetworkPoolSelector()).handle(
      new Request("http://localhost/live/pools/stream"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).not.toBe("text/event-stream");
  });

  test("selector subscription fires on acquire and release", async () => {
    const selector = new NetworkPoolSelector();
    const seen: Array<readonly { poolId: string; currentInflight: number }[]> = [];
    const stop = selector.subscribePoolUsage((usage) => seen.push(usage));
    const slot = selector.acquire("pool-sub", 10);
    slot.release();
    stop();
    // Release after unsubscribe emits nothing further.
    const extra = selector.acquire("pool-sub", 10);
    extra.release();
    expect(seen).toEqual([
      [{ poolId: "pool-sub", currentInflight: 1 }],
      [],
    ]);
  });
});
