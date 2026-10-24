/**
 * "auto" model picker: the most stable allowlisted model wins.
 *
 * Success rate decides; latency breaks ties; volume breaks latency ties.
 * Models below the sample floor are invisible to the picker, and a key
 * without an explicit whitelist (or on blacklist mode) cannot use auto at
 * all — there is no bounded candidate set to choose from.
 */
import { expect, test } from "bun:test";
import {
  AUTO_MODEL_MIN_SAMPLES,
  AutoModelScorer,
  pickAutoModel,
  type AutoModelStats,
} from "../../src/transport/routing/auto-model";

function stats(total: number, completed: number, avgLatencyMs: number | null): AutoModelStats {
  return { total, completed, avgLatencyMs };
}

test("highest success rate wins", () => {
  const picked = pickAutoModel(
    ["model-a", "model-b"],
    new Map([
      ["model-a", stats(100, 95, 500)],
      ["model-b", stats(100, 60, 100)],
    ]),
  );
  expect(picked).toBe("model-a");
});

test("latency breaks a success-rate tie", () => {
  const picked = pickAutoModel(
    ["model-a", "model-b"],
    new Map([
      ["model-a", stats(100, 90, 900)],
      ["model-b", stats(100, 90, 200)],
    ]),
  );
  expect(picked).toBe("model-b");
});

test("volume breaks a rate-and-latency tie", () => {
  const picked = pickAutoModel(
    ["model-a", "model-b"],
    new Map([
      ["model-a", stats(50, 45, 300)],
      ["model-b", stats(200, 180, 300)],
    ]),
  );
  expect(picked).toBe("model-b");
});

test("models below the sample floor are never picked", () => {
  const picked = pickAutoModel(
    ["model-a", "model-b"],
    new Map([
      ["model-a", stats(AUTO_MODEL_MIN_SAMPLES - 1, AUTO_MODEL_MIN_SAMPLES - 1, 10)],
      ["model-b", stats(AUTO_MODEL_MIN_SAMPLES, 1, 5000)],
    ]),
  );
  expect(picked).toBe("model-b");
});

test("no usable data returns null", () => {
  expect(pickAutoModel(["model-a"], new Map())).toBeNull();
  expect(
    pickAutoModel(["model-a"], new Map([["model-b", stats(100, 100, 100)]])),
  ).toBeNull();
});

test("missing latency never beats measured latency on a tie", () => {
  const picked = pickAutoModel(
    ["model-a", "model-b"],
    new Map([
      ["model-a", stats(100, 90, null)],
      ["model-b", stats(100, 90, 400)],
    ]),
  );
  expect(picked).toBe("model-b");
});

test("blacklist keys and empty whitelists cannot use auto", async () => {
  const scorer = new AutoModelScorer();
  await expect(
    scorer.pickForKey({ model_access_mode: "blacklist", model_list: ["model-a"] }),
  ).resolves.toEqual({ ok: false, reason: "no_allowlist" });
  await expect(scorer.pickForKey({ model_access_mode: "whitelist", model_list: [] })).resolves.toEqual({
    ok: false,
    reason: "no_allowlist",
  });
  await expect(scorer.pickForKey({ model_access_mode: "whitelist", model_list: null })).resolves.toEqual({
    ok: false,
    reason: "no_allowlist",
  });
});
