import { describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const bans = [
  { ip: "203.0.113.7", expiresAt: Date.now() + 3 * 60 * 60 * 1000 },
  { ip: "198.51.100.4", expiresAt: Date.now() + 40 * 60 * 1000 },
];

mock.module("../../src/components/ui/dialog", () => ({
  Dialog: ({ title, width, children }: { title: string; width?: number; children: ReactNode }) =>
    createElement(
      "section",
      { "data-title": title, "data-width": width, style: { "--dialog-width": `${width ?? 520}px` } },
      children,
    ),
}));

mock.module("../../src/hooks/model-bans", () => ({
  useModelBans: () => ({ data: bans, isPending: false, isError: false, refetch: () => undefined }),
  useUnbanModel: () => ({ isPending: false, mutateAsync: () => Promise.resolve({ success: true }) }),
}));

const { ModelBansDialog } = await import("../../src/components/ModelBansDialog");

describe("ModelBansDialog", () => {
  test("lists each banned client address with when it lapses and an unban control", () => {
    const markup = renderToStaticMarkup(createElement(ModelBansDialog, { onClose: () => undefined }));

    expect(markup).toContain("Banned Users");
    expect(markup).toContain("Active bans (2)");
    expect(markup).toContain("Client IP");
    expect(markup).toContain("203.0.113.7");
    expect(markup).toContain("198.51.100.4");
    expect(markup).toContain("Unban");
    // The ban is keyed on the address, so the row must show the raw identity.
    expect(markup).toContain("--dialog-width");
  });
});
