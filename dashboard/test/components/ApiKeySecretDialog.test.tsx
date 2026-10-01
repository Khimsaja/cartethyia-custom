import { describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("../../src/components/ui/dialog", () => ({
  Dialog: ({
    open,
    title,
    width,
    children,
  }: {
    open: boolean;
    title: string;
    width?: number;
    children: ReactNode;
  }) =>
    open
      ? createElement(
          "section",
          { "data-title": title, "data-width": width },
          children,
        )
      : null,
}));

const { ApiKeySecretDialog } = await import("../../src/components/ApiKeySecretDialog");

describe("ApiKeySecretDialog", () => {
  test("shows the one-time secret with copy and save affordances", () => {
    const markup = renderToStaticMarkup(
      createElement(ApiKeySecretDialog, { secret: "ctk_live_secret_123", onClose: () => undefined }),
    );

    expect(markup).toContain("New API key");
    expect(markup).toContain("ctk_live_secret_123");
    expect(markup).toContain("Copy key");
    expect(markup).toContain("Save this key");
    // The operator must be told the secret is not shown again.
    expect(markup).toContain("never shows it again");
  });

  test("renders nothing when there is no secret to reveal", () => {
    const markup = renderToStaticMarkup(
      createElement(ApiKeySecretDialog, { secret: null, onClose: () => undefined }),
    );
    expect(markup).toBe("");
  });
});
