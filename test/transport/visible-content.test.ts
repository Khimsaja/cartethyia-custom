/**
 * Client-body content verdict: only a parseable body that structurally
 * carries no answer counts as empty. Anything unrecognized fails open.
 */
import { expect, test } from "bun:test";
import { responseHasVisibleContent } from "../../src/transport/surface/visible-content";

const chat = (message: unknown) => ({ choices: [{ message }] });

test("chat: text content counts", () => {
  expect(responseHasVisibleContent("chat", chat({ content: "halo" }))).toBe(true);
});

test("chat: null, empty, and whitespace-only content do not", () => {
  expect(responseHasVisibleContent("chat", chat({ content: null }))).toBe(false);
  expect(responseHasVisibleContent("chat", chat({ content: "" }))).toBe(false);
  expect(responseHasVisibleContent("chat", chat({ content: "   " }))).toBe(false);
});

test("chat: content parts with text count, empty parts do not", () => {
  expect(
    responseHasVisibleContent("chat", chat({ content: [{ type: "text", text: "hi" }] })),
  ).toBe(true);
  expect(
    responseHasVisibleContent("chat", chat({ content: [{ type: "text", text: "" }] })),
  ).toBe(false);
});

test("chat: tool calls and refusals count as an answer", () => {
  expect(
    responseHasVisibleContent("chat", chat({ content: null, tool_calls: [{ id: "1" }] })),
  ).toBe(true);
  expect(responseHasVisibleContent("chat", chat({ content: null, refusal: "no" }))).toBe(true);
});

test("chat: no choices at all is empty", () => {
  expect(responseHasVisibleContent("chat", { choices: [] })).toBe(false);
});

test("completion: text counts, empty does not", () => {
  expect(responseHasVisibleContent("completion", { choices: [{ text: "hi" }] })).toBe(true);
  expect(responseHasVisibleContent("completion", { choices: [{ text: "" }] })).toBe(false);
});

test("messages: text parts and tool_use count, empty does not", () => {
  expect(
    responseHasVisibleContent("messages", { content: [{ type: "text", text: "hi" }] }),
  ).toBe(true);
  expect(
    responseHasVisibleContent("messages", { content: [{ type: "tool_use", name: "f" }] }),
  ).toBe(true);
  expect(responseHasVisibleContent("messages", { content: [] })).toBe(false);
  expect(
    responseHasVisibleContent("messages", { content: [{ type: "text", text: "" }] }),
  ).toBe(false);
});

test("responses: output_text, output text parts, and function calls count", () => {
  expect(responseHasVisibleContent("responses", { output_text: "hi", output: [] })).toBe(true);
  expect(
    responseHasVisibleContent("responses", {
      output: [{ content: [{ type: "output_text", text: "hi" }] }],
    }),
  ).toBe(true);
  expect(
    responseHasVisibleContent("responses", { output: [{ type: "function_call" }] }),
  ).toBe(true);
  expect(responseHasVisibleContent("responses", { output: [] })).toBe(false);
});

test("unknown surfaces and unparseable bodies fail open", () => {
  expect(responseHasVisibleContent("weird", { anything: true })).toBe(true);
  expect(responseHasVisibleContent("chat", "not-json")).toBe(true);
  expect(responseHasVisibleContent("chat", null)).toBe(true);
});
