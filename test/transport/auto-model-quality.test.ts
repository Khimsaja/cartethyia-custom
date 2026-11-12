/**
 * Telemetry fold for pick quality: an explicit hasContent:false keeps an
 * event in the denominator but out of the quality numerator; a missing
 * signal fails open; `auto` traffic never votes for its own candidates.
 *
 * The data dir is resolved when `event-log` is first imported, so the
 * override has to be set before anything pulls it in — same pattern as
 * test/observability/telemetry-window.test.ts. Without this the test
 * would read (never write) the machine's real telemetry directory.
 */
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = await mkdtemp(join(tmpdir(), "carte-auto-quality-test-"));
process.env.CARTETHYIA_DATA_DIR = sandbox;

const { TELEMETRY_EVENT_DIR } = await import("../../src/observability/event-log");
const { pickAutoModel, readAutoModelStats } = await import("../../src/transport/routing/auto-model");

test("fold counts quality completions, fails open, and skips auto traffic", async () => {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const at = new Date(now - 5 * 60_000).toISOString();
  const old = new Date(now - 2 * 60 * 60_000).toISOString();
  const line = (model: string, status: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ createdAt: at, requestedModel: model, status, latencyMs: 100, ...extra });
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) lines.push(line("model-a", "completed", { hasContent: true }));
  for (let i = 0; i < 10; i++) lines.push(line("model-a", "completed", { hasContent: false }));
  for (let i = 0; i < 5; i++) lines.push(line("model-a", "failed"));
  for (let i = 0; i < 25; i++) lines.push(line("model-b", "completed"));
  for (let i = 0; i < 30; i++) lines.push(line("model-c", "completed", { hasContent: false }));
  for (let i = 0; i < 50; i++) lines.push(line("auto", "completed", { hasContent: true }));
  lines.push(JSON.stringify({ createdAt: old, requestedModel: "model-b", status: "completed" }));
  lines.push("{not json");
  try {
    await mkdir(TELEMETRY_EVENT_DIR, { recursive: true });
    await writeFile(join(TELEMETRY_EVENT_DIR, `${today}.events.jsonl`), `${lines.join("\n")}\n`);
    const stats = await readAutoModelStats(new Date(now - 60 * 60_000), now);
    expect(stats.get("model-a")).toEqual({ total: 45, completed: 40, qualityCompleted: 30, avgLatencyMs: 100 });
    expect(stats.get("model-b")).toEqual({ total: 25, completed: 25, qualityCompleted: 25, avgLatencyMs: 100 });
    expect(stats.get("model-c")).toEqual({ total: 30, completed: 30, qualityCompleted: 0, avgLatencyMs: 100 });
    expect(stats.has("auto")).toBe(false);
    expect(pickAutoModel(["model-a", "model-b", "model-c"], stats)).toBe("model-b");
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }
});
