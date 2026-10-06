/**
 * How the buddy family treats a caller's system instructions.
 *
 * The upstream rejects a leading turn that is not `system` (400, code `11128`)
 * and rejects `developer` outright, so the opening turn is always `system` —
 * but *whose text* it carries is the behaviour under test. It used to carry
 * only the variant's fixed prompt with the caller's turn discarded, so a
 * client's own instructions never reached the model.
 */
import { describe, expect, test } from "bun:test";
import { applyBuddySystemPrompt } from "../../src/providers/integrations/buddy/buddy-chat-shared";

const VARIANT_PROMPT = "You are the proxy's fixed prompt.";

function run(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const input = [...messages];
  applyBuddySystemPrompt(input, VARIANT_PROMPT);
  return input;
}

describe("applyBuddySystemPrompt", () => {
  test("caller system text replaces the variant prompt", () => {
    const out = run([
      { role: "system", content: "You review coding conversations." },
      { role: "user", content: "hi" },
    ]);
    expect(out[0]).toEqual({ role: "system", content: "You review coding conversations." });
    expect(out[1]?.["content"]).toEqual([{ type: "text", text: "hi" }]);
  });

  test("no second system turn is appended", () => {
    // Two `system` turns make the model read two competing instruction sets.
    const out = run([
      { role: "system", content: "caller instructions" },
      { role: "user", content: "hi" },
    ]);
    expect(out.filter((m) => m["role"] === "system")).toHaveLength(1);
  });

  test("developer text is carried as the leading system turn", () => {
    // `developer` is refused by the upstream, so it is not forwarded as-is.
    const out = run([
      { role: "developer", content: "caller developer instructions" },
      { role: "user", content: "hi" },
    ]);
    expect(out[0]).toEqual({ role: "system", content: "caller developer instructions" });
    expect(out.some((m) => m["role"] === "developer")).toBe(false);
  });

  test("the variant prompt is used when the caller sent none", () => {
    const out = run([{ role: "user", content: "hi" }]);
    expect(out[0]).toEqual({ role: "system", content: VARIANT_PROMPT });
  });

  test("multiple caller system turns collapse into one", () => {
    const out = run([
      { role: "system", content: "first" },
      { role: "system", content: "second" },
      { role: "user", content: "hi" },
    ]);
    expect(out.filter((m) => m["role"] === "system")).toHaveLength(1);
    expect(out[0]?.["content"]).toBe("first\n\nsecond");
  });

  test("the opening turn is always system", () => {
    for (const messages of [
      [{ role: "user", content: "hi" }],
      [{ role: "developer", content: "x" }, { role: "user", content: "hi" }],
      [{ role: "system", content: "x" }, { role: "user", content: "hi" }],
    ]) {
      expect(run(messages)[0]?.["role"]).toBe("system");
    }
  });
});
