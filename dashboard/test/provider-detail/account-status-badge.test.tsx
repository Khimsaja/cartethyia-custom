import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountStatusBadge } from "../../src/routes/provider-detail/Accounts";
import type { ProviderAccountResponse } from "../../src/data/contracts";

/**
 * Disabling an account is not recovery: the backend deliberately preserves
 * `modelCooldowns` (`providers/catalog/store.ts` — only replacing the credential
 * clears failure state). The badge checked `disabled` first and returned after
 * the status and error-category chips, so the per-model backoffs vanished and the
 * operator lost the account's last known health.
 */
describe("AccountStatusBadge", () => {
  const inMinutes = (minutes: number): string =>
    new Date(Date.now() + minutes * 60_000).toISOString();

  const account = (overrides: Partial<ProviderAccountResponse>): ProviderAccountResponse => ({
    id: "acct-1",
    providerId: "opencodeft",
    tenantId: null,
    label: "main",
    credentialKind: "oauth",
    status: "active",
    usageToday: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    usageAllTime: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    createdAt: new Date().toISOString(),
    sortIndex: 0,
    ...overrides,
  });

  const text = (overrides: Partial<ProviderAccountResponse>): string =>
    renderToStaticMarkup(createElement(AccountStatusBadge, { account: account(overrides) }));

  test("a disabled account keeps showing its per-model backoffs", () => {
    const html = text({
      status: "disabled",
      modelCooldowns: { "slow-model": inMinutes(240), "quick-model": inMinutes(11) },
    });
    expect(html).toContain("Disabled");
    expect(html).toContain("2 models cooling");
    // The countdown is what the operator can act on, so it must be rendered.
    expect(html).toContain("11m");
  });

  test("an active account still shows its per-model backoffs", () => {
    const html = text({ modelCooldowns: { "m-1": inMinutes(11) } });
    expect(html).toContain("Active");
    expect(html).toContain("1 model cooling");
  });

  test("a cooling account keeps its per-model backoffs beside the account-wide one", () => {
    const html = text({
      status: "cooldown",
      cooldownUntil: inMinutes(30),
      modelCooldowns: { "m-1": inMinutes(11) },
    });
    expect(html).toContain("Cooldown");
    expect(html).toContain("1 model cooling");
  });

  test("no cooling chip when no backoff is in force", () => {
    expect(text({ status: "disabled" })).not.toContain("cooling");
  });
});
