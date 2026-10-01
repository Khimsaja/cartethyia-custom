# Security

`src/security/` is the layered request-trust boundary: client identity,
gateway API-key authentication, CSRF, per-IP abuse protection, and per-key
admission (quotas, budgets, concurrency). Every layer is fail-closed —
a store outage rejects the request, never bypasses the limit. Console
dashboard sessions have their own DB-persisted lockout
(`src/console/auth/service.ts`); this package covers the `/v1/*` data plane
plus shared crypto/header primitives both planes use.

## Layout

```text
src/security/
  SECURITY.md      this file
  ip-boundary.ts   pure client-identity helpers (resolveClientIdentity, isTrustedProxyPeer)
  api-key-auth.ts  token extraction, HMAC lookup, frozen authorization snapshots, allowlists
  access-control.ts closed AccessScope model + immutable AccessDecision
  csrf.ts           stateless double-submit CSRF + session-cookie name
  abuse.ts          IpAbuseProtectionService + in-memory/Redis stores (/v1/* only)
  admission.ts      ApiKeyAdmissionService + atomic counter stores (reserve/reconcile/release)
  crypto.ts         AES-256-GCM credential encryption + HMAC secret hashing
  outbound-headers.ts API/dashboard CSP builders + BASE_PROTECTED_HEADERS
  client-router-fingerprint.ts inbound caller labelling for the per-key client-router denylist
                    (best-effort header label, not an authentication boundary)
```

## Layer order on the data plane

Ingress (`src/transport/middleware/pipeline.ts` fixes the order; the factories live in `body-policy.ts`,
`request-context.ts`, `gateway-guards.ts`, and `error-lifecycle.ts` by responsibility) applies these
in order; prepare/dispatch consult the snapshot the authentication layer
produces. A request with no `model`, or a blank one, is rejected 400 `invalid_request` at the top of
`ProxyRequestPreparer.prepare()` — before the snapshot read — so it never reserves capacity.

1. `ip-boundary.ts: resolveClientIdentity` — three modes. `disabled` (unset
   `TRUSTED_PROXY_CIDRS`) trusts the normalized TCP peer and ignores forwarding
   headers. `trusted` accepts `CF-Connecting-IP`,
   `True-Client-IP`, `X-Forwarded-For`, then `X-Real-IP`, but only when the
   TCP peer itself matches the CIDR allowlist. `platform` (the single value
   `platform`) accepts them from any peer, for a PaaS edge whose CIDRs are not
   published or stable and whose container has no other ingress; it is opt-in
   for exactly that reason. The two single-valued edge headers are preferred
   because the edge overwrites them, while a forwarded chain is read from its
   left end, which assumes the edge prepends. Otherwise it falls back to the
   peer. Both the peer and the allowlist entry are
   normalized first, so an IPv4-mapped IPv6 peer (`::ffff:127.0.0.1`) matches
   a plain IPv4 network like `127.0.0.1/32`, and an accepted header value is
   normalized the same way. Pure function; console login reuses the same pair
   for its lockout key.
2. `abuse.ts: IpAbuseProtectionService.checkBeforeAccess` — `/v1/*` only
   (health and non-`/v1` skipped). Defaults 240 req/60 s per (IP, route), ban
   at 480 for 1 h. **Two counters, and the split is load-bearing:** admission
   is per `(IP, route)` so one busy route cannot spend another's budget, while
   escalation is per IP across every route — a single per-route counter let a
   caller rotate paths, keep each count below the threshold, and never be
   banned. Every attempt counts, including rejected and unauthenticated ones,
   so failing requests escalate rather than being exempt (atomic
   `checkAndRecord`, so concurrent callers cannot race past the limit).
   Fail-closed 503 on store outage. Stores: `InMemoryIpAbuseStore` (per-key
   ring counters, 10 000-key bound, oldest-evicted) and `RedisIpAbuseStore`
   (ZSET sliding window trimmed to the ceiling, separate ban keys). This runs
   before credentials are resolved, so a throttled IP costs no key lookup.

   Mounted at the **root** through the `request` hook, not as a gateway plugin
   stage: a plugin (or root) `beforeHandle` only fires for a request that
   matches a registered route, so an unregistered `/v1/*` path or a real path
   with the wrong method skipped the counter entirely — the cheapest evasion
   available to a client that has decided to hammer the gateway. The hook
   resolves the client identity itself, from the same trusted-proxy boundary
   the identity middleware uses, because it runs ahead of that middleware.
