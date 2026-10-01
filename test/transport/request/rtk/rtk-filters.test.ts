import { describe, expect, test } from "bun:test";
import {
  autoDetectFilter,
  dedupLogFilter,
  gitDiffFilter,
  grepFilter,
  safeApplyFilter,
  smartTruncateFilter,
} from "../../../../src/transport/request/rtk/rtk-filters";

describe("rtk filters", () => {
  test("grep dump is grouped by file with a header", () => {
    const input = [
      "src/a.ts:10:const x = 1;",
      "src/a.ts:11:const y = 2;",
      "src/b.ts:3:hello",
    ].join("\n");
    const out = grepFilter(input);
    expect(out).toContain("3 matches in 2 files");
    expect(out).toContain("src/a.ts (2)");
    expect(out).toContain("  10: const x = 1;");
  });

  test("git diff keeps per-file headers and +/- counts", () => {
    const input = [
      "diff --git a/x.ts b/x.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      " context",
    ].join("\n");
    const out = gitDiffFilter(input);
    expect(out).toContain("x.ts");
    expect(out).toContain("+1 -1");
  });

  test("dedup log collapses consecutive duplicate lines", () => {
    const out = dedupLogFilter(["a", "a", "a", "b"].join("\n"));
    expect(out).toContain("a");
    expect(out).toContain("(2 duplicate lines)");
  });

  test("safeApplyFilter falls back to raw text when a filter grows the input", () => {
    const grower = ((input: string) => `${input}${input}`) as never;
    expect(safeApplyFilter(grower, "abc")).toBe("abc");
  });

  test("safeApplyFilter falls back when a filter throws", () => {
    const thrower = (() => {
      throw new Error("boom");
    }) as never;
    expect(safeApplyFilter(thrower, "abc")).toBe("abc");
  });

  test("safeApplyFilter rejects an empty result", () => {
    const emptier = (() => "") as never;
    expect(safeApplyFilter(emptier, "abc")).toBe("abc");
  });

  test("autodetect routes a git log to the log filter and a plain blob to none", () => {
    expect(autoDetectFilter("commit abcdef1\nAuthor: me")?.filterName).toBe("git-log");
    expect(autoDetectFilter("just a short line")).toBeNull();
  });

  test("smart truncate keeps head and tail and elides the middle", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    const out = smartTruncateFilter(lines.join("\n"));
    expect(out).toContain("line 0");
    expect(out).toContain("line 399");
    expect(out).toContain("lines truncated");
  });
});
