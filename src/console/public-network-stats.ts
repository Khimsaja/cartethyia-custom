/**
 * Public network statistics for buyer-facing surfaces (e.g. the TipRouter
 * website's live stats section).
 *
 * Aggregate-only by design: the response carries totals and per-model
 * breakdowns, never per-key, per-IP, per-client, or cost data. Results are
 * cached in-process for 60 seconds so public traffic never hammers the
 * telemetry tables (the underlying queries run in ~25ms on an index).
 */
import type { DatabaseHandle } from "../persistence/db-handle";
import { queryTelemetryEvents } from "../observability/event-log";
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

/** Buyer template whose model list defines the public status page catalog. */
export const BUYER_TEMPLATE_NAME = "tiprouter new";

const TOP_MODELS_LIMIT = 10;

let cached: { data: PublicNetworkStats; expiresAt: number } | null = null;
let inflight: Promise<PublicNetworkStats> | null = null;

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

const toNumber = (value: unknown): number => {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : 0;
};

async function queryPublicNetworkStats(db: DatabaseHandle): Promise<PublicNetworkStats> {
  // NOTE (2026-10-19): per-request telemetry no longer lands in the Postgres
  // `telemetry_events` table — since the upstream merge it is written to
  // hourly JSONL files under ./data/telemetry-events (the table's newest row
  // is 2026-10-17 and it is no longer written). Aggregate from the JSONL log
  // instead; the table is kept only for historical reference. Measured on
  // prod: ~204k events/24h parse in ~1.3s, amortized by the 30s cache below.
  const now = Date.now();
  const since24h = new Date(now - 24 * 3600 * 1000);
  const since1hMs = now - 3600 * 1000;
  const since24hMs = since24h.getTime();

  // Buyer model allowlist: the 'tiprouter new' template's model list.
  // Status page is buyer-facing: only show models buyers actually get.
  // Unioning every active whitelist key's model_list leaked infra-only
  // models onto the page (MASTER KEY and admin keys carry models that are
  // not in the buyer template). Fall back to that union only if the
  // template is missing/empty, so the page never goes blank on a rename.
  const templateRows = rowsOf(
    await db.query(
      "SELECT DISTINCT jsonb_array_elements_text(models) AS model FROM model_templates " +
        `WHERE name = '${BUYER_TEMPLATE_NAME}' AND jsonb_typeof(models) = 'array'`,
    ),
  );
  const allowRows =
    templateRows.length > 0
      ? templateRows
      : rowsOf(
          await db.query(
            "SELECT DISTINCT jsonb_array_elements_text(model_list) AS model FROM api_keys " +
              "WHERE model_access_mode = 'whitelist' AND revoked_at IS NULL " +
              "AND COALESCE(enabled, true) AND jsonb_typeof(model_list) = 'array'",
          ),
        );
  const allowlist = new Set<string>();
  for (const row of allowRows) {
    if (typeof row.model === "string" && row.model) allowlist.add(row.model);
  }

  const events = await queryTelemetryEvents({ since: since24h });

  let requests = 0;
  let ok = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const perModel = new Map<string, { hits: number; ok: number; tokens: number }>();
  const health1h = new Map<string, { hits: number; ok: number }>();

  for (const e of events) {
    // File-level hour filtering is coarse; enforce the exact window here.
    const at = new Date(e.createdAt).getTime();
    if (at < since24hMs) continue;
    // 429s are client-side throttling, not errors: excluded everywhere,
    // matching the old SQL's `http_status IS DISTINCT FROM 429`.
    if (e.httpStatus === 429) continue;
    const model = e.requestedModel && e.requestedModel.length > 0 ? e.requestedModel : "unknown";
    const succeeded = e.status === "completed";
    requests++;
    if (succeeded) ok++;
    inputTokens += e.inputTokens ?? 0;
    outputTokens += e.outputTokens ?? 0;
    let m = perModel.get(model);
    if (!m) {
      m = { hits: 0, ok: 0, tokens: 0 };
      perModel.set(model, m);
    }
    m.hits++;
    if (succeeded) m.ok++;
    m.tokens += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
    if (at >= since1hMs && allowlist.has(model)) {
      let h = health1h.get(model);
      if (!h) {
        h = { hits: 0, ok: 0 };
        health1h.set(model, h);
      }
      h.hits++;
      if (succeeded) h.ok++;
    }
  }

  const topModels = [...perModel.entries()]
    .map(([model, s]) => ({ model, hits: s.hits, ok: s.ok, tokens: s.tokens }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, TOP_MODELS_LIMIT);
  const modelHealth = [...health1h.entries()]
    .map(([model, s]) => ({ model, hits: s.hits, ok: s.ok }))
    .sort((a, b) => b.hits - a.hits);

  return {
    window: "24h",
    requests,
    ok,
    success_rate: requests > 0 ? ok / requests : 0,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    top_models: topModels,
    model_health_1h: modelHealth,
    generated_at: new Date().toISOString(),
  };
}

/** Clears the in-process cache. Exported for tests and operational use. */
export function clearPublicNetworkStatsCache(): void {
  cached = null;
  inflight = null;
}

/** Cached public stats; concurrent callers share one in-flight refresh. */
export async function getPublicNetworkStats(db: DatabaseHandle): Promise<PublicNetworkStats> {
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  if (inflight) return inflight;
  inflight = (async () => {
    const data = await queryPublicNetworkStats(db);
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
  db: DatabaseHandle,
): Promise<BansosDeepseekStatus | null> {
  const rows = rowsOf(
    await db.query(
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
