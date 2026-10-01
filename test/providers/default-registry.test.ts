import { describe, expect, test } from "bun:test";
import { BUNDLED_PROVIDER_MODULES, PROVIDER_CAPABILITIES, createDefaultProviderRegistry } from "../../src/providers/default-registry";
import { BUNDLED_PROVIDER_IDS } from "../../src/providers/provider-registry";
import { BUNDLED_PROVIDER_METADATA } from "../../src/providers/provider-metadata";

describe("default provider composition", () => {
  test("registers every bundled provider exactly once with matching identity", async () => {
    const registry = createDefaultProviderRegistry();
    const registrations = registry.registrations();
    const registeredIds = registrations.map((registration) => registration.provider_id);

    expect(new Set(registeredIds).size).toBe(registeredIds.length);
    expect([...registeredIds].sort()).toEqual([...BUNDLED_PROVIDER_IDS].sort());
  });

  test("every bundled provider has exactly one capability descriptor", () => {
    const capabilityIds = Object.keys(PROVIDER_CAPABILITIES).sort();
    expect(capabilityIds).toEqual([...BUNDLED_PROVIDER_IDS].sort());
  });

  test("module metadata, upstream host, and lazy loaders are wired", () => {
    for (const module of BUNDLED_PROVIDER_MODULES) {
      expect(BUNDLED_PROVIDER_IDS).toContain(module.id);
      expect(module.upstreamHost.hostname.length).toBeGreaterThan(0);
      expect(typeof module.loadAdapter).toBe("function");
    }
  });

  test("metadata parity: every bundled metadata row materializes one module", () => {
    const moduleIds = BUNDLED_PROVIDER_MODULES.map((module) => module.id).sort();
    const metadataIds = BUNDLED_PROVIDER_METADATA.map((metadata) => metadata.id).sort();
    expect(moduleIds).toEqual(metadataIds);
  });

  test("lazy capability resolution matches the declared capability surface", async () => {
    const registry = createDefaultProviderRegistry();
    expect(await registry.resolveAuthentication("claude")).toBeDefined();
    expect(await registry.resolveAuthentication("openai")).toBeUndefined();
    expect(await registry.resolveQuotaCollector("codex")).toBeDefined();
    expect(await registry.resolveQuotaCollector("openai")).toBeUndefined();
    expect(await registry.resolveModelDiscovery("openai")).toBeDefined();
    // deepseek serves a standard `/v1/models`, so it carries a discovery loader
    // even though its adapter is one of the shared zero-hook specs.
    expect(await registry.resolveModelDiscovery("deepseek")).toBeDefined();
    expect(registry.modelDiscoveryRequiresCredential("opencodeft")).toBe(false);
    expect(registry.modelDiscoveryRequiresCredential("openai")).toBe(true);
  });

  test("meta (Meta Model API) is an API-key provider sharing the muse-spark catalog", async () => {
    const registry = createDefaultProviderRegistry();
    // No OAuth login: the Model API is a pasted key, not a device login — that
    // is what separates it from `muse` (Muse Code) on the same upstream host.
    expect(await registry.resolveAuthentication("meta")).toBeUndefined();
    expect(await registry.resolve("meta")).toBeDefined();
    // Same upstream roster as Muse Code, declared once and reused.
    const { META_MODELS } = await import("../../src/providers/integrations/meta/meta");
    const { MUSE_CODE_MODELS } = await import("../../src/providers/integrations/muse/muse");
    expect(META_MODELS).toBe(MUSE_CODE_MODELS);
    expect(META_MODELS.length).toBeGreaterThan(0);
  });

  /**
   * A Claude sync must publish real limits, not `null`.
   *
   * The live listing carries dated ids (`claude-sonnet-4-5-20250929`) the base
   * catalog files undated, and `claude` is a Cartethyia id the catalog does not
   * carry at all (it files these models under `anthropic`). A discovery that
   * hardcoded `contextLimit: null` therefore rendered every synced row as
   * "n/a ctx · n/a out". Resolution is by model name — exact row, then bare id,
   * then the most-agreed row with the date suffix stripped — so a dated id still
   * inherits its undated sibling's limits.
   */
  test("claude model discovery fills context/output limits by model name", async () => {
    const registry = createDefaultProviderRegistry();
    const discovery = await registry.resolveModelDiscovery("claude");
    expect(discovery).toBeDefined();
    const models = await discovery!({
      baseUrl: "",
      credential: "token",
      fetcher: (async () =>
        new Response(
          JSON.stringify({ data: [{ id: "claude-sonnet-4-5-20250929" }] }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    expect(models).not.toBeNull();
    const sonnet = models!.find((model) => model.modelId === "claude-sonnet-4-5-20250929");
    expect(sonnet).toBeDefined();
    expect(sonnet!.contextLimit).not.toBeNull();
    expect(sonnet!.outputLimit).not.toBeNull();
    expect(sonnet!.contextLimit ?? 0).toBeGreaterThan(0);
    expect(sonnet!.outputLimit ?? 0).toBeGreaterThan(0);
  });

  /**
   * A provider's token refresher is what the 401 retry and the proactive sweep
   * call. Registering one where no refresh grant exists makes a recoverable
   * auth failure permanent (the retry calls a method that always throws);
   * omitting one where a grant exists leaves a short-lived token to expire
   * silently. Both directions are pinned here, at the layer that decides.
   */
  test("every OAuth provider registers a refresher exactly when it has a refresh grant", async () => {
    const registry = createDefaultProviderRegistry();
    // Short-lived access tokens re-minted from a durable grant.
    for (const id of ["claude", "codex", "grok", "antigravity", "muse", "kimi", "cline", "cb", "cbcn", "workbuddy", "github"]) {
      expect(await registry.resolveRefresher(id)).toBeDefined();
    }
    // The sign-in ends in a durable credential with no refresh grant: Kilo Code
    // (no token lifetime), OpenRouter (a durable API key), Zcode (a minted
    // Z.AI key, `refresh "none"`), and Devin.
    for (const id of ["kilo", "openrouter", "zcode", "devin"]) {
      expect(await registry.resolveRefresher(id)).toBeUndefined();
    }
  });
});
