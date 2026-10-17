/**
 * Public network statistics for buyer-facing surfaces (e.g. the TipRouter
 * website's live stats section).
 *
 * Aggregate-only by design: the response carries totals and per-model
 * breakdowns, never per-key, per-IP, per-client, or cost data. Results are
 * cached in-process for 60 seconds so public traffic never hammers the
 * telemetry tables (the underlying queries run in ~25ms on an index).
 */
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { decryptCredentialToString } from "../security/crypto";

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
  /** Requests in the window, excluding 429 rate-limit rejections (client-side throttling, not errors). */
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

const TOP_MODELS_LIMIT = 10;

let cached: { data: PublicNetworkStats; expiresAt: number } | null = null;

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

const toNumber = (value: unknown): number => {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : 0;
};

async function queryPublicNetworkStats(db: CartethyiaDatabase): Promise<PublicNetworkStats> {
  const totals = rowsOf(
    await db.execute(
      "SELECT COUNT(*) FILTER (WHERE http_status IS DISTINCT FROM 429) AS requests, " +
        "COUNT(*) FILTER (WHERE status = 'completed' AND http_status IS DISTINCT FROM 429) AS ok, " +
        "COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens, " +
        "COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens " +
        "FROM telemetry_events WHERE created_at > NOW() - INTERVAL '24 hours'",
    ),
  )[0] ?? {};
  const topRows = rowsOf(
    await db.execute(
      "SELECT requested_model AS model, COUNT(*) FILTER (WHERE http_status IS DISTINCT FROM 429) AS hits, " +
        "COUNT(*) FILTER (WHERE status = 'completed' AND http_status IS DISTINCT FROM 429) AS ok, " +
        "COALESCE(SUM(input_tokens), 0)::bigint + COALESCE(SUM(output_tokens), 0)::bigint AS tokens " +
        "FROM telemetry_events WHERE created_at > NOW() - INTERVAL '24 hours' " +
        `GROUP BY requested_model ORDER BY hits DESC LIMIT ${TOP_MODELS_LIMIT}`,
    ),
  );
  const healthRows = rowsOf(
    await db.execute(
      "SELECT requested_model AS model, COUNT(*) FILTER (WHERE http_status IS DISTINCT FROM 429) AS hits, " +
        "COUNT(*) FILTER (WHERE status = 'completed' AND http_status IS DISTINCT FROM 429) AS ok " +
        "FROM telemetry_events WHERE created_at > NOW() - INTERVAL '1 hour' " +
        // Status page is buyer-facing: only models in the buyer template
        // ('tiprouter new'). Infra keys and the playground can hit other
        // models; those must not appear here.
        "AND requested_model IN (SELECT jsonb_array_elements_text(models) " +
        "FROM model_templates WHERE id = 'f1deb75d-80a4-4826-824b-43aaacd4e39f') " +
        "GROUP BY requested_model ORDER BY hits DESC",
    ),
  );
  const requests = toNumber(totals.requests);
  const ok = toNumber(totals.ok);
  return {
    window: "24h",
    requests,
    ok,
    success_rate: requests > 0 ? ok / requests : 0,
    input_tokens: toNumber(totals.input_tokens),
    output_tokens: toNumber(totals.output_tokens),
    top_models: topRows.map((row) => ({
      model: typeof row.model === "string" && row.model ? row.model : "unknown",
      hits: toNumber(row.hits),
      ok: toNumber(row.ok),
      tokens: toNumber(row.tokens),
    })),
    model_health_1h: healthRows.map((row) => ({
      model: typeof row.model === "string" && row.model ? row.model : "unknown",
      hits: toNumber(row.hits),
      ok: toNumber(row.ok),
    })),
    generated_at: new Date().toISOString(),
  };
}

/** Clears the in-process cache. Exported for tests and operational use. */
export function clearPublicNetworkStatsCache(): void {
  cached = null;
}

/** Cached public stats; concurrent callers share one in-flight refresh. */
export async function getPublicNetworkStats(db: CartethyiaDatabase): Promise<PublicNetworkStats> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.data;
  const data = await queryPublicNetworkStats(db);
  cached = { data, expiresAt: now + PUBLIC_STATS_CACHE_TTL_MS };
  return data;
}

/**
 * Label of the public shared bansos key: one key for everyone, restricted to
 * deepseek-v-4.1-flash with a 3B lifetime token budget. Displayed on the
 * TipRouter landing page with a usage progress bar.
 *
 * NOTE: the key-template sweep must never touch this key (it is intentionally
 * NOT linked to the buyer template and its model_list is a single model).
 */
export const BANSOS_DEEPSEEK_KEY_LABEL = "bansos-deepseek-3b";
export const BANSOS_DEEPSEEK_MODEL = "deepseek-v-4.1-flash";
export const BANSOS_DEEPSEEK_BASE_URL = "https://tiprouter.my.id/v1";

export interface BansosDeepseekStatus {
  /** The shared secret itself — public by design, shown on the landing page. */
  readonly key: string;
  readonly base_url: string;
  readonly model: string;
  readonly used_tokens: number;
  readonly budget_tokens: number;
  readonly active: boolean;
}

/**
 * Public status of the shared bansos key. Returns null when the key does not
 * exist (yet). Single indexed row lookup; no cache needed.
 */
export async function getBansosDeepseekStatus(
  db: CartethyiaDatabase,
): Promise<BansosDeepseekStatus | null> {
  const rows = rowsOf(
    await db.execute(
      "SELECT key_encrypted, lifetime_token_budget, lifetime_tokens_consumed, revoked_at, enabled " +
        `FROM api_keys WHERE label = '${BANSOS_DEEPSEEK_KEY_LABEL}' LIMIT 1`,
    ),
  );
  const row = rows[0];
  if (!row || row.key_encrypted == null) return null;
  return {
    key: decryptCredentialToString(row.key_encrypted as Uint8Array),
    base_url: BANSOS_DEEPSEEK_BASE_URL,
    model: BANSOS_DEEPSEEK_MODEL,
    used_tokens: toNumber(row.lifetime_tokens_consumed),
    budget_tokens: toNumber(row.lifetime_token_budget),
    active: row.revoked_at == null && row.enabled !== false,
  };
}
