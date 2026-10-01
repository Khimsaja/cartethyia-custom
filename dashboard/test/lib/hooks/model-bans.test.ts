import { describe, expect, test } from "bun:test";

import { assertModelBans } from "../../../src/hooks/common";

describe("assertModelBans", () => {
  test("accepts a list of address bans and keeps the raw identity", () => {
    const result = assertModelBans({
      bans: [
        { ip: "203.0.113.7", expiresAt: 1_700_000_000_000 },
        { ip: "198.51.100.4", expiresAt: 1_700_000_600_000 },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.ip).toBe("203.0.113.7");
  });

  test("rejects a response that is not a ban list", () => {
    expect(() => assertModelBans({ bans: "none" })).toThrow("Invalid model ban response");
    expect(() => assertModelBans(null)).toThrow("Invalid model ban response");
  });

  test("rejects a row missing its address or lapse instant", () => {
    // The unban call is keyed on the address, so a row without one is unusable.
    expect(() => assertModelBans({ bans: [{ expiresAt: 1 }] })).toThrow("Invalid model ban response");
    expect(() => assertModelBans({ bans: [{ ip: "203.0.113.7" }] })).toThrow(
      "Invalid model ban response",
    );
    expect(() => assertModelBans({ bans: [{ ip: "203.0.113.7", expiresAt: "soon" }] })).toThrow(
      "Invalid model ban response",
    );
  });
});
