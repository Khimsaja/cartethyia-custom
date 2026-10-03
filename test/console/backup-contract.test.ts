import { describe, expect, test } from "bun:test";
import { CONFIG_TABLES, ownershipOf, tableName, tablesForSection } from "../../src/console/backup/contracts";
import { DELETE_ALL_SCOPES, type DeleteAllScope } from "../../src/console/backup/store";

describe("backup contract coverage", () => {
  test("includes tenant-owned studio sessions in configuration", () => {
    expect(tablesForSection("config").map(tableName)).toContain("studio_sessions");
  });

  test("every config table has an ownership rule", () => {
    for (const table of CONFIG_TABLES) expect(() => ownershipOf(table)).not.toThrow();
  });

  test("delete scopes are represented as a narrow runtime union", () => {
    const scopes: readonly DeleteAllScope[] = DELETE_ALL_SCOPES;
    expect(scopes).toEqual(["providers", "proxies", "configuration"]);
  });
});
