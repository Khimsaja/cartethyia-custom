import { describe, expect, test } from "bun:test";
import { buildPayloadRecord } from "../../../src/observability/payload-capture";

/**
 * Guarantees the drawer’s panels always have values for both streaming and
 * non-streaming requests. This is the user-visible debug contract: the client
 * leg (Client request, Server response, Client response) must never be “—”
 * when payload capture is enabled, and the provider leg is present whenever
 * the exchange was captured.
 */
describe("payload drawer completeness (stream & non-stream)", () => {
  const tenantId = "tenant-test";
  const requestId = "req-test";

  function makeCaptureInput(stream: boolean) {
    // Simulate what proxy-request builds:
    // - non-stream: ingressBody + output.bytes (same for response & client)
    // - stream: ingressBody + streamedEvents (canonical) + client SSE bytes
    const ingressBody = { model: "m", messages: [{ role: "user", content: "hi" }] };
    const responseBody = stream
      ? [{ type: "content_delta", content: { kind: "text", text: "hello" } }]
      : { id: "resp-1", choices: [{ message: { content: "hello" } }] };
    const clientResponseBody = stream
      ? 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
      : { id: "resp-1", choices: [{ message: { content: "hello" } }] };

    return {
      tenantId,
      requestId,
      scope: "tenant" as const,
      tenantOptIn: true,
      requestBody: ingressBody,
      responseBody,
      clientResponseBody,
    };
  }

  test("non-stream payload has all 3 panels", () => {
    const record = buildPayloadRecord(makeCaptureInput(false));
    expect(record.request_body).toBeDefined();
    expect(record.request_body).not.toBeNull();
    expect(record.response_body).toBeDefined();
    expect(record.response_body).not.toBeNull();
    expect(record.client_response_body).toBeDefined();
    expect(record.client_response_body).not.toBeNull();
    // They should be equivalent for non-stream (same wire bytes)
    expect(JSON.stringify(record.response_body)).toBe(JSON.stringify(record.client_response_body));
  });

  test("stream payload has all 3 panels", () => {
    const record = buildPayloadRecord(makeCaptureInput(true));
    expect(record.request_body).toBeDefined();
    expect(record.request_body).not.toBeNull();
    expect(record.response_body).toBeDefined();
    expect(record.response_body).not.toBeNull();
    expect(record.client_response_body).toBeDefined();
    expect(record.client_response_body).not.toBeNull();
    // Stream: canonical vs wire differ, but both must be present
    expect(record.response_body).not.toEqual(record.client_response_body);
  });
});
