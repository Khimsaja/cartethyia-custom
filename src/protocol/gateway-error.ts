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
  | "model_not_allowed"
  | "upstream_not_found"
  | "context_length_exceeded"
  | "request_too_large"
  | "accounts_unavailable"
  | "accounts_rate_limited"
  | "capacity_exhausted"
  | "upstream_overloaded"
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
  | "route_unavailable"
  | "slug_reserved"
  | "quota_exceeded"
  | "rate_limited"
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
  | "shutting_down";

/** Identifies which boundary produced a safe public error. */
export type GatewayErrorOrigin = "cartethyia" | "upstream" | "network";

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
 * TipRouter-owned public messages, one per error code.
 *
 * A client must never read the provider's own words: upstream error bodies
 * are raw supplier text — supplier error codes, supplier phrasing, sometimes
 * supplier-internal identifiers — and they used to reach the buyer verbatim
 * as `error.message` (plus the whole body again in `details.raw`). These
 * sentences replace them at the public envelope. The code is untouched, so a
 * client still branches on `error.code`; only the human text becomes ours.
 *
 * The GatewayError itself is NOT rewritten — retry policy, account-health
 * classification, and the egress verdict all match on the raw upstream text
 * and `details.raw` internally. Sanitizing here, at the envelope, keeps the
 * operator's diagnostics while the buyer sees TipRouter.
 *
 * English by house rule (see the language guard in
 * test/transport/gateway-error-envelope.test.ts): client-facing text must be
 * readable without knowing this deployment's locale.
 */
const TIPROUTER_PUBLIC_MESSAGES: Readonly<Record<GatewayErrorCode, string>> = {
  capability_unsupported:
    "TipRouter: this route does not support that capability. Remove it from the request, or pick a model that accepts it.",
  ambiguous_model:
    "TipRouter: that model name matches more than one model. Use the full model id.",
  model_not_found: "TipRouter: that model was not found. Check the model id and try again.",
  auto_not_enabled: "TipRouter: automatic model selection is not enabled for this key.",
  auto_not_configured: "TipRouter: automatic model selection is not configured.",
  auto_no_allowlist:
    "TipRouter: this key has no models allowlisted for automatic selection.",
  auto_no_data:
    "TipRouter: no usage data is available yet to pick a model automatically. Try again shortly.",
  model_not_allowed: "TipRouter: this key is not allowed to use that model.",
  upstream_not_found: "TipRouter: the provider could not find that model.",
  context_length_exceeded:
    "TipRouter: the request is too long for this model's context window. Shorten the input and try again.",
  request_too_large: "TipRouter: the request is too large. Reduce its size and try again.",
  accounts_unavailable:
    "TipRouter: no account is available to serve this model right now. Please try again shortly.",
  accounts_rate_limited:
    "TipRouter: all accounts for this model are cooling down after rate limits. Please try again shortly.",
  capacity_exhausted:
    "TipRouter: the service is at capacity right now. Please wait a moment and try again.",
  upstream_overloaded:
    "TipRouter: the provider is overloaded right now. Please wait a moment and try again.",
  provider_capacity_exhausted:
    "TipRouter: the provider is at capacity for this model right now. Please try again shortly.",
  upstream_queued: "TipRouter: the provider queued this request. Please wait and try again.",
  proxy_pool_capacity_exceeded:
    "TipRouter: the proxy pool is at capacity. Please try again shortly.",
  proxy_pool_provider_capacity_exceeded:
    "TipRouter: the proxy pool is at capacity for this provider. Please try again shortly.",
  proxy_pool_blocked: "TipRouter: the proxy pool is temporarily blocked. Please try again shortly.",
  proxy_pool_cooldown:
    "TipRouter: the proxy pool is cooling down. Please try again shortly.",
  proxy_pool_unavailable: "TipRouter: the proxy pool is unavailable. Please try again shortly.",
  proxy_pool_unhealthy: "TipRouter: the proxy pool is unhealthy. Please try again shortly.",
  invalid_pool_limits: "TipRouter: the proxy pool limits are misconfigured. Please try again later.",
  admission_unavailable:
    "TipRouter: the admission service is unavailable. Please try again shortly.",
  route_unavailable: "TipRouter: no route is available for this request. Please try again shortly.",
  slug_reserved: "TipRouter: that name is reserved.",
  quota_exceeded:
    "TipRouter: this key has exceeded its quota. Please wait for it to reset.",
  rate_limited: "TipRouter: too many requests. Please slow down and try again.",
  authentication_failed:
    "TipRouter: authentication with the provider failed. Please try again; if it persists, contact support.",
  policy_rejected:
    "TipRouter: the request was rejected by policy. Please adjust the request and try again.",
  invalid_request:
    "TipRouter: the request was rejected as invalid. Check the request format and try again.",
  not_found: "TipRouter: the requested resource was not found.",
  link_not_found: "TipRouter: this share link is invalid.",
  link_expired: "TipRouter: this share link has expired.",
  link_revoked: "TipRouter: this share link was revoked.",
  link_disabled: "TipRouter: this share link is disabled.",
  invalid_sequence: "TipRouter: the tool-call sequence is invalid.",
  invalid_lifecycle: "TipRouter: the request lifecycle is invalid.",
  unsupported_field: "TipRouter: the request contains an unsupported field.",
  unsupported_media_type: "TipRouter: the media type is not supported.",
  upstream_conflict:
    "TipRouter: the provider reported a conflict for this request. Please try again.",
  upstream_unprocessable:
    "TipRouter: the provider could not process this request. Please adjust it and try again.",
  internal_error:
    "TipRouter: an internal error occurred. Please retry; if it persists, quote the request id to support.",
  transport_unavailable:
    "TipRouter: the connection to the provider failed. Please try again.",
  tunnel_setup_failed:
    "TipRouter: the secure tunnel could not be established. Please try again.",
  platform_unavailable:
    "TipRouter: the provider is temporarily unavailable. Your request did not go through — please wait a moment and try again.",
  tenant_capacity_exhausted:
    "TipRouter: the service is at capacity right now. Please wait a moment and try again.",
  tls_rejected: "TipRouter: the secure connection was rejected. Please try again.",
  proxy_auth_required: "TipRouter: proxy authentication is required. Please try again shortly.",
  deadline_exceeded: "TipRouter: the request timed out. Please try again.",
  transport_closed:
    "TipRouter: the connection closed before the response finished. Please retry.",
  max_connections_exceeded:
    "TipRouter: too many concurrent connections. Please try again shortly.",
  overloaded: "TipRouter: the service is overloaded right now. Please try again shortly.",
  proxy_unreachable: "TipRouter: the proxy is unreachable. Please try again shortly.",
  tool_call_loop_detected:
    "TipRouter: a tool-call loop was detected. Please adjust the request and try again.",
  client_router_denied: "TipRouter: this client is not allowed. Please use an allowed client.",
  shutting_down: "TipRouter: the service is restarting. Please try again in a moment.",
};

