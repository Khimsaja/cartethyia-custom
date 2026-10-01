import { describe, expect, test } from "bun:test";
import {
  InMemoryModelAbuseStore,
  ModelStrikeService,
} from "../../src/security/model-abuse";
import { buildPipelineHarness } from "../helpers/pipeline-harness";

/**
 * The graduated model-abuse response, exercised through the real middleware
 * order: authentication → ban gate → canonical parse → preparation (where the
 * model is rejected). These assert what a probing client actually receives —
 * a warning that counts up, then a ban — and that a valid request clears the
 * count, which is the property that keeps a single typo from ever banning an
 * honest caller.
 */
const route = "/v1/chat/completions";

function post(model: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://cartethyia.test${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer contract-key", ...headers },
    body: JSON.stringify({ model, messages: [] }),
  });
}

/** Every model is rejected except `good-model`. */
function makeHarness(threshold = 3) {
  const store = new InMemoryModelAbuseStore(() => Date.now());
  const modelStrikes = new ModelStrikeService(store, { threshold, windowMs: 5 * 60_000 });
  const { app } = buildPipelineHarness({
    modelStrikes,
    rejectModel: (model) => model !== "good-model",
  });
  return { app, modelStrikes };
}

describe("model-abuse strikes through the real pipeline", () => {
  test("warns with an escalating count, then bans on the threshold", async () => {
    const { app } = makeHarness(3);

    const first = await app.handle(post("bad-model"));
    expect(first.status).toBe(404);
    expect(((await first.json()) as { error: { message: string } }).error.message).toContain(
      "Warning 1 of 3",
    );

    const second = await app.handle(post("bad-model"));
    expect(second.status).toBe(404);
    expect(((await second.json()) as { error: { message: string } }).error.message).toContain(
      "Warning 2 of 3",
    );

    // Third strike bans: the response is the typed 403, not another 404.
    const third = await app.handle(post("bad-model"));
    expect(third.status).toBe(403);
    const body = (await third.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_abuse_banned");

    // Once banned, even a valid model is refused — the ban is on the caller.
    const afterBan = await app.handle(post("good-model"));
    expect(afterBan.status).toBe(403);
  });

  test("a valid model between invalid ones resets the count", async () => {
    const { app } = makeHarness(3);

    await app.handle(post("bad-model"));
    await app.handle(post("bad-model"));
    // The client corrects itself.
    const good = await app.handle(post("good-model"));
    expect(good.status).toBe(200);
    // The next typo starts the count over, so no ban lands.
    const next = await app.handle(post("bad-model"));
    expect(next.status).toBe(404);
    expect(((await next.json()) as { error: { message: string } }).error.message).toContain(
      "Warning 1 of 3",
    );
  });

  test("a threshold-1 ban records both the IP and the key", async () => {
    const { app, modelStrikes } = makeHarness(1);
    // First invalid model bans immediately.
    const first = await app.handle(post("bad-model"));
    expect(first.status).toBe(403);
    const bans = await modelStrikes.listBans();
    expect(bans).toContainEqual({ scope: "ip", identity: "127.0.0.1" });
    expect(bans).toContainEqual({ scope: "api_key", identity: "contract-key" });
  });

  test("a banned caller is refused before parse, so no telemetry row is produced", async () => {
    const { app } = makeHarness(1);
    await app.handle(post("bad-model")); // bans
    // The ban gate runs in authentication, ahead of canonical parse, so the
    // response is the ban error and the request never reaches preparation.
    const banned = await app.handle(post("good-model"));
    expect(banned.status).toBe(403);
    expect(((await banned.json()) as { error: { code: string } }).error.code).toBe(
      "model_abuse_banned",
    );
  });
});
