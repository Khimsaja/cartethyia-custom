// Typed gateway failures: the stable public error codes, the error class, and
// the sanitizers that keep upstream payloads out of public envelopes.

/** Stable typed error codes returned at gateway boundaries. */
export type GatewayErrorCode =
  | "capability_unsupported"
  | "ambiguous_model"
  | "model_not_found"
  | "auto_not_enabled"
  | "auto_not_configured"
  | "auto_no_allowlist"
  | "auto_no_data"
  | "upstream_not_found"
  | "context_length_exceeded"
  | "request_too_large"
  | "accounts_unavailable"
  | "accounts_rate_limited"
  | "capacity_exhausted"
  | "provider_capacity_exhausted"
  | "upstream_queued"
  | "proxy_pool_capacity_exceeded"
  | "proxy_pool_provider_capacity_exceeded"
  | "proxy_pool_blocked"
  | "proxy_pool_cooldown"
  | "proxy_pool_unavailable"
  | "proxy_pool_unhealthy"
  | "invalid_pool_limits"
  | "admission_unavailable"
  | "slug_reserved"
  | "quota_exceeded"
  | "authentication_failed"
  | "policy_rejected"
  | "invalid_request"
  | "not_found"
  | "link_not_found"
  | "link_expired"
  | "link_revoked"
  | "link_disabled"
  | "invalid_sequence"
  | "invalid_lifecycle"
  | "unsupported_field"
  | "unsupported_media_type"
  | "upstream_conflict"
  | "upstream_unprocessable"
  | "internal_error"
  | "transport_unavailable"
  | "tunnel_setup_failed"
  | "platform_unavailable"
  | "tenant_capacity_exhausted"
  | "tls_rejected"
  | "proxy_auth_required"
  | "deadline_exceeded"
  | "transport_closed"
  | "max_connections_exceeded"
  | "overloaded"
  | "proxy_unreachable"
  | "tool_call_loop_detected"
  | "client_router_denied"
  | "model_abuse_banned"
  | "shutting_down"
  | "restart_for_update";

/** Identifies which boundary produced a safe public error. */
export type GatewayErrorOrigin = "cartethyia" | "upstream" | "network";

/**
 * Brand buyers see on the wire for gateway-originated errors.
 * Internal telemetry and the console keep the `cartethyia` origin; only the
 * public serialization is relabeled so the engine name never leaks to buyers.
 */
export const PUBLIC_GATEWAY_ORIGIN = "tiprouter";

/** Map an internal error origin to the value serialized on the wire. */
export function publicErrorOrigin(origin: GatewayErrorOrigin | string): string {
  return origin === "cartethyia" ? PUBLIC_GATEWAY_ORIGIN : origin;
}

/**
 * Error with a client-safe stable code, origin, and sanitized metadata.
 */
export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number;
  readonly origin: GatewayErrorOrigin;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: GatewayErrorCode,
    status: number,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    origin: GatewayErrorOrigin = "cartethyia",
  ) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
    this.origin = origin;
    this.details = details;
  }
}

/**
 * Legacy origin brand prefixes. Older builds stamped these into the public
 * `message`; strip them so a value that crossed two shapers is not doubled
 * and so clients never see product branding in the error text.
 *
 * Blame lives in the structured `origin` field (`cartethyia` | `upstream` |
 * `network`). The public message is always `code: explanatory` for every
 * origin — gateway and upstream look the same on the wire.
 */
const LEGACY_ORIGIN_LABELS: readonly string[] = [
  "Cartethyia Error:",
  "Upstream Error:",
  "Network Error:",
];

function stripLegacyOriginLabel(message: string): string {
  const trimmed = message.trim();
  for (const prefix of LEGACY_ORIGIN_LABELS) {
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trimStart();
  }
  return trimmed;
}

/**
 * Public client-facing error text: a plain sentence, with no machine code
 * stamped into it.
 *
 * The code is not lost — it travels in the envelope's `error.code` field, and
 * the HTTP status carries the class. Stamping it into the text
 * (`accounts_unavailable: Model 'x' has no available account (52 candidate(s)
 * unusable: credit_floor_reached, model_cooldown)`) would put internal enum
 * names in front of the operator's sentence and make the message unreadable
 * while adding nothing the field does not already carry.
 *
 * Stripping is idempotent, and that is the point: a message that already
 * carries a `code:` prefix — stamped by an older builder, or by a code path
 * that formats before it reaches here — loses it once instead of being
 * doubled. Origin is never written into the text either; clients that need the
 * layer read `error.origin`.
 */
export function formatPublicErrorMessage(code: string, message: string): string {
  const strippedOrigin = stripLegacyOriginLabel(message);
  // A leading `<code>:` is the old stamping; drop it so the sentence stands on
  // its own. Matched against the code this call is formatting, so a message
  // that legitimately begins with some other word is left alone.
  const prefix = `${code}:`;
  const explanatory = strippedOrigin.startsWith(prefix)
    ? strippedOrigin.slice(prefix.length).trimStart()
    : strippedOrigin;
  if (explanatory.length === 0) return code;
  return explanatory;
}

