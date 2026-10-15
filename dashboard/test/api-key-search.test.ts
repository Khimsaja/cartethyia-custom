import { describe, expect, test } from "bun:test";
import { apiKeyMatchesSearch, filterApiKeys } from "../src/lib/api-key-search";

const keys = [
  { label: "Prod Server", keyPrefix: "ct_prod", modelList: ["openai/gpt-5", "anthropic/claude"] },
  { label: "dev laptop", keyPrefix: "ct_dev", modelList: ["openai/gpt-5-mini"] },
  { label: "Share Template", keyPrefix: null, modelList: [] },
];

describe("api key search", () => {
  test("empty query keeps every key in order", () => {
    expect(filterApiKeys(keys, "  ").map((k) => k.label)).toEqual([
      "Prod Server",
      "dev laptop",
      "Share Template",
    ]);
  });

  test("matches name case-insensitively", () => {
    expect(filterApiKeys(keys, "prod").map((k) => k.label)).toEqual(["Prod Server"]);
    expect(apiKeyMatchesSearch({ label: "dev laptop", keyPrefix: "ct_dev", modelList: [] }, "PROD")).toBe(false);
  });

  test("matches prefix and model list", () => {
    expect(filterApiKeys(keys, "ct_dev").map((k) => k.label)).toEqual(["dev laptop"]);
    expect(filterApiKeys(keys, "claude").map((k) => k.label)).toEqual(["Prod Server"]);
  });

  test("multiple tokens must all match (AND)", () => {
    expect(filterApiKeys(keys, "prod gpt-5").map((k) => k.label)).toEqual(["Prod Server"]);
    expect(filterApiKeys(keys, "prod mini")).toEqual([]);
  });
});
