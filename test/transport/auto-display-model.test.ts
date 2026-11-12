/**
 * A request for `auto` must stay opaque to the buyer: every client-facing
 * response — streamed or not, on every surface — names `auto`, never the
 * picked model, its provider, or the provider's system fingerprint.
 * Routing, telemetry, and cost still use the pick; only the display label
 * changes, via the preparer's `displayModel` threaded into the encoders.
 */
import { expect, test } from "bun:test";
import type { CanonicalEvent } from "../../src/protocol/canonical-model";
import { ChatStreamEncoder, jsonCompletion } from "../../src/transport/surface/chat/encode";
import { ResponsesEventEncoder } from "../../src/transport/surface/responses/encode";

const PICKED = "cline-free/solar-mini4";
const FINGERPRINT = "fp_picked_provider";

function startEvent(): CanonicalEvent {
  return {
    type: "message_start",
    sequence_number: 1,
    model: PICKED,
    system_fingerprint: FINGERPRINT,
  } as CanonicalEvent;
}

function textDelta(sequenceNumber: number, text: string): CanonicalEvent {
  return {
    type: "content_delta",
    sequence_number: sequenceNumber,
    content: { kind: "text", text },
  } as CanonicalEvent;
}

function chatChunkModels(events: CanonicalEvent[], options: Record<string, unknown>): string[] {
  const encoder = new ChatStreamEncoder(options as never);
  const models: string[] = [];
  for (const event of events) {
    for (const chunk of encoder.push(event)) {
      if (typeof chunk["model"] === "string") models.push(chunk["model"] as string);
    }
  }
  return models;
}

test("chat stream keeps the pinned display model despite upstream events", () => {
  const models = chatChunkModels([startEvent(), textDelta(2, "halo")], {
    model: "auto",
    modelPinned: true,
  });
  expect(models.length).toBeGreaterThan(0);
  expect(models.every((model) => model === "auto")).toBe(true);
});

test("chat stream without a pin still follows the upstream model", () => {
  const models = chatChunkModels([startEvent(), textDelta(2, "halo")], {});
  expect(models).toContain(PICKED);
  expect(models.every((model) => model === PICKED)).toBe(true);
});

test("non-stream chat completion hides the fingerprint when pinned", () => {
  const pinned = jsonCompletion([startEvent()], { model: "auto", modelPinned: true }, "auto", "chatcmpl-x", 123);
  expect(pinned["model"]).toBe("auto");
  expect("system_fingerprint" in pinned).toBe(false);
  const unpinned = jsonCompletion([startEvent()], {}, PICKED, "chatcmpl-x", 123);
  expect(unpinned["model"]).toBe(PICKED);
  expect(unpinned["system_fingerprint"]).toBe(FINGERPRINT);
});

function responsesStart(sequenceNumber: number, model: string): CanonicalEvent {
  return {
    type: "response_start",
    sequence_number: sequenceNumber,
    model,
    system_fingerprint: FINGERPRINT,
  } as CanonicalEvent;
}

test("responses stream pins the display model and withholds the fingerprint", () => {
  const encoder = new ResponsesEventEncoder({ model: "auto", modelPinned: true });
  const created = encoder
    .push(responsesStart(1, PICKED))
    .find((wire) => wire.type === "response.created");
  expect(created).toBeDefined();
  const response = created?.["response"] as Record<string, unknown> | undefined;
  expect(response?.["model"]).toBe("auto");
  expect("system_fingerprint" in (response ?? {})).toBe(false);
  // A later event naming another model is not a lifecycle error when pinned.
  expect(() => encoder.push(responsesStart(2, "other/model"))).not.toThrow();
});

test("responses stream without a pin still reports the upstream model", () => {
  const encoder = new ResponsesEventEncoder({});
  const created = encoder
    .push(responsesStart(1, PICKED))
    .find((wire) => wire.type === "response.created");
  const response = created?.["response"] as Record<string, unknown> | undefined;
  expect(response?.["model"]).toBe(PICKED);
  expect(() => encoder.push(responsesStart(2, "other/model"))).toThrow();
});
