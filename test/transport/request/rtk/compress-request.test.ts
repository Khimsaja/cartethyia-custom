import { describe, expect, test } from "bun:test";
import { compressRequest, compressToolText } from "../../../../src/transport/request/rtk/compress-request";
import { ponyTailPrompt } from "../../../../src/transport/request/rtk/ponytail-prompt";
import type { CanonicalMessage, CanonicalRequest } from "../../../../src/transport/canonical-model";

const request = (messages: readonly CanonicalMessage[]): CanonicalRequest =>
  ({
    model: "gpt-x",
    messages,
    generation_controls: {},
    stream: false,
    source_surface: "chat",
  }) as unknown as CanonicalRequest;

const toolResult = (text: string): CanonicalMessage =>
  ({
    role: "tool",
    content: [{ kind: "toolResult", call_id: "c1", content: [{ kind: "text", text }] }],
  }) as unknown as CanonicalMessage;

describe("compressToolText", () => {
  test("leaves a small blob untouched", () => {
    expect(compressToolText("short")).toBe("short");
  });

  test("compacts a bulky grep dump", () => {
    const dump = Array.from({ length: 80 }, (_, i) => `src/f.ts:${i + 1}:match ${i}`).join("\n");
    const out = compressToolText(dump);
    expect(out.length).toBeLessThan(dump.length);
    expect(out).toContain("matches in");
  });
});

describe("compressRequest", () => {
  test("is a no-op when both options are off", () => {
    const req = request([toolResult("x".repeat(2000))]);
    const { request: out, stats } = compressRequest(req, {});
    expect(out).toBe(req);
    expect(stats.prunedParts).toBe(0);
  });

  test("prunes tool-result text when RTK is on, leaving small parts alone", () => {
    const big = Array.from({ length: 80 }, (_, i) => `src/f.ts:${i + 1}:match ${i}`).join("\n");
    const req = request([toolResult(big), toolResult("tiny")]);
    const { request: out, stats } = compressRequest(req, { rtkPrune: true });
    expect(stats.prunedParts).toBe(1);
    expect(stats.savedChars).toBeGreaterThan(0);
    expect(out).not.toBe(req);
  });

  test("never prunes an error tool result", () => {
    const big = Array.from({ length: 80 }, (_, i) => `src/f.ts:${i + 1}:match ${i}`).join("\n");
    const errMsg = {
      role: "tool",
      content: [{ kind: "toolResult", call_id: "c1", is_error: true, content: [{ kind: "text", text: big }] }],
    } as unknown as CanonicalMessage;
    const { stats } = compressRequest(request([errMsg]), { rtkPrune: true });
    expect(stats.prunedParts).toBe(0);
  });

  test("injects the PonyTail directive into system content, idempotently", () => {
    const req = request([{ role: "user", content: [{ kind: "text", text: "hi" }] }]);
    const first = compressRequest(req, { ponyTail: "full" });
    expect(first.stats.ponyTailInjected).toBe(true);
    expect(first.request.system?.some((p) => p.kind === "text" && p.text === ponyTailPrompt("full"))).toBe(true);
    // Re-running must not append a second copy.
    const second = compressRequest(first.request, { ponyTail: "full" });
    expect(second.stats.ponyTailInjected).toBe(false);
    expect(second.request.system?.length).toBe(first.request.system?.length);
  });

  test("applies RTK prune before PonyTail in one pass", () => {
    const big = Array.from({ length: 80 }, (_, i) => `src/f.ts:${i + 1}:match ${i}`).join("\n");
    const { stats } = compressRequest(request([toolResult(big)]), {
      rtkPrune: true,
      ponyTail: "lite",
    });
    expect(stats.prunedParts).toBe(1);
    expect(stats.ponyTailInjected).toBe(true);
  });

  test("lite strength withholds the generic fallbacks", () => {
    // A run of repeated lines has no structural signature: only the generic
    // dedup filter compacts it, and `lite` withholds that — so the blob passes
    // through untouched. `full` engages the fallback and collapses the run.
    const blob = Array.from({ length: 300 }, () => "repeated log line with no structure").join("\n");
    expect(compressToolText(blob, "lite")).toBe(blob);
    expect(compressToolText(blob, "full").length).toBeLessThan(blob.length);
  });

  test("ultra compresses a blob below full's size gate", () => {
    // A small grep dump sits above `ultra`'s gate (200) but below `full`'s
    // (500), so `ultra` compacts it while `full` and `lite` leave it alone.
    const dump = Array.from({ length: 20 }, (_, i) => `src/f.ts:${i + 1}:match ${i}`).join("\n");
    expect(dump.length).toBeGreaterThan(200);
    expect(dump.length).toBeLessThan(500);
    expect(compressToolText(dump, "ultra").length).toBeLessThan(dump.length);
    expect(compressToolText(dump, "full")).toBe(dump);
  });
});
