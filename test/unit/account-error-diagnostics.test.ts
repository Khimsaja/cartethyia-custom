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
});