/** Fallback for a code with no dedicated sentence: generic, still ours. */
const TIPROUTER_PUBLIC_MESSAGE_FALLBACK =
  "TipRouter: the request failed. Please try again; if it persists, quote the request id to support.";

/** Formats a gateway error for public/internal clients without mutating it. */
export function explainGatewayError(error: GatewayError): string {
  // Upstream failures carry the provider's own words in `message`
  // (passthrough prose, or the provider's error identifier when there is no
  // prose). Those words are the supplier's, not ours, so the buyer gets the
  // TipRouter sentence for the code instead. Two signals mark the passthrough:
  // the `upstream` origin, and the `upstreamMessageAsIs` detail the throw
  // sites set when the message is verbatim upstream text. Gateway-authored
  // messages (origin `cartethyia` / `network`, no flag) keep their sentence —
  // they were already written by us.
  if (error.origin === "upstream" || error.details["upstreamMessageAsIs"] === true) {
    return TIPROUTER_PUBLIC_MESSAGES[error.code] ?? TIPROUTER_PUBLIC_MESSAGE_FALLBACK;
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
  "maxInflight",
  "weight",
]);
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

/**
 * The origin as a client sees it. The internal origin names the upstream
 * product (`cartethyia`); the buyer-facing envelope says `tiprouter` instead.
 * The layer words pass through unchanged: `upstream` / `network` name where
 * the failure happened, not who supplied it, and a client triaging a failure
 * still needs that distinction.
 */
export type PublicGatewayErrorOrigin = "tiprouter" | "upstream" | "network";

export function publicErrorOrigin(origin: GatewayErrorOrigin): PublicGatewayErrorOrigin {
  return origin === "cartethyia" ? "tiprouter" : origin;
}

/** Serializes a GatewayError with the same public shape as transport errors. */
export function publicGatewayErrorBody(error: GatewayError): {
  readonly error: {
    readonly origin: PublicGatewayErrorOrigin;
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
    `The selected route does not support capability: ${capability} (request {requestId}). Drop the ${capability} part of the request, or route to a model that accepts it. Know your tools — this one just isn't in the box 🧰`,
    { capability, ...details },
  );
}
