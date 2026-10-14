import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import { gatewayErrorFromStreamError } from "../../src/protocol/stream-error-frames";
import { mapUpstreamHttpError } from "../../src/transport/failure-policy";

describe("account error diagnostics", () => {
  test("stores the raw upstream response instead of a generated health explanation", () => {
    const raw = '{\n  "error": {\n    "code": "rate_limit_exceeded",\n    "message": "too many requests"\n  }\n}';
    const error = new GatewayError(
      "accounts_rate_limited",
      429,
      "Too many requests",
      { providerCode: "rate_limit_exceeded", raw },
      "upstream",
    );
    const classification = classifyAccountError(error, {
      origin: "upstream",
      scope: "account",
      providerCode: "rate_limit_exceeded",
      statusCode: 429,
    });

    expect(classification.category).toBe("rate_limit_transient");
    expect(classification.reason).toBe(raw);
  });

  test("the HTTP error mapper keeps the response body verbatim", async () => {
    const raw = '{\n  "error": {\n    "code": "rate_limit_exceeded",\n    "message": "too many requests"\n  }\n}';
    try {
      await mapUpstreamHttpError(new Response(raw, { status: 429 }), "provider");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      if (!(error instanceof GatewayError)) throw error;
      expect(error.details.raw).toBe(raw);
      return;
    }
    throw new Error("Expected upstream error mapper to throw");
  });

  test("account health uses the full upstream stream error object as its reason", () => {
    const providerError = {
      code: 14003,
      msg: "too many requests",
      requestId: "97ed0e04ad984ea984b2c4fa1c8ea1ef",
      retry_policy: { retry: true },
      displayMsg: { en: "Too many requests. Please retry later." },
      actions: ["SUBMIT_FEEDBACK", "COPY_ERROR", "RETRY"],
    };
    const error = gatewayErrorFromStreamError(providerError, "provider");
    if (error === undefined) throw new Error("Expected stream error to be classified");

    const classification = classifyAccountError(error, {
      origin: "upstream",
      scope: "account",
      providerCode: String(providerError.code),
    });

    expect(classification.category).toBe("rate_limit_transient");
    expect(classification.reason).toBe(String(error.details.raw));
    expect(classification.reason).toContain(providerError.requestId);
    expect(classification.reason).toContain("retry_policy");
  });

  /**
   * CodeBuddy/WorkBuddy park a *model* for a whole window and name the refill:
   * `{"code":"6004","msg":"usage exceeds frequency limit ... your usage will
   * reset at <stamp> UTC+8, alternatively, you can switch to the other models
   * to continue using it."}`.
   *
   * The provider names the remedy itself — use a different model — which only
   * works if the account still serves every other model. Taken account-wide it
   * parked the whole account until the reset, so the switch the upstream
   * offered was refused by our own gateway and every sibling model went dark
   * with it. `rate_limit_transient` is what scopes the write to the model.
   */
  test("a buddy frequency window parks the model, not the account", () => {
    const reset = "2026-10-15 07:45:46 UTC+8";
    const message =
      `usage exceeds frequency limit, but don't worry, your usage will reset at ${reset}, ` +
      "alternatively, you can switch to the other models to continue using it.";
    const classification = classifyAccountError(
      { message, status: 429 },
      { origin: "upstream", scope: "provider", providerCode: "6004", statusCode: 429 },
    );

    expect(classification.category).toBe("rate_limit_transient");
    expect(classification.mutatesAccount).toBe(true);
    // The provider stated the window, so the cooldown is its number rather
    // than one of this module's fallback constants.
    expect(classification.providerStated).toBe(true);
    expect(classification.cooldownMs).toBeGreaterThan(0);
  });

  test("a buddy 6004 with no model remedy stays account-wide quota", () => {
    // Narrow on purpose: a bare 6004 is not evidence that other models work, so
    // it must keep the account-wide hard cooldown it always had.
    const classification = classifyAccountError(
      { message: "usage exceeds frequency limit", status: 429 },
      { origin: "upstream", scope: "provider", providerCode: "6004", statusCode: 429 },
    );
    expect(classification.category).toBe("quota_exhausted");
  });

  test("an unnamed 429 stays transient so a healthy account is not parked", () => {
    // Not every 429 is a window: a burst is worth retrying, and parking the
    // account for hours over one would take a healthy credential out of
    // rotation. Only the quota-shaped phrasing escalates.
    const classification = classifyAccountError(
      { message: "Too many requests", status: 429 },
      { origin: "upstream", scope: "provider", providerCode: "rate_limit_exceeded", statusCode: 429 },
    );
    expect(classification.category).toBe("rate_limit_transient");
  });
});
