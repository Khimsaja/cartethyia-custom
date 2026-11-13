/**
 * Public network statistics for buyer-facing surfaces (e.g. the TipRouter
 * website's live stats section).
 *
 * Aggregate-only by design: the response carries totals and per-model
 * breakdowns, never per-key, per-IP, per-client, or cost data. Results are
 * cached in-process for 30 seconds so public traffic never hammers the
 * telemetry tables (the underlying aggregates run in SQL, ~25ms on an index).
 */
import { and, eq, isNull } from "drizzle-orm";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { apiKeys, modelTemplates } from "../persistence/schema";
import { publicNetworkStats } from "../observability/event-query";

export interface PublicModelStat {
  readonly model: string;
  readonly hits: number;
  readonly ok: number;
  /** input + output tokens in the 24h window */
  readonly tokens: number;
}

/** Per-model health over the last hour — feeds the public /status page. */
export interface PublicModelHealth {
  readonly model: string;
  readonly hits: number;
  readonly ok: number;
}

export interface PublicNetworkStats {
  /** Rolling window the numbers cover. */
  readonly window: "24h";
  /** Requests in the window, excluding 429 rate-limit rejections and 499
   * client aborts (both buyer-side, not gateway/upstream errors). */
  readonly requests: number;
  /** Requests that completed successfully. */
  readonly ok: number;
  /** ok / requests, 0..1 (0 when no requests). */
  readonly success_rate: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly top_models: readonly PublicModelStat[];
  /**
   * Per-model request health over the last 60 minutes (all models with
   * traffic, no top-N cut). Used by the public status page; aggregate-only
   * like everything else here.
   */
  readonly model_health_1h: readonly PublicModelHealth[];
  readonly generated_at: string;
}

/** Public cache TTL: matches the website's 30s refresh cadence. */
export const PUBLIC_STATS_CACHE_TTL_MS = 30_000;

/** Buyer template whose model list defines the public status page catalog. */
export const BUYER_TEMPLATE_NAME = "tiprouter new";

let cached: { data: PublicNetworkStats; expiresAt: number } | null = null;
let inflight: Promise<PublicNetworkStats> | null = null;

async function resolveAllowlist(
  db: CartethyiaDatabase,
  tenantId: string,
): Promise<readonly string[]> {
  // Buyer model allowlist: the 'tiprouter new' template's model list.
  // Status page is buyer-facing: only show models buyers actually get.
  // Unioning every active whitelist key's model_list leaked infra-only
  // models onto the page (MASTER KEY and admin keys carry models that are
  // not in the buyer template). Fall back to that union only if the
  // template is missing/empty, so the page never goes blank on a rename.
  const [template] = await db
    .select({ models: modelTemplates.models })
    .from(modelTemplates)
    .where(
      and(
        eq(modelTemplates.tenantId, tenantId),
        eq(modelTemplates.name, BUYER_TEMPLATE_NAME),
      ),
    )
    .limit(1);
  const fromTemplate = template?.models ?? [];
  if (fromTemplate.length > 0) return fromTemplate;
  const rows = await db
    .select({ modelList: apiKeys.modelList })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.tenantId, tenantId),
        eq(apiKeys.modelAccessMode, "whitelist"),
        eq(apiKeys.enabled, true),
        isNull(apiKeys.revokedAt),
      ),
    );
  const allowlist = new Set<string>();
  for (const row of rows) {
    for (const model of row.modelList ?? []) {
      if (typeof model === "string" && model) allowlist.add(model);
    }
  }
  return [...allowlist];
}

async function queryPublicNetworkStats(
  db: CartethyiaDatabase,
  tenantId: string,
): Promise<PublicNetworkStats> {
  const now = Date.now();
  const since24h = new Date(now - 24 * 3600 * 1000);
  const since1h = new Date(now - 3600 * 1000);
  const allowlist = await resolveAllowlist(db, tenantId);
  const agg = await publicNetworkStats(db, tenantId, since24h, since1h, allowlist);
  return {
    window: "24h",
    requests: agg.requests,
    ok: agg.ok,
    success_rate: agg.requests > 0 ? agg.ok / agg.requests : 0,
    input_tokens: agg.inputTokens,
    output_tokens: agg.outputTokens,
    top_models: agg.topModels,
    model_health_1h: agg.modelHealth1h,
    generated_at: new Date().toISOString(),
  };
}

/** Clears the in-process cache. Exported for tests and operational use. */
export function clearPublicNetworkStatsCache(): void {
  cached = null;
  inflight = null;
}

/** Cached public stats; concurrent callers share one in-flight refresh. */
export async function getPublicNetworkStats(
  db: CartethyiaDatabase,
  tenantId: string,
): Promise<PublicNetworkStats> {
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  if (inflight) return inflight;
  inflight = (async () => {
    const data = await queryPublicNetworkStats(db, tenantId);
    // Expiry is stamped AFTER the refresh completes. The scan can take
    // longer than the TTL itself at production data volumes; stamping it
    // from the pre-scan clock made every entry expire before it was ever
    // served, so the cache never hit and every caller paid a full scan.
    cached = { data, expiresAt: Date.now() + PUBLIC_STATS_CACHE_TTL_MS };
    return data;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