/**
 * TipRouter buyer-facing messages for upstream-origin failures.
 *
 * LOCAL TIPROUTER PATCH (not upstream): buyers must never see raw third-party
 * provider text. Upstream bodies leak provider identity ("free plan" quota
 * notes, billing URLs, verify-account prompts) and the provider id itself, so
 * every upstream-origin error is reworded to a neutral TipRouter message. The
 * raw text stays on the GatewayError object (logs, telemetry, console) — only
 * the wire serialization is reworded.
 */
const UPSTREAM_BUYER_MESSAGE: Partial<Record<GatewayErrorCode, string>> = {
  authentication_failed:
    "TipRouter could not authenticate with the AI provider. Please try again.",
  quota_exceeded:
    "TipRouter has reached its usage limit for this model. Please try again later.",
  accounts_rate_limited:
    "All routes for this model are busy right now. Please try again in a moment.",
  accounts_unavailable: "This model is temporarily unavailable. Please try again later.",
  policy_rejected:
    "The request was rejected by content policy. Please adjust your prompt and try again.",
  context_length_exceeded:
    "The conversation is too long for this model. Please shorten it and try again.",
  request_too_large: "The request is too large. Please reduce its size and try again.",
  upstream_not_found: "The requested model is not available right now. Please try again later.",
  upstream_conflict: "The AI provider could not process the request. Please try again.",
  upstream_unprocessable: "The AI provider could not process the request. Please try again.",
  platform_unavailable: "The AI provider is temporarily unavailable. Please try again.",
  transport_unavailable: "The AI provider is temporarily unreachable. Please try again.",
  deadline_exceeded: "The request took too long to complete. Please try again.",
  internal_error: "Something went wrong on our side. Please try again.",
  transport_closed: "The connection was closed before the response completed. Please try again.",
  not_found: "The requested resource was not found.",
  invalid_request: "The request was invalid. Please check your parameters and try again.",
};

const UPSTREAM_BUYER_MESSAGE_FALLBACK =
  "The AI provider returned an error. Please try again.";

/** Formats a gateway error for public/internal clients without mutating it. */
export function explainGatewayError(error: GatewayError): string {
  if (error.origin === "upstream") {
    const safe =
      UPSTREAM_BUYER_MESSAGE[error.code] ?? UPSTREAM_BUYER_MESSAGE_FALLBACK;
    return formatPublicErrorMessage(error.code, safe);
  }
  return formatPublicErrorMessage(error.code, error.message);
}

const PUBLIC_ERROR_DETAIL_KEYS = new Set([
  "accountId",
  "accountScope",
  "available",
  "capacity",
  "configuredPools",
  "cooldownReason",
  "gateway_hint",
  "currentInflight",
  "credentialEvidence",
  "model",
  "poolId",
  "pools",
  "providerStatus",
  "providerScope",
  "rateLimitScope",
  "reason",
  "reasons",
  "candidate_count",
  "requestId",
  "retryAfterMs",
  "retryAt",
  "safeMessage",
  "scope",
  "status",
  "upstreamRequestId",
  "upstreamStatus",
  "maxInflight",
  "weight",
]);
// NOTE (TipRouter local patch): "raw", "providerId" and "providerCode" were
// deliberately removed from the public allowlist. They carried verbatim
// third-party provider text (free-plan notes, billing URLs, provider ids)
// to buyers; the raw text stays on the GatewayError object for logs and
// telemetry.
function sanitizePublicDetail(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 3) return "[redacted]";
  if (Array.isArray(value))
    return value.slice(0, 32).map((entry) => sanitizePublicDetail(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sanitizePublicDetail(entry, depth + 1),
    ]),
  );
}

/** Returns bounded allowlisted details suitable for public error envelopes. */
export function publicGatewayErrorDetails(
  error: GatewayError,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(error.details)
      .filter(([key]) => PUBLIC_ERROR_DETAIL_KEYS.has(key))
      .map(([key, value]) => [key, sanitizePublicDetail(value)]),
  );
}

/** Serializes a GatewayError with the same public shape as transport errors. */
export function publicGatewayErrorBody(error: GatewayError): {
  readonly error: {
    readonly origin: string;
    readonly code: GatewayErrorCode;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>>;
  };
} {
  return {
    error: {
      origin: publicErrorOrigin(error.origin),
      code: error.code,
      message: explainGatewayError(error),
      details: publicGatewayErrorDetails(error),
    },
  };
}

/** Creates the typed rejection required when a semantic feature is unavailable. */
export function capabilityUnsupported(
  capability: string,
  details: Readonly<Record<string, unknown>> = {},
): GatewayError {
  return new GatewayError(
    "capability_unsupported",
    400,
    `The selected route does not support capability: ${capability}`,
    { capability, ...details },
  );
}
