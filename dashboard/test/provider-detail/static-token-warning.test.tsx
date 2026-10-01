import { describe, expect, test } from "bun:test";
import { staticTokenWarning } from "../../src/routes/provider-detail/Accounts";

/**
 * Flipping the static-token flag is consequential in both directions, so the
 * row button must confirm either way rather than applying one arm on a single
 * click. Enabling stops refreshing (death at token expiry); disabling hands the
 * credential back to the OAuth sweep, which fails for a pasted token with no
 * working grant. The two directions must not share copy.
 */
describe("staticTokenWarning", () => {
  test("enabling warns that refreshing stops and the account dies at expiry", () => {
    const warning = staticTokenWarning(true, "main");
    expect(warning.title).toContain("static token");
    expect(warning.message).toContain("main");
    expect(warning.message).toContain("stop refreshing");
    expect(warning.confirmLabel).toBe("Mark as static token");
  });

  test("disabling warns that the OAuth sweep takes over and may fail", () => {
    const warning = staticTokenWarning(false, "main");
    expect(warning.title).toContain("refresh");
    expect(warning.message).toContain("main");
    // The other arm's consequence must not leak in: re-enabling refresh does
    // not itself stop refreshing.
    expect(warning.message).not.toContain("stop refreshing");
    expect(warning.confirmLabel).toBe("Re-enable refresh");
  });

  test("the two directions carry distinct titles and confirm labels", () => {
    const on = staticTokenWarning(true, "main");
    const off = staticTokenWarning(false, "main");
    expect(on.title).not.toBe(off.title);
    expect(on.confirmLabel).not.toBe(off.confirmLabel);
  });
});
