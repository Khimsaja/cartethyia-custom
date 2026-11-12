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
  filterAutoCandidates,
  pickAutoModel,
  shouldAdvertiseAutoModel,
  type AutoModelStats,
} from "../../src/transport/routing/auto-model";

function stats(
  total: number,
  completed: number,
  avgLatencyMs: number | null,
  qualityCompleted?: number,
): AutoModelStats {
  return { total, completed, avgLatencyMs, ...(qualityCompleted === undefined ? {} : { qualityCompleted }) };
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

test("empty answers lose to real answers at a lower raw rate", () => {
  const picked = pickAutoModel(
    ["model-a", "model-b"],
    new Map([
      // 99 raw completions, but 40 of them were empty 200s.
      ["model-a", stats(100, 99, 500, 59)],
      ["model-b", stats(100, 70, 500, 70)],
    ]),
  );
  expect(picked).toBe("model-b");
});

test("missing quality data falls back to raw completions", () => {
  const picked = pickAutoModel(
    ["model-a", "model-b"],
    new Map([
      ["model-a", stats(100, 95, 500)],
      ["model-b", stats(100, 60, 100)],
    ]),
  );
  expect(picked).toBe("model-a");
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

test("the auto trigger itself is never a candidate", () => {
  expect(filterAutoCandidates(["auto", "model-a", "model-b"])).toEqual(["model-a", "model-b"]);
  expect(filterAutoCandidates(["auto"])).toEqual([]);
});

test("a list of only auto is no allowlist", async () => {
  const scorer = new AutoModelScorer();
  await expect(
    scorer.pickForKey({ model_access_mode: "whitelist", model_list: ["auto"] }),
  ).resolves.toEqual({ ok: false, reason: "no_allowlist" });
});

test("auto is advertised exactly when the key can use it", () => {
  expect(shouldAdvertiseAutoModel({ model_access_mode: "whitelist", model_list: ["model-a", "model-b"] })).toBe(true);
  expect(shouldAdvertiseAutoModel({ model_access_mode: "whitelist", model_list: new Set(["model-a"]) })).toBe(true);
  expect(shouldAdvertiseAutoModel({ model_access_mode: "whitelist", model_list: ["auto", "model-a"] })).toBe(true);
  expect(shouldAdvertiseAutoModel({ model_access_mode: "blacklist", model_list: ["model-a"] })).toBe(false);
  expect(shouldAdvertiseAutoModel({ model_access_mode: "whitelist", model_list: [] })).toBe(false);
  expect(shouldAdvertiseAutoModel({ model_access_mode: "whitelist", model_list: null })).toBe(false);
  expect(shouldAdvertiseAutoModel({ model_access_mode: "whitelist", model_list: ["auto"] })).toBe(false);
});
