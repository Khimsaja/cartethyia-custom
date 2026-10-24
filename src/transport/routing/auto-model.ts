/**
 * "auto" model: resolve a request for the literal model name `auto` to the
 * most stable model on the caller's own allowlist, from recent gateway
 * telemetry.
 *
 * Safety properties, by construction:
 * - Candidates come ONLY from the key's explicit whitelist. A blacklist key
 *   or a whitelist key with an empty list (which means "allow everything")
 *   cannot use auto: there is no bounded candidate set to choose from, and
 *   guessing one would let auto reach models the operator never listed.
 * - The pick is advisory input to the normal pipeline, not a bypass. The
 *   preparer rewrites the request model to the pick BEFORE the allowlist
 *   check, so the resolved model is authorized exactly like a request that
 *   named it directly. Nothing downstream knows auto existed.
 * - Telemetry is read from the gateway's own day files, cached for 60s, so
 *   an auto request never pays a file scan per request.
 * - Events whose requested model is `auto` itself are skipped, so auto
 *   traffic can never vote for its own candidates.
 *
 * Gated by CARTETHYIA_AUTO_MODEL_ENABLED=1 (default off). Test-only until
 * an operator enables it on a deployment.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { TELEMETRY_EVENT_DIR } from "../../observability/event-log";
import { log } from "../../observability/logger";

/** The literal model name a client requests to trigger auto resolution. */
export const AUTO_MODEL_NAME = "auto";

/** How far back stability is measured. */
export const AUTO_MODEL_WINDOW_MS = 60 * 60 * 1000;

/** Minimum requests a model needs in the window to be pickable. */
export const AUTO_MODEL_MIN_SAMPLES = 20;

/** How long a scanned telemetry snapshot is reused. */
export const AUTO_MODEL_CACHE_MS = 60_000;

