import { describe, expect, test } from "bun:test";
import { RoutingEngine } from "../../../src/transport/routing/router";
import type { RouteCandidate, RouteSnapshot } from "../../../src/transport/routing/route-model";

const acct = (
  id: string,
  health?: "cooldown" | "model_cooldown" | "disabled",
): RouteCandidate => ({
  provider_id: "cb",
  model_id: "deepseek-v4.1-flash",
  wire_family: "chat",
  endpoint: "/v1/chat/completions",
  capability_profile: {
    tools: true,
    reasoning: true,
    vision: false,
    streaming: true,
    input_modalities: ["text"],
    output_modalities: ["text"],
    generation_controls: new Set(),
    context_window: 1000,
    max_output_tokens: 1000,
  } as never,
  provider_account_id: id,
  ...(health === undefined ? {} : { health_status: health }),
});

const snap = (cs: RouteCandidate[]): RouteSnapshot =>
  ({ revision: 1, candidates: cs, combos: {}, aliases: {} }) as never as RouteSnapshot;

describe("exhausted models report unavailable, not missing", () => {
  test("all accounts cooling throws 429 accounts_rate_limited, not a route to a cooling account", async () => {
    // When nothing but cooling accounts remain there is no healthy sibling to
    // fail over to, so dialing one can only reproduce the refusal that cooled
    // it — the operator reported the gateway "still hit a cooled-down account"
    // and never failed over. Answer 429 (rate limited) so the client retries
    // after the reset, rather than a 503 that reads as missing capacity.
    const engine = new RoutingEngine();
    const err = await engine
      .plan("cb/deepseek-v4.1-flash", snap([acct("A", "cooldown"), acct("B", "cooldown")]), null, [])
      .then(
        () => null,
        (error: unknown) => error as { code?: string; status?: number },
      );
    expect(err?.code).toBe("accounts_rate_limited");
    expect(err?.status).toBe(429);
  });

  test("a single cooling account also answers 429, never dials the cooling account", async () => {
    // The one-account deployment is the sharpest case: the account is the only
    // route, but a cooldown means the upstream just refused it. Answering 429
    // is honest; silently re-dialing it made every request inside the window
    // fail upstream and log another `active → cooldown` row.
    const engine = new RoutingEngine();
    const err = await engine
      .plan("cb/deepseek-v4.1-flash", snap([acct("A", "cooldown")]), null, [])
      .then(
        () => null,
        (error: unknown) => error as { code?: string; status?: number },
      );
    expect(err?.code).toBe("accounts_rate_limited");
    expect(err?.status).toBe(429);
  });

  test("a healthy account is preferred over a cooling one", async () => {
    // The whole point of keeping a cooling account in the plan: it must be a
    // fallback, never the first choice while a healthy sibling exists.
    const engine = new RoutingEngine();
    const plan = await engine.plan(
      "cb/deepseek-v4.1-flash",
      snap([acct("A", "cooldown"), acct("B")]),
      null,
      [],
    );
    expect(plan.candidates.map((c) => c.provider_account_id)).toEqual(["B", "A"]);
  });

  test("the cooling account stays last even when it is the first candidate", async () => {
    // Ordering must not depend on the snapshot's own order: the deprioritized
    // account is moved to the back whichever position it arrived in.
    const engine = new RoutingEngine();
    const plan = await engine.plan(
      "cb/deepseek-v4.1-flash",
      snap([acct("A", "cooldown"), acct("B"), acct("C")]),
      null,
      [],
    );
    expect(plan.candidates.map((c) => c.provider_account_id)).toEqual(["B", "C", "A"]);
  });

  test("a model-scoped cooldown is excluded, not deprioritized", async () => {
    // The reported symptom: the upstream stated this exact (account, model)
    // pair is exhausted until a named reset, yet the plan kept the account in
    // the list. Failover then spent a round trip on a known-refused account
    // after every healthy sibling had failed, and each attempt logged another
    // `active → cooldown` row — the operator read that as one account churning
    // while its siblings sat idle.
    const engine = new RoutingEngine();
    const plan = await engine.plan(
      "cb/deepseek-v4.1-flash",
      snap([acct("A", "model_cooldown"), acct("B"), acct("C")]),
      null,
      [],
    );
    expect(plan.candidates.map((c) => c.provider_account_id)).toEqual(["B", "C"]);
  });

  test("every account model-cooling throws accounts_unavailable, not a route to a refused account", async () => {
    // Unlike an account-wide cooldown — which still routes, so a single-account
    // deployment is never parked — a model-scoped one has no usable candidate
    // left for this model. Answering 503 is the honest outcome; dialing a pair
    // the upstream just refused is not.
    const engine = new RoutingEngine();
    const err = await engine
      .plan("cb/deepseek-v4.1-flash", snap([acct("A", "model_cooldown")]), null, [])
      .then(
        () => null,
        (error: unknown) => error as { code?: string; status?: number; details?: { reasons?: string[] } },
      );
    expect(err?.code).toBe("accounts_unavailable");
    expect(err?.status).toBe(503);
    expect(err?.details?.reasons).toContain("model_cooldown");
  });

  test("disabled accounts stay excluded until explicitly recovered", async () => {
    const engine = new RoutingEngine();
    const err = await engine
      .plan("cb/deepseek-v4.1-flash", snap([acct("A", "disabled")]), null, [])
      .then(
        () => null,
        (error: unknown) => error as { code?: string; status?: number },
      );
    expect(err?.code).toBe("accounts_unavailable");
    expect(err?.status).toBe(503);

    const plan = await engine.plan(
      "cb/deepseek-v4.1-flash",
      snap([acct("A")]),
      null,
      [],
    );
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.provider_account_id).toBe("A");
  });

  test("every account unusable for a hard reason => 503 accounts_unavailable", async () => {
    // `disabled` remains a hard exclusion — an operator decision that only an
    // operator reverses. When nothing is left to try, the error is still
    // "unavailable", never a 404.
    const engine = new RoutingEngine();
    const err = await engine
      .plan(
        "cb/deepseek-v4.1-flash",
        snap([acct("A", "disabled"), acct("B", "disabled")]),
        null,
        [],
      )
      .then(
        () => null,
        (error: unknown) => error as { code?: string; status?: number; message?: string },
      );
    expect(err?.code).toBe("accounts_unavailable");
    expect(err?.status).toBe(503);
    expect(err?.message).toContain("cb/deepseek-v4.1-flash");
  });

  test("no candidate at all => still a genuine 404 model_not_found", async () => {
    const engine = new RoutingEngine();
    const err = await engine
      .plan("cb/nope-model", snap([]), null, [])
      .then(
        () => null,
        (error: unknown) => error as { code?: string; status?: number },
      );
    expect(err?.code).toBe("model_not_found");
    expect(err?.status).toBe(404);
  });

  test("one account recovers => the plan routes to it first", async () => {
    const engine = new RoutingEngine();
    const plan = await engine.plan(
      "cb/deepseek-v4.1-flash",
      snap([acct("A", "cooldown"), acct("B")]),
      null,
      [],
    );
    expect(plan.candidates[0]?.provider_account_id).toBe("B");
    expect(plan.candidates).toHaveLength(2);
  });
});
