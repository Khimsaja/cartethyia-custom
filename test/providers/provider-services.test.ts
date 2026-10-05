import { describe, expect, test } from "bun:test";
import {
  BUNDLED_PROVIDER_METADATA,
  providerServiceKinds,
} from "../../src/providers/provider-metadata";
import { sanitizeProviderResponse } from "../../src/console/providers/catalog/provider-operations";
import { CLAUDE_MODELS } from "../../src/providers/integrations/claude/claude";
describe("provider service taxonomy", () => {
  test("defaults providers to LLM and declares real search surfaces", () => {
    expect(providerServiceKinds("openai")).toEqual(["llm"]);
    expect(providerServiceKinds("gemini")).toEqual(["llm", "websearch"]);
    expect(providerServiceKinds("codex")).toEqual(["llm", "websearch"]);
    expect(providerServiceKinds("exa")).toEqual(["websearch"]);
    expect(providerServiceKinds("custom-provider")).toEqual(["llm"]);
    for (const provider of BUNDLED_PROVIDER_METADATA)
      expect(provider.serviceKinds).not.toContain("all");
  });
  test("Claude models advertise the native web-search capability", () => {
    expect(CLAUDE_MODELS.length).toBeGreaterThan(0);
    expect(CLAUDE_MODELS.every((model) => model.webSearch)).toBe(true);
  });

  test("sanitized custom provider responses never expose an all category", () => {
    const response = sanitizeProviderResponse({
      providerId: "custom-provider",
      enabled: true,
      isBuiltIn: false,
      requiresAccount: true,
    });
    expect(response.serviceKinds).toEqual(["llm"]);
    expect(response.serviceKinds).not.toContain("all");
  });
});
