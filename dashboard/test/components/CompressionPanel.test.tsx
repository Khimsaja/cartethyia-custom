import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CompressionPanel } from "../../src/components/CompressionPanel";
import { queryKeys } from "../../src/data/query-keys";
import type { RuntimeSettingsResponse } from "../../src/data/contracts";

const BASE: RuntimeSettingsResponse = {
  redisModeActual: "normal",
  tenantConcurrencyLimit: null,
  thinkingNormalizationEnabled: false,
  responsesReasoningSummary: "detailed",
  telemetryPayloads: "metadata",
  privacyMode: "masked",
  rtkPruneEnabled: false,
  rtkPruneLevel: "full",
  ponyTailEnabled: false,
  ponyTailLevel: "full",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function render(overrides: Partial<RuntimeSettingsResponse>): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(queryKeys.settings.runtime, { ...BASE, ...overrides });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(CompressionPanel)),
  );
}

describe("compression panel", () => {
  test("renders both controls with a strength dropdown and a toggle each", () => {
    const markup = render({});
    expect(markup).toContain("Prune tool output (RTK)");
    expect(markup).toContain("PonyTail (system directive)");
    // One dropdown + one switch per row, on the right.
    expect(markup).toContain('id="compression-rtk-level"');
    expect(markup).toContain('id="compression-ponytail-level"');
    expect(markup).toContain('id="compression-rtk"');
    expect(markup).toContain('id="compression-ponytail"');
  });

  test("shows no quality notice while both transforms are off", () => {
    const markup = render({});
    expect(markup).not.toContain("degraded quality");
  });

  test("shows the degraded-quality notice when RTK is on", () => {
    const markup = render({ rtkPruneEnabled: true });
    expect(markup).toContain("degraded quality");
  });

  test("shows the degraded-quality notice when PonyTail is on", () => {
    const markup = render({ ponyTailEnabled: true });
    expect(markup).toContain("degraded quality");
  });
});
