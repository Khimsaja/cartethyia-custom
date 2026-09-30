import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  VERSION_SOURCES,
  _resetKiroVersion,
  getKiroVersion,
  resolveKiroVersion,
} from "../../../../src/providers/operations/client-versions";
import { kiroHeaders } from "../../../../src/providers/integrations/kiro/kiro";

describe("Kiro IDE client version", () => {
  beforeEach(() => _resetKiroVersion());
  afterEach(() => _resetKiroVersion());

  test("uses the pinned current IDE version before discovery", () => {
    expect(VERSION_SOURCES.kiro.fallback).toBe("1.2.4");
    expect(getKiroVersion()).toBe(VERSION_SOURCES.kiro.fallback);
  });

  test("discovers the current version from the official downloads page and uses it in Kiro headers", async () => {
    let requestedUrl = "";
    const fetcher = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(String.raw`<script>\"currentVersion\":\"1.1.71\"</script>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const machineId = "b".repeat(64);
    expect(await resolveKiroVersion(fetcher)).toBe("1.1.71");
    expect(requestedUrl).toBe(VERSION_SOURCES.kiro.sources[0]?.url);
    const headers = kiroHeaders("token", { authMethod: "builder-id", region: "us-east-1", machineId }, machineId);
    expect(headers["user-agent"]).toContain(`KiroIDE-1.1.71-${machineId}`);
    expect(headers["x-amz-user-agent"]).toBe(`aws-sdk-js/1.0.39 KiroIDE-1.1.71-${machineId}`);
  });
});
