import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiKeyForm, keyCredentialFields, oneTimeSecretForMode } from "../../src/components/ApiKeyForm";
import { CLIENT_ROUTERS, TENANT_KEY_SCOPES, type ApiKeyResponse } from "../../src/data/contracts";

const shareRecord: ApiKeyResponse = {
  id: "parent-id", label: "Team share", keyMode: "share", scopes: [], createdAt: "2026-09-01T00:00:00.000Z", tokensConsumed: 0,
  sharePopupEnabled: true,
  sharePopupImageMime: "image/webp",
};
function render(mode: "create" | "edit", record: ApiKeyResponse | null): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ApiKeyForm, {
        mode,
        record,
        busy: false,
        onDone: () => undefined,
        onClose: () => undefined,
      }),
    ),
  );
}
describe("API key mode form", () => {
  test("personal creation retains custom-key input and one-time secret affordance", () => {
    const markup = render("create", null);
    expect(markup).toContain("Personal");
    expect(markup).toContain("Share template");
    expect(markup).toContain("Custom API key value (optional)");
  });

  test("share template create/edit never renders a raw-key input", () => {
    const createMarkup = render("create", shareRecord);
    const editMarkup = render("edit", shareRecord);
    expect(createMarkup).toContain("does not authenticate requests");
    expect(editMarkup).toContain("does not authenticate requests");
    expect(createMarkup).not.toContain("Custom API key value");
    expect(editMarkup).not.toContain("Custom API key value");
  });

  test("locks the credential mode when editing but not when creating", () => {
    const createMarkup = render("create", null);
    const editMarkup = render("edit", shareRecord);
    // Both mode buttons are disabled on an existing credential: the mode is
    // fixed once the key exists, so the edit form cannot convert it.
    const disabledButtons = (markup: string): number =>
      (markup.match(/disabled=""[^>]*>Personal<\/button>/) ? 1 : 0) +
      (markup.match(/disabled=""[^>]*>Share template<\/button>/) ? 1 : 0);
    expect(disabledButtons(createMarkup)).toBe(0);
    expect(disabledButtons(editMarkup)).toBe(2);
  });
  test("share submission omits a raw bearer value while personal submission can carry one", () => {
    const shareBody = JSON.stringify(keyCredentialFields("share", "never-send-this", "rk_"));
    const personalBody = JSON.stringify(keyCredentialFields("personal", "rk_personal-once", "rk_"));
    expect(shareBody).not.toContain("never-send-this");
    expect(shareBody).toContain('"keyMode":"share"');
    expect(personalBody).toContain('"key":"rk_personal-once"');
  });
  test("only personal creation or conversion exposes an optional one-time secret", () => {
    expect(oneTimeSecretForMode("personal", "rk_once")).toBe("rk_once");
    expect(oneTimeSecretForMode("share", "must-not-show")).toBeNull();
    expect(oneTimeSecretForMode("personal", undefined)).toBeNull();
  });
  test("normalizes a legacy OmniRoute denylist entry in the edit form", () => {
    const legacyRecord = {
      ...shareRecord,
      keyMode: "personal",
      clientRouterDenylist: ["omniroute"],
    } as unknown as ApiKeyResponse;
    const markup = render("edit", legacyRecord);
    expect(markup).toContain('aria-label="Block 9Router and OmniRoute client"');
    expect(markup).toContain('aria-checked="true"');
  });

  test("collapses the popup editor until the enable toggle is on", () => {
    const popupRecord: ApiKeyResponse = {
      ...shareRecord,
      sharePopupEnabled: true,
      sharePopupImageMime: "image/webp",
    };
    // Create defaults to off: the toggle shows but the fields do not.
    const createMarkup = render("create", null);
    expect(createMarkup).toContain("Share page popup");
    expect(createMarkup).toContain("Enable popup");
    expect(createMarkup).not.toContain("Popup title");
    expect(createMarkup).not.toContain('id="share-popup-copy"');
    // An enabled record expands the editor with its fields and stored image.
    const editMarkup = render("edit", popupRecord);
    expect(editMarkup).toContain("Popup title");
    expect(editMarkup).toContain("Message");
    expect(editMarkup).toContain("/console/api/api-keys/parent-id/share-popup-image");
    // The popup has no action button: no label or URL inputs exist.
    expect(editMarkup).not.toContain("Button label");
    expect(editMarkup).not.toContain("Button URL");
  });
  test("renders remote-routing switches per remote tool in edit mode only", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Seed the cache so the section has registry + mapping data to render from
    // without a fetch (static markup does not run effects).
    client.setQueryData(["console", "cli-tools", "registry"], [
      { id: "claude", name: "Claude Code", mappingSupported: true },
      { id: "codex", name: "Codex", mappingSupported: true },
      { id: "qwen", name: "Qwen", mappingSupported: false },
    ]);
    client.setQueryData(["console", "cli-tools", "claude", "parent-id", "mappings"], {
      toolId: "claude", tenantId: "t", apiKeyId: "parent-id", enabled: true,
      mappings: [{ slotKey: "sonnet", sourceModel: "sonnet", targetModel: "x", enabled: true }],
    });
    client.setQueryData(["console", "cli-tools", "codex", "parent-id", "mappings"], {
      toolId: "codex", tenantId: "t", apiKeyId: "parent-id", enabled: false, mappings: [],
    });
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ApiKeyForm, {
          mode: "edit",
          record: shareRecord,
          busy: false,
          onDone: () => undefined,
          onClose: () => undefined,
        }),
      ),
    );
    expect(markup).toContain("Remote routing");
    expect(markup).toContain("Enable remote routing for Claude Code");
    expect(markup).toContain("Enable remote routing for Codex");
    // Guide-only tools expose no persisted mapping surface, so no switch.
    expect(markup).not.toContain("Enable remote routing for Qwen");
    // The scope is folded into the Remote routing switch: it is not a separate
    // grant row any more. This record carries no routing:cli_mapping scope, so
    // the merged switch reads off even though the route row exists.
    expect(markup).not.toContain('aria-label="Grant routing:cli_mapping"');
    expect(markup).toContain("Remote routing off");
  });

  test("renders descriptive router and scope switches without provider allowlist", () => {
    const markup = render("create", null);
    expect(markup).toContain("Blocked client routers");
    expect(markup).toContain("Matching fingerprints are rejected with 403 before routing.");
    expect(markup).toContain("clients without a fingerprint are not matched.");
    expect(markup).toContain("bazaar probe links");
    for (const router of CLIENT_ROUTERS) {
      expect(markup).toContain(`aria-label="Block ${router.label} client"`);
      expect(markup).toContain(`Block ${router.label} Client`);
    }
    expect(markup).toContain("Routing");
    expect(markup).toContain("Dashboard / Resources");
    // routing:invoke stays a standalone grant; routing:cli_mapping is merged
    // into the Remote routing control, so only the former renders here.
    expect(markup).toContain('aria-label="Grant routing:invoke"');
    expect(markup).not.toContain('aria-label="Grant routing:cli_mapping"');
    for (const scope of TENANT_KEY_SCOPES.filter((s) => !s.startsWith("routing:"))) {
      expect(markup).toContain(`aria-label="Grant ${scope}"`);
    }
    expect(markup).toContain("Call /v1/* gateway routes within this tenant.");
    expect(markup).not.toContain("providerAllowlist");
    expect(markup).not.toContain("Provider allowlist");
  });
});
