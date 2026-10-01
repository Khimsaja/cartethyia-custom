import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import Combos from "../../src/routes/Combos";
import { queryKeys } from "../../src/data/query-keys";
import type { ModelComboRow } from "../../src/data/contracts";

function combo(name: string, members: readonly string[]): ModelComboRow {
  return {
    id: `combo-${name}`,
    tenantId: "tenant-1",
    name,
    members: [...members],
    strategy: "fallback",
    contextLimit: 200_000,
    outputLimit: 64_192,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as ModelComboRow;
}

function render(combos: readonly ModelComboRow[]): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(queryKeys.modelRouting.combos, combos);
  queryClient.setQueryData(queryKeys.modelRouting.aliases, []);
  queryClient.setQueryData(queryKeys.providers.all, []);
  queryClient.setQueryData(["console", "models", "all"], []);
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(Combos)),
  );
}

describe("combos page", () => {
  test("shows at most four member chips, then a +N more note", () => {
    const markup = render([
      combo("pool", ["m1", "m2", "m3", "m4", "m5", "m6"]),
    ]);
    // The first four members render as chips; the remaining two collapse.
    expect(markup).toContain("m1");
    expect(markup).toContain("m4");
    expect(markup).toContain("+2 more models");
    // A fifth member never gets its own chip.
    expect(markup).not.toContain(">m5<");
  });

  test("shows every chip when a combo has four or fewer members", () => {
    const markup = render([combo("small", ["a", "b", "c"])]);
    expect(markup).toContain("a");
    expect(markup).toContain("b");
    expect(markup).toContain("c");
    expect(markup).not.toContain("more models");
  });

  test("offers a clone control on each combo row", () => {
    const markup = render([combo("pool", ["m1"])]);
    expect(markup).toContain("Clone combo (same members and strategy)");
  });
});
