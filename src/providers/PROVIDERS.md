# Providers

`src/providers/` is the single authority for every upstream LLM provider Cartethyia can route to: provider
identity and base URLs, the lazy capability registry, the shared OpenAI-compatible dispatch path, credential
envelopes, model definitions, usage normalization — plus four capability subsystems (`authentication/`,
`quota/`, `discovery/`, `operations/`) and every per-provider wire/OAuth/quota implementation
(`integrations/`). Routing, console, and telemetry consume providers only through the registry and the
operations services here; nothing else hardcodes a provider host, model list, or OAuth flow.

## Layout

```text
src/providers/
  provider-metadata.ts    identity: bundled IDs, base URLs, JWT verification, upstream sanitizers
  provider-registry.ts    contracts + runtime: ProviderModule, ProviderAdapter, ProviderRegistry, credential resolution
  default-registry.ts     wiring: PROVIDER_CAPABILITIES map + BUNDLED_PROVIDER_MODULES + createDefaultProviderRegistry()
  compatible-adapter.ts   shared OpenAI-compatible dispatch (BaseProviderAdapter template lifecycle)
  credential-envelope.ts  TokenEnvelope + unwrapProviderToken (adapters never emit "Bearer Bearer")
  model-definition.ts     static catalog shape: defineModel, manual-model defaults
  reasoning.ts            canonical reasoning-intent → per-wire reasoning payload helpers
  usage.ts                usage home: normalizeUsage, usageFromProvider, repriceUsage, wire encoders
  authentication/         OAuth kit every per-provider login client builds on
  discovery/              model probing: discovery contract, /models fetcher, offline billing catalog, sync service
  operations/             runtime glue: seeding, caches, version resolution, health, credentials, deadlines
  quota/                  quota kit: one result shape, dispatch, connectivity probe, declarative window engine
  integrations/           one module (or directory) per provider: adapters, OAuth, quota, CLI-version quirks


## Registration: metadata × capabilities × lazy import

Three layers combine in `default-registry.ts: BUNDLED_PROVIDER_MODULES`, then `createDefaultProviderRegistry()`
→ `toRegistration()` → `ProviderRegistry.register()`.

1. **Metadata** (`provider-metadata.ts: RAW_BUNDLED_PROVIDER_METADATA`): `id`, `displayName`, `baseUrl` are
   the only required fields. Optionals: `wireFamilyDefault` (default `chat`; `messages` for
   `anthropic`/`claude`, `responses` for `codex`), `requiresAccount` (only `opencodeft: false`),
   `defaultBypassProxy` (only `inferhub`), `ipScopedRateLimit` (only `opencodeft`),
   `jwtVerification` (only `grok`/`xai`), and the
   presentation-only pair `credentialUrl` + `credentialHint`: where an operator obtains the
   provider's credential, and one line of guidance when the flow is not a plain paste. The
   credential pair reaches the dashboard through `providerCredentialUrl()` /
   `providerCredentialHint()`, never through the persisted provider row, so a stale or hostile
   record cannot redirect the link. Three providers declare neither (`muse`, `opencodeft`,
   `inferhub`); a provider whose sign-in runs through its own login flow (Claude, Codex, Grok,
   Devin, Antigravity, Qoder) carries the hint and the site URL, and the dashboard
   labels its action "Sign in" rather than "Get API Key".
   `providerBaseUrl()` is the single declaration of origin; `providerUpstreamHost()` carries the SSRF
   binding, so dispatch needs no second map. `DEFAULT_PROXY_BYPASS_PROVIDER_IDS` derives the one
   proxy-bypass default that console routing, provider detail, and domain registration all read.
   `ipScopedRateLimit` is the one statement of which providers rate-limit by egress address rather
   than by credential, read through `providerRateLimitIsIpScoped()` by `shouldCooldownPool` — the
   account-keyed majority leaves the proxy pool alone on a 429 and lets account failover carry it.
   `PROVIDER_COMPATIBILITY_PROFILES` holds OpenAI-wire overrides only for the three `opencode*` hosts.
   `opencodeft` is the one provider that serves a free tier of a shared catalog: its discovery filters
   `/zen/v1/models` down to the free ids (`isFreeTierZenModel`, which keeps the `-free` convention plus the
   explicit exceptions in both directions) and marks the survivors, so "Fetch models" writes only what this
   provider can actually route rather than its full billed catalog.
2. **Capabilities** (`default-registry.ts: PROVIDER_CAPABILITIES`, keyed by every `BundledProviderId` with
   a `satisfies` check, so a missing key is a type error): `loadAdapter` (required) plus any of
   `loadModels`, `loadAuthentication`, `loadQuotaCollector`, `loadModelDiscovery`,
   `modelDiscoveryRequiresCredential`, `endpointPathsByWireFamily`, with `oauthCapability()` /
   `quotaCapability()` / `openAIModelDiscovery()` / `configuredProvider()` factories.
3. **Lazy import**: every `load*` is `async () => (await import("…")).export`, so nothing provider-specific
   evaluates at startup. `resolve()`, `resolveAuthentication()`, `resolveQuotaCollector()`, and
   `resolveModelDiscovery()` single-flight and cache on first use, keeping protobuf-heavy adapters
   (Devin) out of the boot path.

**Capability split.** `loadAdapter → ProviderAdapter.dispatch()` takes a canonical request and emits
canonical events, via `createApiKeyAdapter(spec)` / `OpenAICompatibleAdapter` or a bespoke class.
`loadAuthentication → { client, refresher }` serves the console login routes;
`loadQuotaCollector → QuotaFetcher` serves the console quota routes and never dispatch health;
`loadModelDiscovery → ProviderModelDiscovery` (+ credential flag) is TTL-cached 10 min when credential-free,
always live when credential-scoped.

Custom/BYOK providers are derived from their persisted base URL, compatibility profile, and wire-family
default, then registered through `registerByokProviders()` / `syncByokProvider()` as an
`OpenAICompatibleAdapter`; model protocol selection is independent from route-level identity. A custom
provider may serve Anthropic Messages or OpenAI Chat/Responses according to its wire profile.
The registry updates custom providers without a backend restart. Their upstream hosts are validated
at registration and on each network-bound dispatch. This existing BYOK path is separate from a
client's own editor BYOK setup documented in `README.md` and the CLI Tools guide.

**Search providers.** `exa`, `tavily`, and `brave` are bundled providers that serve no chat wire: each
declares one `serviceKind: "websearch"` catalog row (`search/search-catalog.ts`) and an adapter built by
`createSearchAdapter` from a `SearchProviderSpec` (`search/search-providers.ts`), whose `buildRequest` maps
the caller's `{query, max_results, …}` onto the provider's search API and whose `normalize` maps that
provider's response JSON into the shared `WebSearchResult` vocabulary. The `/v1/search` native route
(`transport/dispatch/websearch.ts`) drives them through the shared attempt loop, so a search provider's
model resolves through ordinary routing and failover to a sibling search backend is the same policy as any
other route. Because they are chat-less, their adapters fail closed with `capability_unsupported` on a chat
dispatch, and the canonical preparer points a chat caller that names a search model at `POST /v1/search`.

The per-(tenant, provider) `provider_routing_settings.user_agent` value defaults to
`codex_cli_rs/0.156.1` and is offered only for built-in API-key providers whose adapter does not
build its own User-Agent. `BUNDLED_PROVIDER_METADATA.hasAdapterUserAgent` is the source of truth:
the route catalog omits route identity for providers marked true, and the provider response carries
the capability so the dashboard hides the setting. At dispatch, any User-Agent already supplied
by an adapter or account remains authoritative. OAuth/scoped credentials and custom-provider
identity settings remain independent.

**Derived wire contract** (`operations/byok-wire-profile.ts`) keeps the custom adapter and probe/model-sync
fallback aligned. A custom row persists a base URL, compatibility profile, and `wire_family_default`;
served families, endpoint paths, and credential header shape derive from that data. An explicit
`endpoint_paths_by_wire_family` names the served families; otherwise `chat` serves both OpenAI `chat` and
`responses`, while `messages` serves Messages only. Messages-only providers use `x-api-key`; a profile
serving an OpenAI wire uses `Authorization: Bearer`.

`cli_identity` controls custom providers' additional CLI fingerprint headers; their
`gateway_user_agent` compatibility setting remains their existing User-Agent choice. Built-in
route-selected User-Agent settings are not applied to custom providers. Probes preserve adapter-native User-Agent. `POST /providers/connection-test` (ad-hoc, unsaved provider) uses the derived wire and matching
auth header for `GET <base>/v1/models` before anything is persisted.

## Seeding / catalog / discovery flow

1. **Static source of truth**: per-provider `*_MODELS` arrays built with `defineModel`, with limits/cost
   fallback into `discovery/models-dev-catalog.ts` (offline `base-models.json` snapshot, no runtime
   network) — except a row marked `free: true`, which always takes `FREE_TIER_COST` (zero input/output) so a
   free-tier entry is never priced by the model it wraps; loaded lazily via `loadModels` and memoized
   per-process by `operations/model-catalog-cache.ts`.
   The catalog fallback covers **limits and pricing only**, and now resolves them per provider: an exact
   `provider:model` row always wins, and the bare-id fallback answers only when every row for that id agrees
   — `undefined` otherwise, so a row keeps its own declared limits instead of inheriting another reseller's
   (hundreds of bare keys disagree about limits/pricing across resellers). Capability is declared by
   the row and never inherited. A capability a row does not name is left to the routing ladder rather than
   guessed — `buildCapabilityProfile` treats the
   codec wires as able to carry image/document/audio parts, and an upstream that cannot accept one degrades
   it itself. Audio is the exception, because the Anthropic Messages request schema defines no audio block:
   `routeCapabilitiesFor` narrows it to the wires that do (`chat`, `responses`), so a `messages` route never
   claims it and a declared `audio` modality cannot override that. Reasoning and tools are never stripped:
   `buildCapabilityProfile` grants both regardless of the
   row's recorded flags or its `source`. A `false` there — a discovered row with no metadata, or a catalog row
   set explicitly — must not silently rewrite a request the caller asked for. The upstream decides whether it
   can serve them and returns its own error if it cannot.
2. **DB materialization**: `seedBundledProviders()` upserts `providers` rows — additive only, because the
   test harness calls it on import to converge a shared database. `retireUnbundledProviders()` runs once on
   the boot path and deletes the global (`tenant_id IS NULL`) rows the bundle no longer declares: it is the
   only writer of global rows, so an unowned id absent from the bundle is an orphan by construction, while a
   tenant-owned BYOK row is never in scope. Without that step a retired provider kept a row `list()` still
   returned while `isBundledProviderId` no longer called it built-in, so the console drew it as an
   undeletable custom provider (the tenant-scoped `DELETE` matches `tenant_id = <tenant>`, never `NULL`);
   `bundledModelCatalog(registry)` aggregates `modelsByProvider` (conflicting endpoint paths for one wire
   family throw); `seedBundledModels()` reconciles `models` rows keyed `(provider, model, endpoint)` —
   deletes drifted builtin pairs, upserts with capability/cost reconciliation, never touches operator
   `enabled`.
3. **Live discovery**: credential-free providers are TTL-cached, credential-scoped discovery is always live.
   Generic path is `fetchOpenAICompatibleModels()`; one-shot connectivity probes go through
   `discovery/probing-service.ts`, sharing the catalog contract with console routes.

## Authentication: the OAuth kit

Provider-agnostic kit every per-provider login client builds on: the `OAuthLoginClient` contract, PKCE
helpers, device-flow correlation, token-endpoint request lifecycle, local JWT inspection, cross-process
refresh orchestration. Provider specifics (authorize URLs, client IDs, token field names, JWKS manifests)
stay in `integrations/<name>/*-oauth.ts`.

- **One login contract.** `OAuthLoginClient` declares device-code and browser-code support plus
  authorize/exchange/start/poll methods; each client implements only the flows its upstream offers.
  `supportsBrowserCode` is authoritative when a client states it. The base `OAuthClient` always *defines*
  `buildAuthorizeUrl` and `exchangeCode` — a device-only client overrides the latter to throw — so a
  capability check that only tests for the methods reports browser support for every device-only provider
  (Cline, Grok, Kimi, Muse, Buddy, GitHub, Kilo, xAI). The console's `oauthFlows` derivation therefore treats an
  explicit `false` as decisive and falls back to the method-shape test only when the flag is omitted.
- **A device poll is one attempt.** `pollDeviceAuth` performs a single token-endpoint request and returns
  `pending` while the user has not approved; the dashboard owns the cadence. A poll that loops internally
  holds one console request open for the whole authorization window (Codex previously slept through up to
  120 attempts, ~16 minutes) and makes the dialog's own interval meaningless. Device state is deleted only
  *after* the exchange succeeds — an authorization code is single-use, so dropping it first strands a failed
  exchange with no way to retry.
- **`pending` means "not approved yet" and nothing else.** A poll verdict is either a completed exchange or
  a failure with a reason; there is no third state, because a `pending` result carries no reason to show.
  Returning `pending` for an unrecognized error or a 2xx body that carries no token makes a permanent
  upstream rejection look like a login that never finished: the dialog spins until its own expiry and the
  operator sees nothing actionable. Two live bugs had exactly this shape — GitHub Copilot answered
  `pending` for any error it did not name, and Kimi did so for a token body with no `access_token`. A poll
  therefore **returns** `failed` with the upstream's reason rather than letting the shared parser throw: the
  dashboard's poll error path stops polling but displays no reason, so a throw would recreate the spinner.
  `parseTokenResponse` still refuses a body with no `access_token` — that guard covers the direct callers
  (the exchange path and any client reading a token body outside `pollGenericDeviceAuth`), and an
  access-only credential stays valid because only the access value is required.
- **Publish the complete verification URI when the provider sends one.** A device start returns
  `verification_uri_complete` (WorkOS, Cline) or `verification_uri`. Preferring the complete form is what
  makes the flow one click: it carries the user code in its query string, so opening the page enters the
  code automatically instead of asking the operator to read it from the dialog and type it into the form.
- **Auth configuration that is not a secret travels beside the tokens.** A credential string alone cannot
  express an account whose requests depend on where it was minted and which upstream profile it is bound to,
  so `OAuthExchangeResult.auth_state` carries that configuration (auth method, region, profile ARN, OAuth
  client id, token endpoint) and it persists on the account as `provider_accounts.auth_state`. Three
  consumers read it: the adapter builds its request from it, `OAuthTokenRefresher.refresh` receives it as
  `OAuthRefreshContext` (with the decrypted companion secret) so a refresh reaches the right endpoint with
  the right client, and the quota and discovery surfaces take it as their collection context. The companion
  secret a login mints — an OIDC client secret — is encrypted separately
  (`provider_oauth_states.client_secret_ciphertext`), never in `auth_state`. Both fields are optional and
  additive: a provider that needs neither is unaffected, and a refresh that reports no state leaves the
  stored one alone rather than blanking it.
- **Provider-specific start inputs ride the flow, not the route.** Some logins need a choice made before
  they begin (which identity provider, which organization URL, which region). `OAuthDeviceFlowContext.parameters`
  and `OAuthAuthorizeRequest.parameters` carry them from the console's start request through to the client,
  and the console persists them with the pending/device correlation so a later poll can rebuild the same
  context. A provider that needs none ignores the field, which keeps one start route serving every provider.
- **A redirect URI is per-client, not per-gateway.** Authorization servers allowlist redirect URIs exactly,
  so `browserRedirectUri` on the login client overrides the gateway default. OpenAI registers only
  `http://localhost:1455/auth/callback` for the Codex client and answers any other value with
  `invalid_request` *before* a consent screen, which is why the Codex browser flow could never complete
  against the shared loopback default; Z.AI rejects every loopback URI for the ZCode client and accepts only
  its own `zcode://` scheme; Google registers `http://127.0.0.1:51121/oauth-callback` for Antigravity and
  Anthropic `http://localhost:54545/callback` for Claude Code, and both answer
  `redirect_uri_mismatch` (Google, 400) or an equivalent rejection for the gateway's console URL. The
  registered host is part of the string: `localhost` and `127.0.0.1` resolve to the same address but are
  different URIs to an allowlist, so the spelling must match the registration exactly. The
  console route reads the client's value when it states one and the gateway default otherwise, and the same
  string is reused at exchange because the token endpoint compares it against what the authorize step sent —
  a client that hardcoded a different URI in `exchangeCode` therefore failed the exchange while its
  authorize step looked correct, so the two must come from one declaration.
- **A loopback redirect URI must be bound, or the browser is left on a dead page.** The URI these
  clients advertise names the machine the *operator's browser* is on, not the gateway, so advertising it
  is not the same as answering it. `callback-listener.ts` binds that port when a login starts — on
  `127.0.0.1` and `::1`, because `localhost` resolves to either and a browser may pick the one that is
  not bound — and releases it once the flow settles, so an idle gateway holds no extra sockets. A port
  that cannot be bound fails the login immediately rather than advertising an address nothing answers.
  This is the other half of the redirect-URI rule below: matching the registered string is necessary but
  not sufficient, because a string that nothing listens on still delivers no code. A redirect the process
  cannot bind (a custom scheme, a remote host) keeps the manual paste path.
- **A callback without `state` is correlated by provider.** Some servers do not echo `state` (OpenRouter
  omits it entirely), so `handleCallback` falls back to `consumePendingByProvider`, which follows a
  per-provider pointer written alongside the state key. The pointer is last-write-wins — a second console
  login for one provider repoints it, and the operator's newest attempt is the one they are watching — while
  the state key is still consumed atomically, so a callback can never inherit a spent verifier. The
  loopback listener applies the same rule per port: a state-less redirect is matched to the one flow
  waiting on that port, and the flow is claimed before the exchange so a retried redirect cannot spend the
  code twice.
- **A credential may carry the endpoint, not just the token.** GitHub Copilot's
  API host is per-account: the Copilot token carries a `proxy-ep` claim naming
  the account's host, and an enterprise account is served from a different host
  than an Individual one. A declarative `ApiKeyProviderSpec` cannot express
  that — its `base_url` is fixed at registration and routing resolves one base
  URL per provider, not per account — so `github` is a bespoke adapter
  that reads the host out of the stored `{access, apiHost}` envelope and issues
  the request itself while leaving payload translation, SSE decoding, and error
  mapping with the shared pipeline. Its client identity headers are a protocol
  requirement (the API rejects a request that does not identify a Copilot
  client), not cloaking, and they are stamped after the shared pipeline so a
  route-level User-Agent cannot displace them. Its directory is the account's
  own `/models`, whose entries are OpenAI-shaped in the envelope but not in the
  rows: the surface a SKU answers on is `supported_endpoints` (some SKUs answer
  only on `/responses`) and the window is nested under
  `capabilities.limits.max_context_window_tokens`, so a reader that assumed the
  flat shape would pin every row to chat at the default window. A row whose
  window reaches 500k also carries the Copilot-only `contextTier: "long_context"`
  request extension, injected only on the chat and responses wires — the native
  Anthropic surface validates against its own schema and rejects an unknown
  top-level key. Its quota comes from the same token endpoint that mints the
  inference token, which authenticates with the *GitHub* token rather than the
  minted one, so the credential envelope carries both.
- **An OAuth grant that ends in a durable key stores the key, not the token.** Z.AI's Coding Plan sign-in
  exchanges the authorization code for a short-lived access token and then trades that token through the
  provider's business APIs for a durable `<apiKey>.<secretKey>`; the coding endpoint accepts only the key.
  Storing the OAuth token instead produces a credential that authenticates nowhere, and the failure would
  surface at first dispatch rather than at login. Both that provider and OpenRouter therefore register no
  refresher, and their clients return the durable value in `refresh` only to satisfy the NOT NULL column.
- **A repeated login is the same account.** The account a login persists is identified by the label the
  provider reports (an email or org name), hashed into `credential_fingerprint`; a second login for that
  identity replaces the stored row and its `provider_oauth_states` row rather than inserting beside them,
  and clears the health state so a `Disabled` / `Re-login required` account comes back `Active` with the
  newer tokens. Keying on the refresh token instead is what let one email appear twice: a fresh login
  mints a new token, so the identity index never fired and the duplicate unique index only caught a replay
  of the exact same credential. A provider that reports no label falls back to that refresh-token
  fingerprint, which still rejects an exact replay. Renaming an account in the console changes the stored
  label, so a later login is treated as a new account rather than overwriting the rename.
- **Base class and lifecycle.** `oauth-client.ts` encapsulates PKCE authorize-URL building, form token
  exchange, normalized token parsing, and refresh, with protected hooks for scopes, extras, and field
  mapping; its `FetchLike` seam keeps tests off the network. `oauth-device-flow.ts` owns the generic device
  start/poll lifecycle; `oauth-flow-store.ts` owns token-endpoint POST helpers, deadline-composed signals, and
  the Redis-backed `OAuthFlowStore` (900s TTL) holding pending browser flows, device correlation, and
  `providerState` — which the console routes persist, so an in-flight login is shared across instances.
  Response parsing stays with the caller, where provider field names live.
- **JWT as defense-in-depth.** `jwt-validator.ts` treats TLS-to-the-issuer as the primary trust boundary:
  opaque tokens pass through untouched, JWTs always get structural and registered-claim checks, and
  signature verification only when the manifest declares `providerJwtVerification` (JWKS). Only asymmetric
  algorithms verify; `none` and `HS*` are rejected against downgrade.
- **Coordinated refresh.** `oauth-refresh-service.ts` layers an in-process single-flight map over a Postgres
  lease (`lease_owner` / `lease_expires_at`) acquired by conditional `UPDATE`; `persistRefreshed` /
  `disableAccount` are lease-fenced, so a loser whose lease expired writes zero rows instead of clobbering
  its peer. `loadAccountWithFreshness` supplies the `dueAt` as expiry minus the **provider's** refresh
  lead (`REFRESH_LEAD_MS` in `operations/oauth-refresh-lead.ts`; Claude ~4h, Codex ~5 days, Antigravity ~5
  min; default 5 minutes). A single global skew could not express those differences.
- **A provider with no refresh grant registers no refresher.** Kilo Code and Devin issue a token with no
  refresh endpoint, so their clients declare `refresh` as a throw and the registry wires them without
  `withRefresher`. That is load-bearing rather than cosmetic: `resolveRefresher` returning `undefined` is
  what makes the credential path (`if (refresher)`) and the 401 retry use the stored token as issued,
  instead of calling a method that always throws and turning a recoverable auth failure into a permanent
  one. Such a client returns the access secret in the `refresh` field purely to satisfy the identity
  fingerprint that keys a repeated login to one account; nothing sends it to a token endpoint. Because the
  issuer advertises no lifetime either, the stored `expires_at` is a far-future fallback — a nearer value
  would mark a working token as due for a refresh that cannot happen.
  `provider_oauth_states.refresh_ciphertext` is nullable, so an account whose credential carries no refresh
  token (a bare access token, or a JSON export without one) still gets a state row and is marked
  `provider_accounts.static_token` rather than being invisible to the sweep. A static token is a normal,
  usable credential — used exactly as issued and never refreshed — so the sweep skips it and an auth
  rejection against it cools the account down instead of disabling it (there is no refresh to run, and the
  token may still be valid). This is distinct from a *refreshable* account whose refresh grant died: that
  one is disabled by a definitive refresh failure, while its access token, if still valid, is surfaced as
  a static token the operator can pin instead.
- **Typed refresh failures.** `DEFINITIVE_PATTERN`
  (`invalid_grant|invalid_token|unauthorized_client|revoked|refresh_token.*expired`) marks permanently dead
  credentials; a bare 401 with no body match is still definitive, while timeouts, 5xx, 429, and
  `temporarily unavailable` stay transient and safe to retry.

Rules: no provider host, client secret, or token field name lives here. `providerState` is server-side only
and never echoed to the dashboard. Opaque tokens are never locally "validated"; the issuer validates them on
next use. Refresh never races: same-process callers share one promise, cross-process peers fence on the lease
owner id. Token helpers must not leak `Bearer` material into logs or errors.

## Quota: one shape, one window engine

Shared kit: one result shape, one dispatch entry point, one declarative window parser, one connectivity probe
for key-only providers. Provider specifics (endpoint URLs, field names, plan derivation) live in
`integrations/<name>/*-quota.ts` and the registry's `loadQuotaCollector`.

- **One result shape.** `ProviderQuotaResult` carries `source`, `plan`, `windows` (each a
  `ProviderQuotaWindow`: `kind`/`label`, used/remaining percents, `resetsAt`, optional absolute
  `used`/`limit` and `recurring`), and `error`. Every collector returns it, so console surfaces never branch on
  provider identity. The shared guards coerce unknown upstream JSON without throwing (`isoDate` accepts epoch
  seconds/millis and date strings), and `cleanError` redacts `Bearer` material and caps messages at 240 chars.
- **A quota row must name a model the catalog serves.** Antigravity's
  `v1internal:fetchAvailableModels` returns every deployment the account can reach — internal
  ones, and one entry per effort tier (`gemini-3.8-flash-low`/`-medium`/`-high`). The collector
  collapses each key with `collapseAntigravityVariant` and keeps it only when the catalog serves
  the result, so a deployment the catalog dropped cannot report a quota row for a model the
  operator cannot select. The set is derived from `ANTIGRAVITY_MODELS`, so removing a catalog
  model removes its quota row in the same change; a permissive id pattern in its place is what
  let a retired deployment keep reporting.
- **Login must provision the project, not just read it.** Antigravity
  (Cloud Code Assist) serves an account only after it has a
  `cloudaicompanionProject`, and a fresh account has none: the native client
  calls `loadCodeAssist`, enrolls the free tier via `onboardUser` when no
  `currentTier` is present, then re-reads the project. Skipping the enrollment
  leaves both dispatch and quota rejected with "You do not have a valid license
  of this product". Two details are load-bearing: the control-plane metadata is
  `ideType: ANTIGRAVITY` (the Gemini CLI's `IDE_UNSPECIFIED`/`pluginType:
  GEMINI` shape makes the backend treat the call as a different client), and a
  failed enrollment must fail the *login* so the operator sees the reason
  instead of a stored-but-unusable account. `discoverAntigravityProject`
  (`antigravity-protocol.ts`) owns this; the OAuth exchange calls it and the
  dispatch path falls back to it, cached per access-token hash.
- **Both quota endpoints are read and merged.** For Antigravity, `fetchAvailableModels` carries
  the per-model windows and `retrieveUserQuotaSummary` carries the weekly ones — and the weekly
  summary is the *only* quota a free-tier account has, because the upstream omits per-model quota
  for it. A collector that calls one endpoint and parses the other's shape reports nothing, so
  each is parsed by its own function and either may fail without discarding the other's windows.
  The family row takes the *worst* tier in its family, because that is the one the operator runs
  out of first.
- **Dispatch through the registry.** `fetchProviderQuota` lowercases the caller id, canonicalizes it with
  `resolveProviderId`, and resolves the handler via `registry.resolveQuotaCollector()`; a provider with no
  collector gets `unsupportedQuota(providerId)`. `QuotaFetcher` is the
  `(credential, fetcher) => Promise<ProviderQuotaResult>` type the registry supplies.
- **Declarative window engine.** `parseQuotaWindows` maps a response tree to windows from
  `QuotaWindowMapping` rows: priority-ordered value paths for used/remaining percent, reset, and absolute
  used/limit, plus `valueMultiplier` (e.g. 100 for 0–1 ratios), `derivePercent`, `emitWithoutPercent` for
  countdown-only windows, and plan overrides. Only simple percentage-tree responses use it — Tencent billing
  envelopes, WorkOS usage arrays, and duration-derived labels keep bespoke parsers.
- **Shared limit-array reader.** Providers that answer usage as an array of limit objects (Claude's
  per-model `limits[]`, Cline's window-typed `limits[]`) read it through `parseLimitWindows`
  (`quota/quota-limit-windows.ts`) with a `LimitWindowShape` naming which fields carry kind, percent,
  reset, and the absolute values — plus an optional `labelFor` and `deriveUsed` for the providers whose
  label or absolute used value is computed rather than reported. The array walk and the "an entry with
  neither a percent nor a reset has nothing to say" guard therefore exist once: an entry the upstream left
  blank is dropped, never rendered as 0% used.
- **Key-only connectivity probe.** `probeApiKeyConnectivity` hits the provider's `/models` (via
  `providerBaseUrl`) with the key: 401/403 means definitively invalid-or-revoked, 2xx means valid, anything
  else is an inconclusive transport/wire error surfaced as-is, never a credential verdict. It throws on
  transport failure and returns a `ProviderQuotaResult` otherwise. It sends no probe-specific User-Agent.
- **Cline's collector routes by credential kind.** `api_key` credentials (wrapped by
  `markClineApiKeyCredential`) go to that `/models` probe, while OAuth credentials keep the
  `users/me` quota surface — keys carry no OAuth envelope and upstream exposes no quota
  endpoint for them, so a 401 from `users/me` would be meaningless.

Rules: `FetchLike` is the transport seam — collectors take an injected fetcher so tests never touch the
network; quota fetches time out at 15s. Collection is read-only and best-effort: failures land in
`result.error`, never as thrown dispatch errors. Absolute `used`/`limit` are optional enrichment; percents
plus `resetsAt` are the contract the dashboard renders. `codexJwtAccountId` is the one sanctioned JWT peek
here — quota attribution, not authentication.

## Discovery: what models exist, and do they work

Owns the credential-scoped discovery contract, the tolerant OpenAI-compatible `/models` fetcher, the offline
models.dev billing catalog, and the probing/orchestration service that syncs discovered models into the
database. Per-provider entry points live in `integrations/`, registered as each `loadModelDiscovery`.

- **One discovery input.** `DiscoveryInput` is the credential-scoped entry shape every adapter's
  `discover*Models` takes: `credential`, optional `signal`, optional injectable `fetcher`.
  `ProviderModelDiscovery` (`context => ModelDefinition[] | null`) types the registry-facing boundary; a
  `null` return means "no data", never an error.
- **Tolerant `/models` parsing.** `fetchOpenAICompatibleModels` accepts `data|models|items` envelopes and
  assorted pricing/context field names, detects chat-vs-responses wire families per entry, sanitizes unknown
  ids via `sanitizeUpstreamLabel`, and falls back to the offline billing catalog: `modelsDevCatalog` loads
  `base-models.json` once and exposes `resolve(providerId, modelId)` — exact `provider:model` under the id's
  models.dev filing name (see below), then an unambiguous bare id, then its date-stripped form, `undefined`
  when none match or the bare id is ambiguous — for context/output metadata plus `costFor()` — enrichment
  with no network round-trip. Precedence at the call site is upstream first, then this catalog, then the
  floors: `parsedContext ?? fallback?.contextLimit ?? 200_000` (and `64_192` for output), so a provider that
  states its own limits is never overridden by the catalog. models.dev is authoritative mainly for **pricing**
  — an upstream `/models` response rarely states a price — and its limits are a secondary source.
  `defineModel` applies the same precedence to a static catalog row and then clamps: an output cap above the
  context window is unsatisfiable, and the base catalog routinely states `output === context` (and sometimes
  `output > context`, e.g. a Kimi K2.6 row filed `262144/262144`), so `outputLimit` is
  `min(declared, context)`. A `null` limit stays `null` — "not stated" is not zero.
  A provider models.dev does not file under our id leaves `resolve` undefined, and a fixed default is a worse
  answer than the catalog's own majority view: `modelsDevCatalog.majorityFor(bareId)` votes per field across
  every row for that bare id (ties resolve to the larger value — a limit stated too low truncates work, one
  stated too high is caught by the provider). A single dissenting reseller row therefore cannot outvote the
  model's own majority; only what the vote actually answers is taken, and an
  id nobody records keeps the documented default.
  A **recommended-models** endpoint that reports no limits at all is the case this matters most for: Cline's
  roster publishes only `id`/`name`/`description`/`tags`. Its limits come from Cline's own sibling catalog
  (`/ai/cline/models`, which states `context_length` and `top_provider.max_completion_tokens`) when that
  fetch succeeds, and from the tiers above when it does not. A hardcoded `200_000/64_192` was wrong for
  most of that roster — the subscription entries are 1M-context. The two endpoints spell the same model
  differently (`cline-pass/kimi-k3` vs `moonshotai/kimi-k3`), so the upstream index records each id and its
  bare segment.
  A discovery module may also mark its rows as a free plan tier, and that marker is what the model list
  groups on. Cline's roster states the tier structurally — the `free` bucket is the tier, and membership of
  that bucket is the whole rule: its ids are mostly `cline-free/…`, but a served free id need not carry the
  prefix (`deepseek/deepseek-v4-flash` and `z-ai/glm-5.3-flash` are free-tier catalog models with none), so a
  prefix test would drop served models while admitting retired ones. `syncModels` writes `source: "auto_free"`
  for a marked row and `discovered` for the rest, which is the only point where the distinction still exists;
  it prunes both sources on a superseded `(model, endpoint)` pair. Discovery for `cline` asks for the free
  tier only, because this gateway carries Cline as one provider and the pass roster would land in the catalog
  of an operator who may hold no pass.
  `resolve()` is fail-closed and provider-specific (right for metadata), while `costFor()` additionally
  falls back to the rate the catalog records for the model itself: a reseller that republishes a model
  without publishing its own rate is billed the model's global rate, never `$0.00`. Discovery callers pass
  their `providerId` so limits and pricing come from the row for
  the provider actually serving the model. Non-OK responses
  return `null`; the request carries a 10s timeout composed with the caller's signal.
- **A provider whose directory is not the OpenAI shape reads it directly.** The tolerant fetcher assumes
  `{data|models|items:[{id, context_length, modality}]}`. Three bundled providers publish something else.
  Kilo Code sends an OpenRouter-shaped catalog: limits under
  `top_provider.{context_length, max_completion_tokens}`, modality as an
  `architecture.input_modalities` array (`file` and `pdf` both meaning the canonical `document`), and
  capability as a `supported_parameters` list. Hugging Face's router sends an OpenAI-shaped *envelope*
  whose *entries* are not OpenAI-shaped: a model's limits live under a nested `providers[]` array (the
  router brokers to several backends at different prices), capability under
  `architecture.input_modalities` plus a per-backend `supports_tools`, and a row may have no live backend
  at all. GitHub Copilot's entries name the request surface each SKU answers on (`supported_endpoints`,
  where some SKUs answer only on `/responses`) and nest the window under
  `capabilities.limits.max_context_window_tokens`. Running any of them through the generic fetcher does
  not fail — it silently publishes every row at the `200_000/64_192` floors with `toolCall: false`, and
  `toolCall: false` makes capability preflight strip `tools` from the request.
  `kilo/kilo-discovery.ts`, `integrations/huggingface.ts`, and
  `github/github-discovery.ts` therefore derive each row from the provider's own
  declaration and return `null` on any failure so a broken sync leaves the static catalog in place. Two
  judgement calls are worth stating: Hugging Face's window and price come from the **cheapest live
  backend** (that is the rate the operator can expect), and `supports_tools` is **ANDed across backends**
  because a model routed to a backend without tool support cannot call tools. A row whose surface the
  provider does not serve over the OpenAI wire is **skipped**, not defaulted to chat: publishing a route
  the upstream rejects is worse than publishing none.
- **Provider id → models.dev filing name.** A Cartethyia provider id is not always the key models.dev uses:
  `opencodeft` serves `opencode.ai`, whose rows models.dev files under `opencode`. `MODELS_DEV_PROVIDER_IDS`
  in `models-dev-catalog.ts` maps those ids, and `resolve` tries the id as given first, then the mapped name —
  a second chance, never an override, so a provider the catalog already carries under its own id still wins.
  The mapping covers only ids backed by the deployment's own upstream; a match resting on model ids alone is
  deliberately absent, because the same generic id appears under hundreds of resellers and a guess would
  attribute a stranger's limits to this gateway's serving — the failure the bare-id disagreement rule exists
  to prevent. A provider with no models.dev counterpart (a private gateway, a BYOK endpoint) stays unmapped
  and keeps its declared limits.
- **Refreshing the snapshot.** `bun run scripts/ci-generate-models-dev-snapshot.ts` re-downloads
  `https://models.dev/api.json` and rewrites `base-models.json` (minified, one row per `provider:model`,
  pruned to the fields the resolver reads). Run it by hand when the catalog goes stale; the server never
  fetches models.dev at runtime.
- **Probing orchestration.** `ProviderProbingService` separates network probes from the Drizzle catalog
  repository while sharing the provider catalog contract: `probeModel` runs a one-shot connectivity test
  (latency + TTFB + sample or typed error, honoring an optional `route`/`wireFamily` override),
  `probeAllModels` batches at `PROBE_CONCURRENCY = 5` after a sequential warm-up, and `syncModels`
  reconciles into the `models` table. All three funnel through `probeModel`, so there is one probe path
  rather than one per entry point. Every attempt resolves its credential via `resolveCredentialForAccount`,
  classifies failure with `classifyUpstreamFailure`, and reports health through `recordAccountFailure` /
  `recordAccountSuccess`. The phases `probeModel` orchestrates — target/endpoint resolution, account
  selection, adapter resolution, preference loading, request construction, health recording, verdict
  computation, and sample extraction — live in `discovery/probe-phases.ts` as plain functions taking a small
  args object, so the method body reads as named steps. The dispatch-and-retry step stays inline: it owns
  the event stream, TTFB, captured request, and pool binding across the retry, and its `release` must run on
  the same frame as the binding. Probe dispatch preserves any native `User-Agent` configured by the
  provider adapter so upstream receives valid first-party tooling identity, while avoiding gateway-level markers.
  Two request defaults are shared by every entry point, both set in `buildProbeCanonicalRequest` /
  `loadProbePreferences`:
  - **Streaming by default** (`stream: request.stream ?? true`). A streamed probe is the only one that
    observes time-to-first-byte, and it keeps the connection open while a reasoning model thinks instead of
    waiting for a complete body. An explicit `stream: false` is still honoured.
  - **No reasoning intent unless asked** (`reasoningEffort` omitted or `auto`). `auto` is the default
    because the probe's job is to discover what a route does: forcing an effort onto a model that does not
    support reasoning turns a working route into a failing probe. A specific effort
    (`PROBE_REASONING_EFFORTS`, which includes `auto` so the request type and the route schema project one
    list) is forwarded only when the operator picks one — which is what lets the dashboard's section-wide
    Thinking selector, in the Models card header beside "Fetch models", make every test in that card follow
    one setting.
  The empty-content retry raises the output allowance and forces streaming, so a model that spends its
  budget reasoning before emitting text still produces a sample.
- **Wire reconciliation.** `applyDiscoveredWire` merges a discovered wire family/endpoint onto a registered
  model for probing without mutating the catalog; `staticEndpointForWire` maps a wire family to the
  provider's own bundled-catalog path and backs explicit-wire probes plus manual registration. Probing takes
  its outbound fetch from `ProbeOutboundResolver`, which may return a pool-bound binding carrying fetch +
  `networkPoolId` + `release`.

Rules: discovery never imports console presentation types — probe contracts live here so the lower layer
stays console-free. Failures yield `null` or a `ProbeModelResult` with `ok: false`, never a thrown dispatch
error. Credential-free discovery may be cached (see Operations); credential-scoped discovery is never cached
here, because entitlements must reflect the caller's account. Upstream arrays and numbers pass through
bounded-array and bounded-number guards so a hostile `/models` payload cannot blow up memory. A wire family
is never taken from the discovery payload alone: the generic `/models` fetcher carries no wire information
and guesses from the model id, so `applyDiscoveredWire` admits a guess only when the provider's own contract
(`supportedWireFamilies`, from the registry or the BYOK profile) contains it. Without that gate a
Messages-only custom provider was discovered onto `chat` rows its adapter rejects at dispatch with
`capability_unsupported`, and a chat-only OpenAI-compatible provider inherited the `responses` guess for
`gpt-5`/`o3`-style ids. A corrected wire family moves a model to a new `(model, endpoint)` row, so a sync
also prunes that provider's superseded `discovered` rows for the ids it resolved.

That gate corrects *derived* sources only — a stored row, a bundled catalog row, or a discovery guess. An
explicit `ProbeModelRequest.wireFamily` is the operator naming the wire themselves and passes through
untouched: a manually added provider may serve a protocol the gateway carries no bundled knowledge of, and
silently rewriting the pick would probe a wire other than the one requested. Dispatch applies no
wire-family gate of its own for the same reason — the upstream is the authority on which protocols it
answers, and `supportedWireFamilies` is published metadata (the Add-Model selector's default order), not an
enforcement boundary. A family the provider does not declare still reaches the upstream and fails there,
which is the real answer.

## Operations: runtime glue

Runtime glue between the static registry and the database: seeding, layered caches, client-version
resolution, account health, credential decryption, CLI identity headers, session affinity, upstream
deadlines. Routing, console, and discovery consume providers through these services — never by importing
`integrations/` or hardcoding hosts, versions, or health thresholds.

- **Catalog materialization.** `seedBundledProviders` idempotently inserts every `BUNDLED_PROVIDER_MODULES`
  row (`onConflictDoNothing`, then a compatibility-profile merge `UPDATE`), and `retireUnbundledProviders`
  prunes the global rows whose id the bundle has retired, so a provider removed from `provider-metadata.ts`
  cannot leave a card behind. `seedBundledModels` persists the
  compiled `ModelDefinition` maps and deletes stale `builtin` rows by the `(model, endpoint)` composite key,
  so a moved endpoint never leaves a duplicate dead route. That deletion makes a static catalog list the
  *owner* of its `builtin` rows: nothing else prunes one, so an id the upstream has retired keeps its
  catalog card — and its route — until it is removed from the list. A seed row is only useful while the
  provider still serves it, so a roster the provider publishes (Cline's `/ai/cline/recommended-models`,
  read by `fetchClineRecommendedModels`) is the authority for what belongs there, and the static list is
  the offline seed that makes a fresh install usable before the first fetch.
  `registerByokProviders` / `syncByokProvider` wire
  tenant-supplied endpoints with SSRF validation.
- **Three cache layers.** `getCachedModels` caches the loader *promise* per provider for the process lifetime
  (LRU-bounded, failures evicted so they retry). `getCachedModelDiscovery` caches only credential-free
  discovery (e.g. Cline's public roster) for 10 minutes. `getCachedVersion` caches version strings in a TTL
  cache (5-minute default; the resolver's own is 30 minutes) with backoff retry and single-flight dedupe.
- **Client-version resolution.** `createClientVersionResolver({ key, fallback, sources, minVersion? })`
  returns a sync `get()` plus async `ensure()` / fire-and-forget `refresh()` and test-only `reset()`.
  Resolution order is discovered → pinned fallback, so a stale version always beats blocking dispatch; there
  is no environment override. Sources default to npm-style `version` / `dist-tags.latest` JSON, covering npm,
  PyPI, and plain-text release pointers; WorkBuddy desktop additionally reads the official
  `https://www.workbuddy.ai/v2/update?platform=workbuddy-win32-x64-user` manifest because its
  four-segment desktop build version is not standard semver. `minVersion` discards any discovered version below it —
  trap: npm's `cline` package is the 3.x CLI while Cline's API gates on the 4.x extension version, so probing
  npm first "upgraded" Cline 4.1.18 → 3.0.62 and the API rejected every request with "please make sure you're
  using the latest version". Discovery must move a client forward, never backward.
- **Account health machine.** `classifyAccountError` maps failures to `AccountErrorCategory` (`quota_exhausted` /
  `rate_limit_transient` / `model_capacity` / `auth_invalidated` / `policy_blocked` / `server_error` / `timeout` /
  `unknown`), an
  origin (`cartethyia`/`upstream`/`network`), and a scope (`account`/`provider`/`model`/`pool`/`tenant`/`request`/
  `network`/`unknown`). `recordAccountFailure` applies per-category fallback cooldowns, each read from
  `src/config.ts` (`CARTETHYIA_ACCOUNT_RATE_LIMIT_COOLDOWN_MS` 15m, `CARTETHYIA_ACCOUNT_QUOTA_COOLDOWN_MS` 1h,
  `CARTETHYIA_ACCOUNT_MODEL_CAPACITY_COOLDOWN_MS` 2m, `CARTETHYIA_ACCOUNT_TRANSIENT_COOLDOWN_MS` 30s,
  `CARTETHYIA_ACCOUNT_UNCLASSIFIED_COOLDOWN_MS` 1m) so an operator can retune the machine without a code change.
  An upstream `Retry-After`/`x-ratelimit-reset` header or a duration quoted in the provider message always wins
  over the fallback. xAI Grok Build is the one pinned provider rule: its free-tier exhaustion
  (`subscription:free-usage-exhausted`, "included free usage", "rolling 24-hour window") is a 24h
  `quota_exhausted` cooldown — never the generic 1h fallback, so the account cannot re-enter rotation inside
  the provider's own reset window. The account state machine has three states: `active`, `cooldown`, and
  `disabled`. `degraded` was retired because it mixed two facts that each need their own value — a fault that
  clears on its own (a cooldown, which carries a deadline) and a fault needing an operator (disabled). Every
  non-`active` classification except `disabled` carries a `retryAt`, because `sweepExpiredCooldowns` selects on
  `cooldownUntil IS NOT NULL`: a row with a null deadline would never be swept back and would stay out of
  rotation until an operator restored it by hand. `disabled` is deliberately permanent — a rejected credential
  with no OAuth-refresh recovery path is not swept, so it carries a null deadline. A cooling account is
  deprioritized rather than excluded: `EligibilityEvaluator` keeps it eligible and `plan()` orders it after
  every healthy sibling, so a healthy account is always tried first. When *no* healthy sibling is left —
  every eligible candidate is cooling — `plan()` throws `accountsRateLimitedError` (429) instead of dialing a
  cooling account, which could only reproduce the refusal that cooled it. A bare upstream 402 is a quota cooldown, but a price refusal
  (`no provider's ask matches your max-per-mtok bid`) is a verdict on the request, not the account: it is
  recorded with `mutatesAccount: false` so only that request fails. Only real credential evidence disables: deterministic
  content-policy rejections (`11140` and its safety-review phrasing) and hosted-tool failures
  (`web_search`/`x_search`/`web_fetch`) are excluded, because refreshing the token cannot change them.
  The buddy family (`cb`/`cbcn`/`workbuddy`, declared once as `BUDDY_PROVIDER_IDS` in
  `provider-metadata.ts`) is the one exception, and only as a cooldown: its `11140`
  block persists across every subsequent invocation, so the account is parked in a 24h
  `policy_blocked` cooldown (never `disabled` — the credential is valid and the block clears upstream)
  to stop routing from selecting it.
  A 402 is quota-shaped and cools down rather than disabling, and a 407 is `network`-origin so it can never
  mutate an upstream account.
  `reportAttemptOutcome` is the per-attempt hook, `recoverAccount` / `sweepExpiredCooldowns` run recovery, and
  every transition is journaled to `healthEvents`. A throttle (`rate_limit_transient` / `model_capacity`) with
  a `modelId` cools the **(account, model)** pair through `modelCooldowns` instead of the account, so the
  account stays routable for every other model. That write is model-scoped in its audit row too: the row
  records the account's own status on **both** sides (`fromStatus`/`toStatus` both `active`) and names the
  model, because a per-model throttle never moved the account and a row claiming `active → cooldown` sat
  directly under a dialog reading "Account status: ACTIVE". A re-stated throttle inside an entry that is still
  in force refreshes the entry and its error fields but writes no second row: the upstream repeats the same
  reset on every retry, so per-failure rows read as an account flapping while nothing changed.
  The console reports those live backoffs beside the status,
  including **when** the soonest one clears — a cooldown is detection-based, so the deadline is the part an
  operator acts on, and a per-model throttle leaves `cooldownUntil` null, so a view reading only that field
  showed a 429 reason with no time at all. Both health dialogs build that line from one shared component, and
  the periodic `sweepExpiredCooldowns` pass prunes the elapsed keys.
  Recovery (`recoverAccount`, a consumed rate-limit reset) clears **every** routing exclusion — account status,
  `cooldownUntil`, and the per-model `modelCooldowns` map — because the routing catalog reads each of them
  independently: a recovery that left a per-model entry behind kept the account blocked for that model over the
  public API while the account read `active` and a direct probe (which addresses the account by id, bypassing
  routing eligibility) succeeded. A periodic quota check writes the error fields only while the account is
  `active`: for a parked account those fields are the health machine's reason, and a failing quota endpoint
  reported a whole provider as "Invalid or expired credentials", overwriting the `auth_invalidated` reason a
  dispatch 401 had just recorded.
  The periodic quota sweep (`listOAuthQuotaRefreshTargets`) skips accounts already marked
  `auth_invalidated`: a rejected credential does not repair itself, so every sweep is a guaranteed 401 that
  only re-confirms the row — the operator needs a re-login, and the console labels the account
  "Re-login required" rather than a bare `disabled`. Every other account is swept, `disabled` included, because
  a disabled row is not necessarily a revoked one and skipping it would let a credential die silently while the
  row still reads healthy. Clearing the mark is what returns an account to the sweep: replacing the credential
  or re-enabling the account (`updateAccount`) resets the same failure state `recoverAccount` does, so a
  re-authed account is probed again instead of sitting out of rotation forever.
- **Per-tenant provider concurrency and usage.** The effective request ceiling is
  `provider_routing_settings.max_inflight` for the (tenant, provider) pair, with the
  `__global__` row as fallback; when both are `null`, admission is unlimited. The route
  snapshot carries the resolved ceiling into the account-specific reservation bucket. The
  legacy `provider_accounts.max_inflight` column is **inert** — routing never reads it, and
  it must not be repurposed as a per-account override. Account responses report UTC-today
  usage from retained request telemetry and lifetime usage from `telemetry_usage_totals`.
- **Credential resolution.** `loadAccountWithFreshness` loads the account row plus its optional
  `provider_oauth_states` row in one query and computes `dueAt` as expiry minus the provider's refresh lead
  (`REFRESH_LEAD_MS`; default 5m). `resolveCredentialForAccount` decrypts the stored ciphertext into a dispatchable `ResolvedCredential`
  (triggering the refresh service when due); `resolveAccountSecretString` is the string-typed read beside it.
- **Dispatch-time request context.** `resolveCustomCliHeaders` stamps Codex-CLI identity
  (`codex_cli_rs/<version>`) on chat/responses traffic and Claude-CLI identity (`x-app: cli` + stainless
  headers) on messages traffic so upstream sees realistic first-party tooling. Both versions come from the
  live resolver getters (`getCodexVersion`, `getClaudeCliVersion`, `getClaudeSdkVersion`), not the frozen
  `claude-fingerprint` constants, so a custom Anthropic endpoint tracks discovery instead of the pinned
  fallback it was built with.
  Probe dispatch preserves adapter-native `User-Agent` without injecting gateway-level markers.
  `resolveInboundSessionId` extracts affinity from session headers in declaration order (`x-conversation-id`, `x-session-id`,
  `x-session-affinity`, `x-opencode-session`, `x-claude-code-session-id`, `prompt_cache_key`,
  `prompt-cache-key`, `session-id`), then the canonical conversation id; when a client sends neither, it
  derives a stable `aff_<sha256 prefix>` key from the opening turn — the system prompt when it carries at
  least 30 characters, otherwise the first message's text — hashed over the first 2048 trimmed characters.
  A stateless HTTP client that repeats the same opening turn therefore keeps hitting the upstream prompt
  cache across turns instead of missing on every call. Text shorter than the threshold derives nothing, so a
  trivial prompt cannot collapse unrelated conversations onto one affinity key.
  `resolvePromptCacheKey(request, context)` prefers an explicit caller cache key from any surface
  (chat `prompt_cache_key`, responses `prompt_cache_key`, messages `metadata.user_id`) before that
  session fallback (headers on `context`, then conversation id), and never includes the client IP.
  Dispatch resolves that key once and threads it onto the dispatch context as
  `conversation_affinity`, which an adapter that mints its own session id consumes instead of
  a random value — `buildOpenCodeHeaders` sends it as both `x-opencode-session` and
  `x-opencode-request`. Without the pass-through a derived affinity never reached the header that
  carries it, and every turn minted a new upstream cache key.
  `withUpstreamDeadline` binds the dispatch `deadline` to an abort signal (aborts →
  `transport_closed` 499) with a releasable lifecycle so timers never leak. The deadline bounds **TTFB
  only**: a streaming adapter must call `lifecycle.release()` as soon as response headers arrive, because
  from there the gateway's stall/first-chunk watchdog owns the body. Leaving the timer armed silently
  truncates slow streams — `decodeSseEvents` cancels its reader on abort, the read resolves as *done*, and
  the decoder then synthesizes a `complete` terminal for a body it never finished reading.

Rules: only successful, non-empty values are ever cached — every failure path retries instead of pinning a
miss. `liveProviderUpstreamHosts` is the single source of upstream origins for SSRF binding; no second host map. Health cooldowns are parser-driven with short deliberate fallbacks; unknown
quota cadence parks an account for 1h, not 24h, and self-corrects on re-probe. Credential ciphertext is
decrypted only inside this layer (plus the refresh service); adapters receive plaintext via
`ResolvedCredential`.

## Integrations: one adapter per provider

The only layer that knows a provider's wire envelope, auth headers, OAuth endpoints, quota shapes, and
CLI-version quirks. The registry consumes these modules lazily — every `loadAdapter`, `loadQuotaCollector`,
and `loadModelDiscovery` is a dynamic import — so nothing here may run at startup time. Pure helpers
(`connect.ts`, `buddy-*-shared.ts`) are the exception: no provider identity, imported freely.
(`reasoning.ts` is likewise pure but sits one level up in `src/providers/`.)

**Generic `ApiKeyProviderSpec` rows** (preferred for OpenAI-compatible, bearer-auth hosts) declare data only:
`provider_id`, `endpoint_paths_by_wire_family`, `extra_headers` /
`buildExtraHeaders`, `prePayload`, `prepareRequest`, `credential_forwarding`, `promptCache`,
`gatewayUserAgent`.
`createApiKeyAdapter(spec)` builds the `OpenAICompatibleAdapter`, and `base_url` defaults to
`providerBaseUrl(provider_id)` so the origin has exactly one declaration. `GENERIC_API_KEY_SPECS` (in
`integrations/configured-openai-providers.ts`) covers the zero-hook
hosts (`mistral`, `fireworks`, `nvidia`, `gmi`, `ollamacloud`,
`deepseek`); other single-file specs add hooks only where needed. A zero-hook host declares no
`loadModels`, so any model list it offers is live discovery only — `ollamacloud` and `deepseek`
both pair the shared spec with an `openAIModelDiscovery` loader for exactly that reason.
`zai/spec.ts` shows the credential-codec variant
(`extractAccessTokenOrRaw` + `credential_forwarding: "never"`).

**Bespoke adapters** stay hand-written classes implementing `ProviderAdapter` when the wire is outside the
factory's reach, each carrying a `Factory-blocked` or `Bespoke by wire protocol` header comment naming the
reason: `anthropic.ts` (Messages envelope + `x-api-key`), `gemini.ts` (per-model `:generateContent` RPC +
`x-goog-api-key`), `claude-code/claude.ts` (the assistant CLI fingerprint: Stainless identity headers, beta negotiation, CCH billing, and a persisted per-install `device_id` in `metadata.user_id`), `codex/codex.ts`
(Responses envelope + session headers; `protocol/request/codex.ts` emits tool results from both Chat `tool` and Messages `user` turns as `function_call_output` with the matching `call_id`), `devin/` (Connect+protobuf), `kiro/` (a `conversationState` ledger over an AWS EventStream binary wire, below), `qoder.ts` (COSY AES/RSA
signing + enveloped SSE), `commandcode.ts` (NDJSON thread/config envelope), `agentrouter.ts`, `kimi/kimi.ts`
(Messages envelope reusing the shared Claude pipeline).

**Kiro's wire is not chat-shaped, and its auth is not one flow.** `kiro/kiro.ts` posts a
`conversationState` ledger (`kiro-request.ts`) to a CodeWhisperer `generateAssistantResponse` operation and
reads back an AWS EventStream binary frame sequence (`aws-event-stream.ts` verifies both CRCs; `kiro-stream.ts`
interprets the event types). Three things there are load-bearing:

- **The conversation must be expressible before it is sent.** The upstream answers an unreconcilable ledger
  with a terminal `400`, which is not retried and cools the account, so `buildKiroWireRequest` refuses
  locally and the adapter raises the error without spending a request. It repairs what it can (merging
  adjacent same-role turns, pairing tool results with their calls, sanitizing tool names/ids to the wire
  limits) and reports only what it cannot.
- **Endpoint choice follows the auth family.** Amazon's `q.*`/`codewhisperer.*` surfaces are tried first and
  the vendor gateway last, because the vendor gateway rejects the token families this gateway issues with a
  terminal `400` while Amazon answers a foreign token with `401`/`403` that rotate.
- **The profile ARN comes from the account, or from its sign-in family's public default.** Every
  profile-scoped surface — generation, usage, and the model catalog — refuses a request that omits
  `profileArn` (`400 profileArn is required for this request.` / `400 Invalid profileArn.`), and no surface
  enumerates an account's profiles: `ListAvailableProfiles` refuses a Builder ID outright
  (`403 AWS Builder ID is not supported for this operation.`). An account's own resolved profile therefore
  wins, and one that resolved none is served by the public default for its family — builder for
  Builder ID/Identity Center/imported, social for Google/GitHub, because the builder default under a social
  token is answered `403 Invalid token`. An API key and an enterprise IdP export are scoped by the credential
  itself and never receive a default. `resolveKiroProfileArn` in `kiro-profile.ts` is the single place this is
  decided, shared by dispatch, quota, and discovery.

`kiro-oauth.ts` covers every sign-in path (AWS Builder ID, Identity Center, Google/GitHub, imported
refresh token, enterprise identity provider, API key), which differ in endpoint, refresh mechanics, and which
surface accepts the result. Two details are specific to it: AWS SSO OIDC answers camelCase JSON rather than
the snake_case form encoding the rest of the kit speaks, and its device flow mints a client secret that must
be replayed at every later refresh — carried as `client_secret` beside the tokens, never in `auth_state`.

**Editor BYOK is not a bundled integration.** A client's own API-key/editor BYOK path is a client
of the gateway's OpenAI Chat Completions surface, not a provider adapter: configure the
OpenAI-compatible Cartethyia base URL (`/v1`), a Cartethyia API key, and a model ID exposed by
`/v1/models`. Do not assume a local-only Cartethyia URL is reachable from a hosted editor — its own
API-key requests may be routed through the vendor's backend for prompt building, and a global Base
URL override can also affect the vendor's managed models with no per-model endpoint support. Verify
against the installed editor build before promising Responses, reasoning models, or Tab completion.

A bespoke adapter frames its own protocol, so no canonical wire codec serves its rows. That fact is
declared once per provider as `bespokeWire` in `provider-metadata.ts` (Devin and Kiro are the bundled
cases) and carried into the route snapshot as `capability_profile.bespokeWire`. Two consequences follow
from it, and both used to be expressed by a fourth `native` wire-family value that is now retired:

- **Rich content is gated, not assumed.** The chat/responses codecs encode `image`/`document`/`audio` parts and the messages
  codec encodes `image`/`document`, so a codec-backed route carries them by default (audio is narrowed to the wires that
  define an audio block — see the capability ladder above); a bespoke adapter
  frames requests by hand and would drop a part it does not handle, so only an explicit modality in the
  row's `modalities` grants the capability there.
- **Generation controls are not filtered.** `GENERATION_CONTROL_MATRIX` describes what a *codec* can
  re-encode. A bespoke adapter reads the fields it understands straight off `generation_controls`, so it
  receives the permissive set instead of being narrowed by a wire matrix no codec is involved in.

`native` never was a protocol — it was a marker for exactly this, sitting in the same enum as the real
families, which made it an operator-selectable wire choice that died inside the codec with an untyped
`unsupported wire family: native`. The marker now lives on the provider, where it describes the adapter
rather than the wire, and the operator vocabulary is the three real protocols.

Qoder's enveloped SSE failures use the same structured identifier/status classifier as ordinary upstream responses.
The original provider status and code are preserved in error details, while `origin: "upstream"` prevents a provider
failure from being misreported as a network-pool fault.

| Directory | Shape | Contents |
|---|---|---|
| Single-file (`openai.ts`, `gemini.ts`, `openrouter.ts`, …) | `*_SPEC` or adapter class, plus a `*_MODELS` catalog where the provider ships one (openrouter relies on live discovery) | Whole provider contract; `loadAdapter` imports it directly |
| `claude-code/` | `claude.ts` + `claude-{betas,cch,compatibility,credentials,fingerprint,oauth,quota}.ts` | Header/credential/beta/billing policy split by concern |
| `codex/` | `codex.ts` + `codex-{device-code,errors,headers,identity,oauth,quota}.ts` | Identity + headers + error + OAuth/refresh split; one turn-metadata serialization is reused in the header and request body |
| `devin/` | dispatch + `catalog.ts` + `devin-{oauth,quota}.ts` + `generated/` | Protobuf wire; hand-written wiring only outside `generated/` |
| `antigravity/`, `cline/`, `kimi/`, `grok/`, `muse/` | `<name>.ts` + `<name>-{oauth,quota}.ts` (+ `shared`/extra splits where the provider needs them) | OAuth login, quota parser beside the adapter |
| `xai/` | `xai.ts` + `xai-{oauth,discovery}.ts` | The **paid** xAI subscription surface at `api.x.ai/v1` (SuperGrok / X Premium+), separate from `grok/` (the free Grok Build CLI at `cli-chat-proxy.grok.com`). Plain OpenAI Responses wire, so the shared adapter serves it; the device flow and client id are xAI's, shared with `grok/` because they are facts about the authorization server rather than about either product |
| `kilo/` | `kilo.ts` + `kilo-{oauth,discovery}.ts` | OAuth login with no refresh grant; its own directory reader because the catalog is OpenRouter-shaped, not OpenAI `/models` |
| `github/` | `github.ts` + `github-{oauth,discovery,quota}.ts` | Device-code login that mints a short-lived Copilot token from the GitHub one; bespoke adapter because the API host comes from the credential; its own directory reader (per-SKU `supported_endpoints`, nested limits) and a quota reader off the token endpoint |
| `buddy/` | per-brand `codebuddy*.ts` / `workbuddy*.ts` (adapter, oauth, quota, cn split) over shared `buddy-{catalog,chat,oauth,quota,discovery}-shared.ts`, plus `buddy-checkin.ts` | Tencent buddy family (provider IDs `cb`, `cbcn`, `workbuddy`): per-brand headers and cn split; billing reads send the reference filter envelope (`ProductCode: p_tcaca`, statuses `[0, 3]`, 101-year package window) and `X-User-Id` when the credential carries a UID — an empty `{}` can return success with zero packages; plus the `daily-checkin` worker's check-in + growth report |
| `zai/` | `spec.ts` + `zai-quota.ts` | Minimal pair: declarative spec plus one quota parser |
| `xiaomi-mimo/` | `xiaomi.ts` (API-key pair), `mimodesktop*.ts` (oauth/quota/sso + adapter), `mimostudio*.ts` (auth/oauth/quota/session/tools + adapter), `think-stream.ts` | Four provider IDs with independent credentials and wire contracts: `xiaomipg`/`xiaomitp` use API-key OpenAI chat, Desktop exchanges a local passToken for an SSO cookie and uses native `reasoning_content`, and Studio uses browser cookies and its own SSE parser with the think-tag splitter. Desktop and Studio retain separate models and quota collectors. |

MiMo Desktop acquires its inference cookie from a stored passToken at dispatch time, reuses
the SSO session while cached, and renews it when the cache expires or a credential-evidenced
401 enters the OAuth refresh path. The passToken is never forwarded as an inference bearer;
`User-Agent: miNative …`, `X-Mimo-Source: mimocode-cli-free`, and `X-Client-Version` remain provider-owned.
Streamed Chat dispatch sends `stream: true` and `Accept: text/event-stream`;
non-stream calls use `Accept: application/json`. The normal OpenAI chat decoder
forwards SSE reasoning/text deltas as they arrive rather than buffering until completion.

**Known upstream characteristic.** MiMo Desktop's `/api/route/chat/completions` sits behind
Xiaomi's `MiFE` edge proxy, which batches the SSE body into a few large bursts instead of
flushing per token (the native desktop client hides this by dropping `mimo:chatReason`).
The gateway forwards each burst as it arrives, so the stream is live but chunky, and a short
answer can land in one or two frames. MiMo Studio's bot endpoint flushes per token and stays
smooth. This is an upstream property, not a gateway buffering defect — do not add a
gateway-side delay or re-chunking to mask it.
MiMo Studio instead replays pasted browser cookies with `Origin`, `Referer`, a browser
User-Agent, and `x-timezone`; a pasted Studio cookie is **not** a renewable OAuth grant.
Its SSE dispatch streams text and thinking deltas as frames arrive and marks EOF without
an upstream finish marker as failed. The Studio quota URL currently answers 404 upstream;
do not treat that response as evidence the session expired or as proof of a refresh grant.
The `conversationId` in the bot-chat body is resolved per provider account rather than
minted per request: an inbound session id (see `resolveInboundSessionId`) pins one upstream
conversation, and otherwise a history that extends a tracked turn range continues that
conversation. Two callers on one account therefore never share a thread, and a chat keeps
its own across turns. Because the upstream keeps the conversation's history server-side, a
resumed turn sends only the turns the upstream has not received — which is also what keeps
a long chat inside the endpoint's limit. The affinity is in-process with a TTL and a bounded
LRU, so a restart starts new conversations; the pasted cookie has no refresh grant to
persist against anyway.

The bot-chat endpoint has no structured tool protocol: it ignores a `tools` field and takes
one `query` string. Tool use therefore travels in the prompt, and the gateway adopts the
convention MiMo models already emit
(`<tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>`) rather
than teaching a different one, which they ignore. Closed blocks become canonical
`tool_call_delta` events with `stop_reason: tool_use`, history tool calls and results are
replayed as the same blocks (a `tool` turn travels as `user`, the only non-assistant role the
endpoint accepts), and with no declared tools a block stays prose so the gateway never
invents a call. The `query` field is bounded below the measured upstream limit — the endpoint
answers HTTP 200 with an in-band `query is too long` error once the request envelope exceeds it —
by dropping the oldest turns and marking the omission; the model's own context window is
far larger, so this is a property of the request envelope, not of the model. An in-band
`error` frame is surfaced as a typed gateway error (413 for the length rejection, 409 for the
duplicate-submit rejection) instead of ending the stream without a terminal event.
Studio UltraSpeed (`mimo-v2.6-pro-ultraspeed`, wire id `mimo-v2.6-pro-ultraspeed-studio`)
is **not** on `/open-apis/bot/chat` — that path answers `模型名称错误`. The `#/ultra` UI
calls `/fastchat/open-apis/…`, so UltraSpeed models declare endpoint
`/fastchat/open-apis/bot/chat` and the adapter builds the URL from the routed
`endpoint_path`. Flash/pro stay on `/open-apis/bot/chat`.


The CodeBuddy family (`buddy/`, provider IDs `cb`, `cbcn`, `workbuddy`) shares `buddy-chat-shared.ts`, `buddy-quota-shared.ts`,
`buddy-oauth-shared.ts`, and `buddy-catalog-shared.ts`. The last owns the seven-field `BuddyRawEntry` tuple
and `makeBuddyModel`, because the intl/CN/WorkBuddy static catalogs describe their rows identically and
differ only in the wire endpoint the row targets (WorkBuddy's base URL carries no version segment, so it
passes `WORKBUDDY_CHAT_PATH` explicitly). Identity headers stay per provider — `codebuddyHeaders` and
`workbuddyHeaders` send genuinely different bytes. All three variants (`cb`, `cbcn`, `workbuddy`) share the upstream chat contract —
mandatory `stream`, `reasoning_summary` only with a `reasoning_effort`, agent-field stripping, and
coalescing adjacent assistant items (including parallel function calls) into one Chat turn so
replayed `reasoning_content` stays on that turn. Tool outputs and user turns remain boundaries;
missing reasoning is never fabricated. The shared message-envelope tail (`finalizeBuddyMessages`)
coalesces consecutive `user` turns, drops empty-content turns the upstream rejects with `11151`,
and guarantees a leading `system` turn for `11128`.

`applyBuddySystemPrompt` installs the variant's fixed persona as that leading `system` turn **and keeps the
caller's own `system`/`developer` text behind it**, joined with a blank line: the upstream validates that the
wire *opens* with a `system` turn (`11128`/`11151`) but does not constrain its text, so merging is safe and
prompt caching keeps hitting the same prefix. Dropping the caller's text — the earlier behavior — threw away
the system prompt the client actually configured. The CN variant installs a neutralizer the same way. A request
bound for any of the three additionally drops incomplete tool rounds in the preparer (`dropIncompleteToolRounds`):
the buddy gateway rejects a partial batch outright with `11148`, where the generic policy synthesizes an
error-labeled placeholder result for strict Anthropic/Gemini wires. They share the Tencent billing-meter
envelope (`data.Response.Data.Accounts[]`), so `buddy-quota-shared.ts` owns the refill vs bonus split, cadence
labels, and bonus numbering, while each `*-quota.ts` keeps only its endpoint, identity headers, and display
name. Their device-login endpoints answer one `{ data: { accessToken, refreshToken, tokenType, expiresIn } }`
envelope read by `buddy-oauth-shared.ts`. That module owns the whole device login — the state POST, the
token poll that answers the `11217` pending code, the refresh POST, the identity header set, and the JWT
account label — as one `BuddyOAuthClient` parameterized over a `BuddyOAuthVariant`, so each `*-oauth.ts`
holds only its variant: endpoints, domain, platform, user agent, and envelope-code reading
(`strictResponseCode` for CodeBuddy, `coercingResponseCode` for WorkBuddy's gateway, which answers a
looser envelope).

**Protobuf dirs.** `devin/generated/**` is `buf generate` output
(protoc-gen-es) — never hand-edit; regenerate from the vendor proto source and update `.codegen-stamp` (check
the current prefix with `head -c 8 src/providers/integrations/.codegen-stamp`). Only the adjacent hand-written
modules are edited for those providers.

**Version pins.** CLI-impersonating providers use the shared `operations/client-versions.ts` table (backed by
`createClientVersionResolver` and `provider-version-cache.ts`); each entry defines its key, fallback,
`minVersion` guard, and sources, and resolution is always discovered → pinned fallback so dispatch never
blocks on the npm/vendor lookup. Keep provider-specific fingerprint parsing beside the table only when the
upstream identifier is not a normal version source.

**Adding an entry costs one row plus its accessors.** `accessor("<key>")` generates the four accessors
(`get` / `resolve` / `refresh` / `reset`) from the entry's resolver, so a new row does not hand-write them —
the quadruple used to be four bodies per entry, which is how an entry could ship without one or read the
wrong resolver. Declare a named export against the generated accessor when callers read better with it, and
write a body by hand only when it seeds more than one resolver (`_resetClaudeVersionCache`) or needs a
different fetcher type (`resolveKiroVersion` takes the narrower `FetchLike`). Provider-specific header
builders (`buildKiroUserAgent`, `buildGrokUserAgent`) stay hand-written: they encode wire bytes, not lookups.

**Where each pinned fallback comes from.** The table below records the lookup for every entry, so refreshing a
pin is a fetch rather than a hunt. `client-versions.ts` is the single source of truth for the *values*; this
table records only *where they were read from*.

| Entry | Source | Read |
|---|---|---|
| `qoder` | `registry.npmjs.org/@qoder-ai/qodercli/latest` | `version` |
| `opencode` | `registry.npmjs.org/opencode-ai/latest` | `version` |
| `commandcode` | `registry.npmjs.org/command-code/latest` | `version` |
| `grok` | `storage.googleapis.com/grok-build-public-artifacts/cli/stable`, then `registry.npmjs.org/@xai-official/grok/latest` | plain-text version, then `version` |
| `clineClient` | `raw.githubusercontent.com/cline/cline/main/apps/vscode/package.json` | `version` (the **extension**, not npm `cline`) |
| `clineSdk` | `registry.npmjs.org/@cline/sdk/latest` | `version` / `dist-tags.latest` |
| `codex` | `registry.npmjs.org/@openai/codex/latest` | `version` |
| `workbuddyClient` | `workbuddy.ai/v2/update?platform=workbuddy-win32-x64-user` | `productVersion` (four-segment build) |
| `workbuddyCli`, `codebuddy` | `registry.npmjs.org/@tencent-ai/codebuddy-code/latest` | `version` |
| `kimiCli` | `pypi.org/pypi/kimi-cli/json` | `info.version` |
| `kiro` | `kiro.dev/downloads/` | `currentVersion` in the official IDE download metadata |
| `claudeCli` | `registry.npmjs.org/@anthropic-ai/claude-code/latest` | `version` |
| `claudeSdk` | **no source** — see below | — |
| Antigravity (`antigravity-protocol.ts`) | `antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml` | `version:` line of the electron-builder manifest |
| Devin IDE + extension (`devin.ts`) | `docs.devin.ai/desktop/releases` and the VS Code Marketplace entry `Codeium.codeium` | release list, and the extension's `version` |

Kiro's versioned inference and API-key-validation User-Agents share the latest
IDE release. The legacy CodeWhisperer discovery and quota routes keep their
separate `KiroIDE` fingerprint because those endpoints validate a different
User-Agent shape; their AWS SDK/service version tokens are not the IDE release version.

Kiro's data-plane User-Agent is the one client identity that cannot be
discovered at runtime: the generation surface is served by the AWS SDK client
the IDE ships (`@aws/codewhisperer-streaming-client`), so its version is pinned
in `client-versions.ts` from the shipped build. To refresh it, take the value
from the installer — never from a guess:

1. Download the Windows IDE build from the vendor feed, whose path repeats the
   release version:
   `https://prod.download.desktop.kiro.dev/releases/stable/win32-x64/signed/<v>/kiro-ide-<v>-stable-win32-x64.exe`
2. Unpack it. The exe payload is an LZMA stream behind a 4-byte tag: `7z x` the
   exe, strip the 4-byte tag from the extracted `[0]`, then `7z x` that as LZMA.
3. In the unpacked payload, find the agent bundle — the region that defines
   `getCodeWhispererStreamingClient` — and read the aliased package metadata
   inside it: `"@aws/codewhisperer-streaming-client" … version:"x.y.z"`. One
   installer also embeds other bundles holding older copies of the same
   package, so a bare version match anywhere in the payload is not evidence;
   read it from the region the agent actually imports.

The `md/nodejs#` segment is the runtime the client executes under — the IDE is
an Electron app, so it is Electron's bundled Node, not the host's. The app's
`package.json` pins `"electron": "<version>"`; that release's metadata supplies
the Node version. The `os/win32#<build>` segment is the host Windows release and
therefore varies per machine.

The Kimi version source is the archived legacy `kimi-cli` package: the OAuth
adapter deliberately keeps its `kimi_cli` request identity. The replacement
`kimi-code` CLI reports `kimi_code_cli`, which the coding API rejected in favor
of `kimi_cli` in the verified [Kimi Code issue](https://github.com/MoonshotAI/kimi-code/issues/636);
do not substitute the new package version or identity without upstream allowlist support.

The Marketplace entry is queried over its public API — no key needed:

curl -s https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery \
  -X POST -H "Accept: application/json;api-version=7.2-preview.1" -H "Content-Type: application/json" \
  -d '{"filters":[{"criteria":[{"filterType":7,"value":"Codeium.codeium"}],"pageSize":1}],"flags":914}'
```

Two client versions remain manual pins because there is no reliable runtime
version source:

- **`claudeSdk`** is the `@anthropic-ai/sdk` version *bundled inside* the Claude Code release. The npm package
  is an installer wrapper and its platform packages ship a compiled binary; the standalone npm SDK is a
  different release line. The bundled version must be read from the binary's
  `anthropic-sdk-typescript/{version} userOAuthProvider` string.
- **Devin IDE / extension versions** are fetched manually from the official Desktop release page and
  Marketplace API when refreshing the pins. The update endpoint has no usable manifest, and the npm
  packages named `windsurf` / `devin-cli` are placeholders. Their request fingerprint versions remain
  static constants in `integrations/devin/devin.ts`.

Rules: `base_url` comes from `BUNDLED_PROVIDER_METADATA` via `providerBaseUrl()` — adapters that need to
override it (Cline, Grok Build, Muse Code, CodeBuddy, WorkBuddy) set it explicitly, usually to the same
manifest value. Adapters read auth only from
`context.credential`, never ambient config; `anthropic.ts` additionally rejects non-`api_key` credential
kinds. `ensurePayloadModel()` in `integrations/configured-provider.ts` backfills `payload.model` from the dispatch
candidate; a missing model is a 400, never an empty string. OAuth credential JSON envelopes are unwrapped at
dispatch (muse, zai) and never forwarded verbatim when `credential_forwarding: "never"` is set. Adapter test
fixtures live under `test/helpers/provider-dispatch.ts`; this directory holds no test-only module.

## Known limitations: reasoning visibility

Reasoning reaches a client through one of two wire shapes, and **which one a provider
offers is decided upstream, not by this gateway**:

- **Readable reasoning** — the provider streams the model's thinking as text. On the chat
  wire this is `delta.reasoning_content`; on the Responses wire it is
  `response.reasoning_text.delta` (canonical `payload`). `cb`, `cbcn`, `workbuddy`, and
  `mimodesktop` all take this path.
- **Summary only** — the provider streams a short heading via
  `response.reasoning_summary_text.delta` (canonical `summary`) and keeps the thinking
  itself server-side, handing back an opaque `encrypted_content` blob for replay.

`src/transport/surface/chat/encode.ts` (`eventReasoningText`) already forwards both, so no
adapter change is needed to surface whichever one a provider sends. The limitation is that
some providers never send the first shape.

**The ChatGPT Codex backend (`codex`) is summary-only and this is not addressable here.**
Measured against a live account (`gpt-5.6-luna`, effort `high`), `codex` returned a
heading-length summary while spending *more* `reasoning_tokens` than the readable providers
(`cb`, `workbuddy`) spent to return several hundred characters of thinking. Spending more
tokens to disclose less rules out a gateway-side cause: the model reasoned, and the server
withheld the trace.

Every lever that could plausibly widen it was tried and none changed the outcome —
`reasoning.summary` in `auto`/`concise`/`detailed`, `context: "all_turns"`, `store: false`,
the Responses Lite shape, the WebSocket transport (`responses_websockets=2026-02-06`), and
several model ids. Two spellings that look promising are rejected outright:
`reasoning.summary: "none"` and `include: ["reasoning.text"]` both answer `400`; the accepted
`include` values are the `*_call.results` / `*.image_url` / `code_interpreter_call.outputs`
family plus `reasoning.encrypted_content` and `message.output_text.logprobs`.

Do not re-derive this. Three further points are easy to misread from the wire alone:

- **`x-reasoning-included` is not a raw-reasoning switch.** It is a response header telling a
  client that past reasoning tokens are already accounted for, so the client must not
  re-estimate them for its context budget. It never carried reasoning text in any observed
  response.
- **Dropping `include: ["reasoning.encrypted_content"]` does not suppress the blob.** The
  server attaches `encrypted_content` to the reasoning item regardless of whether it was
  requested; output was identical with the field present, absent, and empty.
- **The blob is not needed for replay.** Replaying with it stripped, and replaying with no
  reasoning item at all, both answered correctly with the same reasoning-token count as the
  full replay. The server keeps its own reasoning state per conversation, so for OAuth ChatGPT
  a gateway may drop the blob without breaking multi-turn continuity. Verified on the HTTPS
  transport only; remote compaction (`/responses/compact`) and rollout-resumed sessions
  persist reasoning and were **not** tested.

The measurements cover only the providers that answered for that model; `github` and `kiro`
were not measured (an unrelated proxy-pool outage and a rejected model id), and the `openai`
API-key route had no account to test against — it may differ, since it reaches the Responses
API directly rather than through the ChatGPT OAuth backend. One run per provider was taken,
so the reasoning-token figures are indicative, not a distribution.

Anything that changes the reasoning bytes a provider sends is a change to that provider's
wire contract — check the adapter and the pinned client version before assuming a gateway
bug.

## How to extend

Adding a provider — checklist:

1. Metadata row in `provider-metadata.ts` (`id`, `displayName`, `baseUrl` + optionals).
2. Capability entry in `default-registry.ts: PROVIDER_CAPABILITIES` (the `satisfies` record forces it).
3. Adapter module: `createApiKeyAdapter` spec for OpenAI-compatible hosts, bespoke adapter otherwise — prefer
   a single-file `ApiKeyProviderSpec` unless the `Factory-blocked` wire comment applies.
4. Optional `*-oauth` / `*-quota` / discovery modules.
5. Static catalog via `defineModel` (`loadModels`).
6. For CLI-gated upstreams, add the provider entry and fingerprint extractor to `operations/client-versions.ts`.
7. Verify with `bundledModelCatalog()` + `seedBundledModels()` — conflicting endpoint paths throw, which is
   the signal to fix the registration.

Rules: keep provider imports lazy (dynamic `import()` per capability — protobuf adapters must stay off the
startup path); never cache credential-scoped discovery; never reset operator `enabled` in the seeder; never
hand-edit `generated/` protobuf output.

Per-subsystem extension rules: OAuth clients implement `OAuthLoginClient` (or extend `oauth-client.ts`),
register through `loadAuthentication`, and rely on `oauth-refresh-service.ts` — do not build a second refresh
path; declare a JWKS URL as `providerJwtVerification` rather than adding ad-hoc crypto. Simple
percentage-window quotas add `parseQuotaWindows` rows in `integrations/<name>/<name>-quota.ts`; bespoke shapes
write a dedicated parser with the shared guards and return `ProviderQuotaResult`; key-only providers need no
collector — `probeApiKeyConnectivity` is the account test. New discovery paths reuse
`fetchOpenAICompatibleModels` plus `modelsDevCatalog` — refresh the offline `base-models.json` snapshot with
`scripts/ci-generate-models-dev-snapshot.ts` when models.dev data goes stale, and add the provider id to
`MODELS_DEV_PROVIDER_IDS` if its models.dev filing name differs from ours, since the `ModelsDevCatalog` API
stays unchanged — probing and syncing
come free through `ProviderProbingService`. New catalog rows go through the seeder, new cacheable lookups
through `getCachedVersion` / `getCachedModelDiscovery` (never a bespoke `Map` with its own TTL), and new
failure modes through `classifyAccountError` categories — not inline status checks at call sites.

A provider that fronts a non-chat protocol (the System One decision API) declares those models with
`serviceKind` on `defineModel` and implements the matching optional adapter method (`ProviderAdapter.systemone`
— `OpenAICompatibleAdapter` already does, posting the opaque body to the row's own `endpointPath`). The row's
`wireFamily` stays `chat` as an inert placeholder (the column is `NOT NULL`); the native route dispatches by
`serviceKind`, never by `wireFamily`. Adding a whole new protocol is one `NATIVE_SERVICES` row, one
`ServiceKind` member, and one adapter method — see `transport/TRANSPORT.md` ("Native service routes").