3. `api-key-auth.ts: requestToken` + `resolveApiKeyAuthorization` — the credential comes from
   `Authorization: Bearer` or `x-api-key`. Both present is accepted only when they carry the *same*
   token, which is how an Anthropic-compatible client presents one key in both places; two different
   credentials are 400, and neither or malformed is 401. The token is HMAC-hashed (`hashSecret`, same key as
   credential encryption) and looked up via
   `DrizzleApiKeyStore.findActiveByHash`; unknown/revoked returns `undefined`
   and the caller must 401 — never a default identity. The result is a frozen
   `ApiKeyAuthorizationSnapshot` (model allow/deny lists, rpm,
   daily/monthly/lifetime budgets, `max_concurrent`, scopes) plus the
   authorization record's optional `model_prefix`. `isModelAllowed` uses
   dual-form bare/qualified matching with denylist-wins semantics. Provider
   selection is not an API-key restriction; the key's model policy and the
   tenant's available routes determine what can be used. The public `/v1/models`
   catalog applies the same model policy and `model_prefix` as dispatch.
   The same snapshot carries an optional `client_router_denylist`: ids of
   downstream routers this key refuses, matched against
   `client-router-fingerprint.ts`. That module reads inbound headers only and
   labels a caller from values the product itself emits (`x-msh-platform:
   9router`, `x-omniroute-peer-trace`, or a User-Agent naming the product).
   Generic runtime User-Agents such as bare `node` are not product-unique and
   are not used. 9Router and OmniRoute are one product under two names and share
   a single entry and id (`9router`);
   `omniroute` is accepted as a legacy alias. It is
   a best-effort label, **not** an authentication boundary: a client that sends
   no fingerprint is simply not matched. The denial runs in
   `createApiKeyAuthenticationMiddleware`, so a refused router is rejected 403
   `client_router_denied` before routing, and the check only fires for the key
   that listed it.
4. `admission.ts: ApiKeyAdmissionService.admit()` — atomic pre-dispatch
   admission returning an idempotent `AdmissionLease`. Limits: sliding-60 s
   RPM, daily/monthly/lifetime token pre-credit with reconcile-to-actual on
   `commitUsage`, per-key + per-tenant concurrency held for the request
   duration, provider/model allowlist gating. Rejections map to stable codes:
   quota 429 (`quota_exhausted`), concurrency 429, tenant capacity 429
   (`tenant_capacity_exhausted`), allowlist 404, store outage 503
   (`admission_unavailable`, fail-closed). Stores:
   `InMemoryAdmissionCounterStore` (mutex-gated, 10 000 terminal-reservation
   ring) and `RedisAdmissionCounterStore` (RESERVE/RECONCILE/RELEASE Lua
   scripts over `admission:<kind>:*` keys with TTLs; `sweepLeases` +
   `releaseAdmissionLease` reap crashed leases; `purgeKey` on key revocation, on
   a lowered/added limit, and for every key after a config restore that replaced
   `api_keys` — a restored key may come back un-revoked with a purged counter, so
   its lifetime budget would otherwise be re-seeded to full).
   `commitUsage` charges `input_tokens + output_tokens` only: `normalizeUsage`
   already folds cache writes into input and reasoning into output, so adding
   those fields again double-charged the same tokens. It also persists reconciled
   lifetime consumption to Postgres via an injected persister (COALESCE
   increment), so budgets survive a Redis flush.
   Pre-dispatch estimates are derived from every content part, not just `text`:
   tool results, documents, images and audio carry no `text` field, so a
   text-only walk priced them at zero and a request whose weight was mostly a
   pasted document could be admitted far above the reserve. Binary payloads get
   a flat per-part reserve.
   A failed failover attempt commits its *input* estimate only — it may have
   sent bytes upstream, but nothing was generated, so a request that walks N
   candidates does not leave N full estimates on the counters.
   The concurrency slot's TTL is derived from the lease TTL (it must outlive a
   live lease), and `seedBuckets` lets an operator who adds a daily/monthly
   ceiling have it enforced against spend already recorded in the current
   bucket (`SET NX` — a live counter is never overwritten).
   Lifetime counter's initial seed reads a fresh `lifetime_tokens_consumed`
   from Postgres, not the ≤3s-stale auth snapshot value — the auth cache is
   fine for enforcement (Redis is the authority), but the one write that
   *creates* `admission:lifetime:<id>` locks in a baseline for the counter's
   whole 35-day TTL, so it must come from the durable store. The reader is
   invoked lazily by the counter store only when the counter is missing, so
   the hot path stays Redis-only.

