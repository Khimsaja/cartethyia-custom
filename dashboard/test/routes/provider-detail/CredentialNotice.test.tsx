import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CredentialNotice } from "../../../src/routes/provider-detail/CredentialNotice";
import type { ProviderResponse } from "../../../src/data/contracts";

function provider(overrides: Partial<ProviderResponse> = {}): ProviderResponse {
  return {
    providerId: "mistral",
    enabled: true,
    isBuiltIn: true,
    requiresAccount: true,
    hasAdapterUserAgent: false,
    supportsModelDiscovery: false,
    ...overrides,
  };
}

describe("CredentialNotice", () => {
  test("renders the guidance and a Get API Key action for a key-based provider", () => {
    const html = renderToStaticMarkup(
      <CredentialNotice provider={provider({ credentialUrl: "https://console.mistral.ai/api-keys" })} />,
    );
    expect(html).toContain("Create a credential on the provider site");
    expect(html).toContain("Get API Key");
    expect(html).not.toContain("Sign in");
  });

  test("prefers the provider's own hint over the derived default", () => {
    const html = renderToStaticMarkup(
      <CredentialNotice
        provider={provider({
          credentialUrl: "https://aistudio.xiaomimimo.com",
          credentialHint: "Paste the browser cookies exported from a signed-in session.",
        })}
      />,
    );
    expect(html).toContain("Paste the browser cookies exported from a signed-in session.");
    expect(html).not.toContain("Create a credential on the provider site");
  });

  test("labels the action Sign in when the provider authorizes through a login flow", () => {
    const html = renderToStaticMarkup(
      <CredentialNotice
        provider={provider({
          providerId: "claude",
          credentialUrl: "https://claude.ai",
          oauthFlows: {
    browser: true,
    device: false,
    import: false,
    browserLoginFields: [],
    deviceLoginFields: [],
    importFields: [],
  },
        })}
      />,
    );
    expect(html).toContain("Sign in");
    expect(html).not.toContain("Get API Key");
    expect(html).toContain("authorizes through its own login flow");
  });

  test("renders nothing when the provider declares no credential page or hint", () => {
    expect(renderToStaticMarkup(<CredentialNotice provider={provider()} />)).toBe("");
  });
});
