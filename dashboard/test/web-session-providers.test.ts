import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Anchored to this file's location, not the process cwd: the runner
// (`scripts/test/run.ts`) executes with `cwd = dashboard/`, so a repo-relative
// path fails to resolve. One level up from `test/` is the dashboard root.
const pagePath = fileURLToPath(new URL("../src/features/providers/ProvidersPage.tsx", import.meta.url));

describe("web session provider section", () => {
  test("places web providers immediately after free limited providers", () => {
    const source = readFileSync(pagePath, "utf8");
    const freeAt = source.indexOf('title: "Free Limited Providers"');
    const webAt = source.indexOf('title: "Web Session Providers"');
    const oauthAt = source.indexOf('title: "OAuth & Agent Providers"');
    const wellKnownAt = source.indexOf('title: "Well Known API Key Providers"');
    const otherAt = source.indexOf('title: "Other API Key Providers"');
    expect(freeAt).toBeGreaterThan(0);
    expect(webAt).toBeGreaterThan(freeAt);
    expect(oauthAt).toBeGreaterThan(webAt);
    expect(wellKnownAt).toBeGreaterThan(oauthAt);
    expect(otherAt).toBeGreaterThan(wellKnownAt);
    expect(source).toContain('const WEB_LLM_IDS = new Set(["mimodesktop", "mimostudio"])');
    expect(source).toContain('  "alibabacp",');
    expect(source).toContain("function hasInteractiveOAuth(provider: ProviderResponse): boolean");
    expect(source).toContain("hasInteractiveOAuth(p)");
    expect(source).toContain("!WEB_LLM_IDS.has(p.providerId.toLowerCase())");
  });
});