`csrf.ts: isCsrfValid` is not a data-plane layer: it guards unsafe
`/console/api/*` mutations only (session-cookie present: the readable
`csrf_token` cookie must timing-safe-equal the `x-csrf-token` header).
Stateless, no DB.

## Shared API-key enrollment

A share template is non-authenticating: the database shape constraint requires
its `key_hash` and `key_encrypted` to be null. A child has a hash, parent id,
and canonical issued-client-IP identity, but no recoverable secret. At auth
time the child inherits the template's **live** policy (limits, model lists,
`client_router_denylist`, scopes) and stamps `admission_identity` to the
parent so one-time/recurring budgets and concurrency are family-wide; lifetime
usage still persists on the child row for recipient attribution. Parent edits
invalidate every child's auth cache and purge admission counters. Public
enrollment resolves the client only through `resolveClientIdentity`; forwarded
headers are ignored unless the trusted-proxy boundary accepts them. The
database partial unique index enforces one active child per canonical IP
globally, so concurrent requests cannot issue duplicates. The plaintext child
secret is returned only by the successful issue response and is never returned
by owner summary or activity endpoints. Issued and request IPs are masked unless
the tenant explicitly enables full IP display; metadata endpoints do not expose
request or response payloads.

For request routing, a shared child also uses the share template's ID as the
CLI mapping owner; personal keys continue to use their own ID. The mapping still
requires the inherited `routing:cli_mapping` scope and matching CLI User-Agent.

## Shared primitives

- `access-control.ts`: closed `AccessScope` (`routing:invoke`,
  `routing:cli_mapping` (opt-in use of persisted CLI source→target mappings),
  `dashboard:read`, `dashboard:write`, `providers:read`, `providers:write`
  (register or modify a BYOK upstream and its credential), `models:read`,
  `models:write`, `platform:admin` — `platform:admin` is
  never assignable to tenant keys; `TENANT_KEY_SCOPES` is the assignable
  subset); `createAccessDecision` (frozen; empty
  tenant scopes default to `routing:invoke`; `tenantId: null` = cross-tenant
  operator).
- `cli-client-fingerprint.ts`: best-effort remote CLI tool id from inbound
  `User-Agent` (`claude-cli/` / `claude-code/` → `claude`). The preparer only
  consumes `routing:cli_mapping` remaps when this detector labels the caller,
  so a Claude→DeepSeek slot remap cannot rewrite a non-Claude client that
  happened to send `opus`. Spoofable; not a security boundary.
- `crypto.ts`: AES-256-GCM (`iv12 || tag16 || ciphertext`, key from
  `CARTETHYIA_ENCRYPTION_KEY`, no fallback, cached after first decode) +
  `decryptCredentialToString` (used by the pool loader and credential service)
  + `hashSecret` (HMAC-SHA256 with the same key; API-key lookup). Postgres
  never sees plaintext.
- `outbound-headers.ts`: `API_CONTENT_SECURITY_POLICY` (deny-all for JSON/API),
  `X_FRAME_OPTIONS = "DENY"`, `GATEWAY_SECURITY_HEADERS` (the single list every
  `/v1` response spreads, so a hardening cannot reach one response path and
  miss the others), dashboard/inline-script CSP builders (hash-based,
  no `unsafe-inline` for scripts), `BASE_PROTECTED_HEADERS`
  (credential/transport/proxy-identity/gateway-identity + all `x-forwarded-*`;
  consumed by `filterProviderCustomHeaders` in protocol primitives),
  `HEADER_TOKEN`/`HEADER_CONTROL`, `isProtectedHeader`.

## Model-abuse strikes (`model-abuse.ts`)

