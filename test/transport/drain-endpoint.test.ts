import { describe, expect, test } from "bun:test";
import { createDrainHandler } from "../../src/transport/drain-endpoint";

const TOKEN = "s3cret-drain-token";

function makeHandler(peer: string | null) {
  const drains: number[] = [];
  const handler = createDrainHandler({
    token: TOKEN,
    triggerDrain: () => drains.push(Date.now()),
    resolvePeerAddress: () => peer,
  });
  return { handler, drains };
}

function post(headers: Record<string, string> = {}): Request {
  return new Request("https://gateway.test/admin/drain", { method: "POST", headers });
}

describe("drain endpoint", () => {
  test("loopback peer with the right token drains and acknowledges", async () => {
    const { handler, drains } = makeHandler("127.0.0.1");
    const response = await handler({ request: post({ "x-drain-token": TOKEN }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "draining" });
    // The drain is scheduled after the 202 is produced, so the caller is never
    // left with a dropped connection.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(drains.length).toBe(1);
  });

  test("accepts the IPv4-mapped loopback spelling Bun reports on Windows", async () => {
    const { handler, drains } = makeHandler("::ffff:127.0.0.1");
    const response = await handler({ request: post({ "x-drain-token": TOKEN }) });
    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(drains.length).toBe(1);
  });

  test("a non-loopback peer is refused even with the correct token", async () => {
    const { handler, drains } = makeHandler("203.0.113.7");
    await expect(handler({ request: post({ "x-drain-token": TOKEN }) })).rejects.toMatchObject({
      code: "invalid_request",
      status: 403,
    });
    expect(drains.length).toBe(0);
  });

  test("a missing or wrong token is refused even from loopback", async () => {
    const missing = makeHandler("127.0.0.1");
    await expect(missing.handler({ request: post() })).rejects.toMatchObject({
      code: "invalid_request",
      status: 401,
    });
    const wrong = makeHandler("127.0.0.1");
    await expect(
      wrong.handler({ request: post({ "x-drain-token": "not-the-token" }) }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 401 });
    expect(missing.drains.length).toBe(0);
    expect(wrong.drains.length).toBe(0);
  });

  test("an unknown peer address is refused", async () => {
    const { handler } = makeHandler(null);
    await expect(handler({ request: post({ "x-drain-token": TOKEN }) })).rejects.toMatchObject({
      code: "invalid_request",
      status: 403,
    });
  });
});
