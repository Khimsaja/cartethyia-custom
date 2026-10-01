import { describe, expect, test } from "bun:test";
import {
  buildFusionJudgePrompt,
  collectFusionPanel,
  runFusionPanel,
  FUSION_DEFAULTS,
} from "../../../src/transport/routing/fusion";

describe("collectFusionPanel", () => {
  test("returns answers and failures aligned to the panel", async () => {
    const models = ["a", "b", "c"];
    const results = [
      Promise.resolve("ans-a"),
      Promise.reject(new Error("boom")),
      Promise.resolve("ans-c"),
    ];
    const outcome = await collectFusionPanel(models, results, FUSION_DEFAULTS);
    expect(outcome.answers.map((a) => a.model)).toEqual(["a", "c"]);
    expect(outcome.answers.map((a) => a.text)).toEqual(["ans-a", "ans-c"]);
    expect(outcome.failures).toEqual([{ model: "b", reason: "error" }]);
  });

  test("treats empty text as a failure, not an answer", async () => {
    const outcome = await collectFusionPanel(["a", "b"], [Promise.resolve("  "), Promise.resolve("real")], FUSION_DEFAULTS);
    expect(outcome.answers.map((a) => a.text)).toEqual(["real"]);
    expect(outcome.failures).toEqual([{ model: "a", reason: "empty" }]);
  });

  test("proceeds on quorum without waiting for a straggler", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 5_000));
    const started = Date.now();
    const outcome = await collectFusionPanel(
      ["fast1", "fast2", "slow"],
      [Promise.resolve("f1"), Promise.resolve("f2"), slow],
      { minPanel: 2, stragglerGraceMs: 30, panelHardTimeoutMs: 10_000 },
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(outcome.answers.map((a) => a.text).sort()).toEqual(["f1", "f2"]);
    expect(outcome.failures.map((f) => f.model)).toEqual(["slow"]);
  });

  test("a hung panel is capped by the hard timeout", async () => {
    const hung = new Promise<string>(() => {});
    const started = Date.now();
    const outcome = await collectFusionPanel(["a", "hung"], [Promise.resolve("a"), hung], {
      minPanel: 2,
      stragglerGraceMs: 60_000,
      panelHardTimeoutMs: 40,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(outcome.answers.map((a) => a.text)).toEqual(["a"]);
    expect(outcome.failures.map((f) => f.reason)).toEqual(["timeout"]);
  });
});

describe("buildFusionJudgePrompt", () => {
  test("anonymizes sources and asks for analysis before writing", () => {
    const prompt = buildFusionJudgePrompt([
      { model: "a", text: "answer one" },
      { model: "b", text: "answer two" },
    ]);
    expect(prompt).toContain("[Source 1]\nanswer one");
    expect(prompt).toContain("[Source 2]\nanswer two");
    // The model names never leak into the judge directive.
    expect(prompt).not.toContain("answer one\nb");
    expect(prompt.toLowerCase()).toContain("consensus");
    expect(prompt.toLowerCase()).toContain("blind spot");
  });
});

describe("runFusionPanel", () => {
  test("one surviving panel model answers directly (nothing to fuse)", async () => {
    const outcome = await runFusionPanel({
      panel: ["only", "fails"],
      judge: "only",
      dispatchPanel: async (model) => {
        if (model === "fails") throw new Error("nope");
        return "solo";
      },
    });
    expect(outcome).toEqual({ kind: "direct", answer: "solo", model: "only" });
  });

  test("two or more answers route to the judge with a synthesis prompt", async () => {
    const outcome = await runFusionPanel({
      panel: ["a", "b"],
      judge: "a",
      dispatchPanel: async (model) => `ans-${model}`,
    });
    expect(outcome.kind).toBe("judge");
    if (outcome.kind !== "judge") throw new Error("expected judge");
    expect(outcome.judgeModel).toBe("a");
    expect(outcome.prompt).toContain("ans-a");
    expect(outcome.prompt).toContain("ans-b");
  });

  test("every panel model failing yields empty", async () => {
    const outcome = await runFusionPanel({
      panel: ["a", "b"],
      judge: "a",
      dispatchPanel: async () => {
        throw new Error("down");
      },
    });
    expect(outcome).toEqual({ kind: "empty" });
  });
});