A client that repeatedly requests a model outside its access — one absent from
its allowlist, denylisted, or resolving to nothing — is answered with a warning
that counts up, then banned. Each such *consecutive* rejection records a strike
against the caller's client IP; the tenth (configurable via
`CARTETHYIA_MODEL_STRIKE_THRESHOLD`) bans that address. The ban is keyed on the
address alone: an API key is shared by every recipient of a share link, so
banning it would refuse callers that did nothing while the address that probed
mints a fresh key. The address cannot be re-enrolled, which is the point. A
*valid*-model request clears the counter, and a strike counter expires after a
quiet window (`CARTETHYIA_MODEL_STRIKE_WINDOW_MS`, default 5 min), so one typo —
or a client that corrected itself — never accumulates toward a ban. A ban lapses
on its own after `CARTETHYIA_MODEL_BAN_TTL_MS` (default 1 h), so a false positive
(a shared NAT) heals without an operator; the console
(`GET`/`DELETE /console/api/model-bans`) lifts one early.

Placement is load-bearing. The ban gate runs in
`createApiKeyAuthenticationMiddleware`, *before* canonical parse and route
preparation and before `state.authorization` is assigned, so a banned caller's
attempts produce no telemetry row and no console error — the noise this layer
exists to stop. The strike is recorded in `createProxyRoutePreparationMiddleware`,
the single choke point where the preparer rejects a model, so both rejection
kinds (`isModelAllowed` → 404, `modelNotFoundError` → 404) count and nothing
else does. Unlike admission, this layer is **fail-open** on store outage: a
strike counter that cannot be read must not refuse a legitimate request, so a
store error is swallowed and the request proceeds — the worst case is a missed
strike, never a blocked client.


- 240 RPM/IP per 60 s window, ban at 480 for 1 h (`IP_RATE_MAX_PER_WINDOW`).
  The in-memory store's key ceiling (10 000) and per-key preallocation (64) are
  constructor-option defaults in `abuse.ts` with no env binding: they bound
  memory for a Redis-less deployment, not operator policy.
- Admission: 60 s RPM window; lease TTL 1 h; lifetime reconciled to Postgres.
- Redis keys: `admission:rpm|daily|monthly|lifetime|concurrent:<key>[:bucket]`,
  `admission:lease:<reservationId>`, `admission:tenant_concurrent:<tenant>`,
  `admission:inflight:<provider:model:account>`,
  `cartethyia:ip:<identity>:<route>`, `cartethyia:ip:ban-count:<identity>`,
  `cartethyia:ip:ban:<identity>`, `proxy:inflight:<poolId>`,
  `proxy:cooldown:<poolId>:<providerId>`, `proxy:cooldown:providers:<poolId>`.
  Every one carries a TTL. The per-IP admission step is a single static Lua
  script over its three keys, so an admitted `/v1` request costs one round trip
  and a banned one costs one; the two counters stay separate (admission per
  route for fairness, escalation per identity so rotating the path cannot dodge
  the ban). All scripted calls are static Lua (no dynamic eval) with
  finite-number result guards (`redisEvalNumber` / `redisEvalTuple`).
- Model-abuse strikes: 10 consecutive invalid-model requests ban the client
  address (`CARTETHYIA_MODEL_STRIKE_THRESHOLD`); a strike expires after 5 min of
  quiet (`CARTETHYIA_MODEL_STRIKE_WINDOW_MS`) and a ban after 1 h
  (`CARTETHYIA_MODEL_BAN_TTL_MS`). Redis keys
  `cartethyia:model-abuse:strike:ip:<ip>` (window TTL) and the
  `cartethyia:model-abuse:bans:ip` sorted set, whose members are the addresses
  scored with the instant their ban lapses — a ban needs no sweeper, because an
  elapsed member reads as absent and is dropped. The record step is a single
  static Lua script over its two keys.

## How to extend

- New scope: extend `AccessScope` + `isValidTenantKeyScope`, thread through
  `requireTenantScope`/`requireScope` in `src/console/shared/errors.ts`.
- New protected header: add to `BASE_PROTECTED_HEADERS` — protocol custom
  headers, the compatibility-profile validator, and the Claude adapter pick it
  up automatically. Cross-origin redirect stripping uses its own
  `CREDENTIAL_HEADERS` list in `network/outbound-fetch.ts`, so a new name must
  be added there too if it must be stripped on redirect.
- New admission limit: extend `AdmissionReserveRequest` + both stores'
  reserve/reconcile/release paths + the Lua scripts + `reasonToGatewayError`
  mapping together; a limit enforced in only one store is a split-brain.