export function isAutoModelEnabled(): boolean {
  const value = process.env.CARTETHYIA_AUTO_MODEL_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export interface AutoModelStats {
  readonly total: number;
  readonly completed: number;
  readonly avgLatencyMs: number | null;
}

function emptyStats(): { total: number; completed: number; latencySum: number; latencyCount: number } {
  return { total: 0, completed: 0, latencySum: 0, latencyCount: 0 };
}

/**
 * Pure pick: highest success rate wins; ties break on lower average
 * latency, then on higher volume. Models below the sample floor are never
 * picked. Returns null when no candidate has usable data.
 */
export function pickAutoModel(
  candidates: readonly string[],
  stats: ReadonlyMap<string, AutoModelStats>,
): string | null {
  let best: string | null = null;
  let bestRate = -1;
  let bestLatency = Number.POSITIVE_INFINITY;
  let bestTotal = -1;
  for (const candidate of candidates) {
    const entry = stats.get(candidate);
    if (!entry || entry.total < AUTO_MODEL_MIN_SAMPLES) continue;
    const rate = entry.completed / entry.total;
    const latency = entry.avgLatencyMs ?? Number.POSITIVE_INFINITY;
    if (
      rate > bestRate ||
      (rate === bestRate && latency < bestLatency) ||
      (rate === bestRate && latency === bestLatency && entry.total > bestTotal)
    ) {
      best = candidate;
      bestRate = rate;
      bestLatency = latency;
      bestTotal = entry.total;
    }
  }
  return best;
}

interface RawTelemetryLine {
  readonly createdAt?: unknown;
  readonly requestedModel?: unknown;
  readonly status?: unknown;
  readonly latencyMs?: unknown;
}

function utcDatePrefix(offsetDays: number, now: number): string {
  const date = new Date(now + offsetDays * 24 * 60 * 60_000);
  return date.toISOString().slice(0, 10);
}

/**
 * Scans today's and yesterday's (UTC) telemetry day/hour files and folds
 * terminal events in the window into per-model stats. Files the gateway
 * never wrote are skipped silently; a partially written final line is
 * skipped rather than failing the whole scan.
 */
export async function readAutoModelStats(
  since: Date,
  now: number = Date.now(),
): Promise<ReadonlyMap<string, AutoModelStats>> {
  const sinceMs = since.getTime();
  const prefixes = [utcDatePrefix(0, now), utcDatePrefix(-1, now)];
  const folded = new Map<string, { total: number; completed: number; latencySum: number; latencyCount: number }>();
  let files: string[] = [];
  try {
    files = (await readdir(TELEMETRY_EVENT_DIR)).filter(
      (file) =>
        file.endsWith(".jsonl") &&
        !file.endsWith(".compacted.jsonl") &&
        prefixes.some((prefix) => file.startsWith(prefix)),
    );
  } catch {
    return new Map<string, AutoModelStats>();
  }
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(join(TELEMETRY_EVENT_DIR, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      let raw: RawTelemetryLine;
      try {
        raw = JSON.parse(line) as RawTelemetryLine;
      } catch {
        continue;
      }
      if (typeof raw.createdAt !== "string") continue;
      const at = new Date(raw.createdAt).getTime();
      if (!Number.isFinite(at) || at < sinceMs) continue;
      if (typeof raw.requestedModel !== "string" || raw.requestedModel.length === 0) continue;
      if (raw.requestedModel === AUTO_MODEL_NAME) continue;
      if (
        raw.status !== "completed" &&
        raw.status !== "failed" &&
        raw.status !== "cancelled" &&
        raw.status !== "truncated"
      ) {
        continue;
      }
      const bucket = folded.get(raw.requestedModel) ?? emptyStats();
      bucket.total += 1;
      if (raw.status === "completed") bucket.completed += 1;
      if (typeof raw.latencyMs === "number" && Number.isFinite(raw.latencyMs)) {
        bucket.latencySum += raw.latencyMs;
        bucket.latencyCount += 1;
      }
      folded.set(raw.requestedModel, bucket);
    }
  }
  const stats = new Map<string, AutoModelStats>();
  for (const [model, bucket] of folded) {
    stats.set(model, {
      total: bucket.total,
      completed: bucket.completed,
      avgLatencyMs: bucket.latencyCount > 0 ? bucket.latencySum / bucket.latencyCount : null,
    });
  }
  return stats;
}

export type AutoPick =
  | { readonly ok: true; readonly model: string }
  | { readonly ok: false; readonly reason: "no_allowlist" | "no_data" };

export interface AutoModelPolicy {
  readonly model_access_mode?: string | null | undefined;
  readonly model_list?: readonly string[] | ReadonlySet<string> | null | undefined;
}

/** Cached telemetry reader + picker. One instance per gateway process. */
export class AutoModelScorer {
  private cached: { readonly at: number; readonly stats: ReadonlyMap<string, AutoModelStats> } | null = null;

  async pickForKey(policy: AutoModelPolicy, now: number = Date.now()): Promise<AutoPick> {
    if (policy.model_access_mode === "blacklist") return { ok: false, reason: "no_allowlist" };
    const list =
      policy.model_list == null
        ? []
        : policy.model_list instanceof Set
          ? [...policy.model_list]
          : [...policy.model_list];
    if (list.length === 0) return { ok: false, reason: "no_allowlist" };
    if (this.cached === null || now - this.cached.at >= AUTO_MODEL_CACHE_MS) {
      const stats = await readAutoModelStats(new Date(now - AUTO_MODEL_WINDOW_MS), now);
      this.cached = { at: now, stats };
    }
    const picked = pickAutoModel(list, this.cached.stats);
    if (picked === null) return { ok: false, reason: "no_data" };
    log.info("[routing] auto model resolved", {
      picked,
      candidates: list.length,
      total: this.cached.stats.get(picked)?.total ?? 0,
      completed: this.cached.stats.get(picked)?.completed ?? 0,
    });
    return { ok: true, model: picked };
  }
}
