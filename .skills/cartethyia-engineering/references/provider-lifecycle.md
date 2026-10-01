# Provider lifecycle

Add, remove, configure, authenticate, and live-verify bundled and custom (BYOK) providers. Consolidates the add-bundled-provider, remove-bundled-provider, byok-custom-provider, provider-auth-handshake, provider-live-verification, oauth-login-client, provider-credential-notice, provider-account-action, model-not-found-catalog-prune, model-availability-curation, refresh-token-oauth-provider, mimo-provider-family, and autoclaw-family skills.

Provider ids are hyphen-free lowercase slugs by convention (`normalizeProviderSlug` permits hyphens, but every existing id is a single token).

## Add a bundled provider (all mirrors move together)

A provider is declared in several hand-maintained places that tests enforce as a set. Missing one fails loudly — work through this list rather than discovering it by test failure.

1. **Backend declaration (two files, both required):**
   - `src/providers/provider-metadata.ts` → add a row to `RAW_BUNDLED_PROVIDER_METADATA`. `baseUrl` is the single declaration of the origin (no version segment unless genuine); adapters resolve it via `providerBaseUrl(id)` and must NOT repeat it. Optional: `credentialUrl`, `wireFamilyDefault` (default `chat`), `requiresAccount` (default `true`; `false` only for a genuinely public endpoint), `defaultBypassProxy`, `jwtVerification`.
   - `src/providers/default-registry.ts` → add the matching key to `PROVIDER_CAPABILITIES` with lazy loaders. This is mandatory: the map is typed `satisfies Readonly<Record<BundledProviderId, ProviderModuleCapabilities>>` and `BUNDLED_PROVIDER_MODULES` throws at module load with `Missing provider implementation: <id>`. Every loader must be a dynamic `import()` — nothing in this layer may run at startup.

2. **Dashboard mirrors (hand-copies; dashboard must never import backend modules):**
   - `dashboard/src/lib/provider-names.ts` → `BUILT_IN_PROVIDER_DISPLAY_NAMES`
   - `dashboard/src/components/ProviderIcon.tsx` → `iconAssets` entry
   - `dashboard/src/routes/Providers.tsx` → `FREE_LIMITED_IDS` / `FREE_AVAILABLE_IDS` / `FOUNDING_IDS` (only if the provider belongs there)
   - `dashboard/src/lib/use-routing-strategy.ts` → `PROXY_UNSUPPORTED_HINT_PROVIDERS` (only if proxy routing must be withheld)
   - Icon assets live in `dashboard/public/providers/`; `scripts/build-icons.ts` maps generated `.webp` names to source `.png` art. Section placement is automatic: a provider not in any set and without `oauthFlows` lands in "API Key Providers".

3. **`endpointPathsByWireFamily`:** declare it in the registry when the chat path is not the built-in default; keep it in agreement with the adapter spec's paths. The contract is set equality — no file pins a provider *count*.

4. **Docs (same change):** `README.md`, `CHANGELOG.md` bullet under `### Provider ecosystem & protocol fidelity`.

5. **Env vars:** adding a `process.env.*` read requires a `CONFIG_SPEC` row in `src/config.ts` plus a `.env.example` line.

6. **Credential input:** `dashboard/src/lib/credential-extract.ts` owns `CREDENTIAL_FIELD_PRIORITY` and `OAUTH_SHAPE_FIELDS`. If the provider's secret field is named outside those lists, a pasted value is stored verbatim as a raw string — the credential parser must accept a bare-string form, or the provider is unconfigurable from the UI. Validate the JSON-object form strictly and treat a non-object literal as the raw token.

7. **Seeding:** `seedBundledProviders` (`src/providers/operations/provider-catalog-service.ts`) runs at boot and is `onConflictDoNothing` + update: it inserts and refreshes, never prunes. A brand-new provider needs a **process restart** before its row exists. A **renamed** provider leaves the old row behind, and because `isBuiltIn` comes from `BUNDLED_PROVIDER_IDS`, the stale row renders as a phantom *custom* provider — delete it explicitly (check `provider_accounts` and `models` for dependents first).

8. **Verify and smoke-test** through the real composition root (`createDefaultProviderRegistry()`), not unit stubs: adapter resolves with expected `provider_id`, models carry expected `endpointPath`, quota collector resolves, SSRF-bound `upstream_host` is the intended origin. Then the full gate, then `bun run build`.

## OAuth redirect URIs must match the allowlist exactly

Authorization servers allowlist `redirect_uri` as an exact string — `localhost` and `127.0.0.1` are different URIs even though they resolve to the same address.

1. Find the client's declared URI: `browserRedirectUri` on the `OAuthClient` subclass under `src/providers/integrations/<provider>/*-oauth.ts`.
2. Known-good values: Claude `http://localhost:54545/callback`; Antigravity `http://127.0.0.1:51121/oauth-callback`; Codex `http://localhost:1455/auth/callback`; OpenRouter `http://127.0.0.1:54549/callback`; ZCode `zcode://zai-auth/callback`.
3. The console route reads `browserRedirectUri` when present and reuses the same string at exchange; do not hardcode a different URI inside `exchangeCode`.
4. `OAuthCallbackListener` binds both `127.0.0.1` and `::1`, so a `localhost` redirect is still delivered.
5. `claude.ai/oauth/authorize` answers Cloudflare 403 to server-side fetches, so live login cannot be verified from the agent; verify by matching the allowlist and pin the URI with a unit test.

Auditing OAuth clients: enumerate `class \w+OAuthClient` in `src/providers/integrations` and compare authorize params, token body fields, required headers on exchange vs refresh, redirect URI allowlist, credential kind stored, and poll verdict handling. Known verified quirks: Claude token body needs `state` (callback may return `code#state`, fragment wins; refresh sends no `state`); Antigravity `loadCodeAssist`/`onboardUser` metadata must be `ideType: ANTIGRAVITY` with `onboardUser` enrollment (`tierId: "free-tier"`) before it has a project (login must provision, not just read); Zcode token body must carry the authorize `state`; GitHub Copilot uses one legacy OAuth app id where the reference selects per host (not a login break — flag, don't silently change); MiMo Desktop/Studio are intentionally not real OAuth (local session import — leave alone).

Verifying an OAuth flow in a real browser: console login + provider detail page, click Login/Sign in, read any device code from page text and **give it to the user** (only they can authorize on the provider site), poll the dialog state and report transitions with timestamps. On success, confirm the account row shows active AND dispatch a real request through a model the account owns. A model that exists in the catalog can still 400 (`model_not_supported` / `not available for integrator`) — that is entitlement, not an OAuth bug; run Fetch models and test a fetched id.

## Account export / import round-trip

- Export body (`POST /providers/:id/accounts/export`) is `{exportedAt, accounts:[{id,providerId,label,credentialKind,secret,status,createdAt,...}]}`.
- Import is client-side in `dashboard/src/lib/credential-extract.ts` (`parseCredentialBatch`), used by the Add Account modal. There is no server-side batch import endpoint.
- The parser must unwrap `{accounts|items|connections:[...]}` wrappers AND read export rows via `credentialKind`+`secret`+`providerId` (identity from `label`). Without those, a round-trip collapses to one entry and stores the whole JSON as an API key.
- Verify live: export via console API, feed the JSON through `parseCredentialBatch`, POST each entry back, probe the imported accounts like the originals. Delete test accounts afterwards with `DELETE /console/api/accounts/:id` (NOT under `/providers`).

## Refresh-token-only OAuth provider (no authorize endpoint)

When a provider has a token endpoint accepting `grant_type=refresh_token` but publishes **no** authorize/PKCE or device-code endpoint (user session lives in a desktop app's local auth file), the normal add-provider playbook is not enough: the provider must report **no** OAuth flow (no Login buttons — credential arrives by paste), and `createAccount` alone is insufficient (an OAuth account also needs a `provider_oauth_states` row, `refresh_ciphertext` NOT NULL, or the refresh sweep never finds it).

1. **Identity** — same metadata-row step as §Add (set `wireFamilyDefault` when not chat).
2. **Capabilities** — same registry step, with `loadAuthentication: oauthCapability(loader, "<id>OAuthClient", { withRefresher: true })`. `withRefresher` is what registers the refresher the sweep resolves; without it the account is unrefreshable after expiry.
3. **OAuth client** — `<id>-oauth.ts` extends `OAuthClient` with `supportsDeviceCode = false`, `supportsBrowserCode = false`, and a `refresh()` POSTing the form body and returning `{ access, refresh?, expiresAt }`. Leave `authorizeUrl` unset; do NOT implement `buildAuthorizeUrl`/`exchangeCode`.
4. **Adapter** — via `createApiKeyAdapter` / `withBearerAuthentication`, with a `prePayload` mapping user-facing aliases to upstream ids. `defineModel` rows carry explicit `endpoint`.
5. **Credential import** — a paste path writing both `provider_accounts` (access ciphertext, `credential_kind='oauth'`) and `provider_oauth_states` (`refresh_ciphertext`, `expires_at`). Reuse `DrizzleOAuthAccountStore.persistAccount`-style logic; do not call `createAccount` alone. The dashboard paste parser already detects `refresh_token`/`refreshToken`/`expires_at` shapes.
6. **Dashboard mirrors** — same display-name/icon/section steps; no `oauthFlows` edit needed (it derives from the registry and will be absent).
7. **Pitfalls:** a provider sharing a host with an existing one must not collide on `(provider_id, model_id, endpoint_path)` (`bundledModelCatalog()` throws at boot). Keep `expires_at` truthful: use the endpoint's `expires_in`; a far-future fake expiry suppresses the refresh the provider actually needs.

## Known provider quirks (verified, do not re-derive by guessing)

- **Antigravity thinking/streaming:** the thinking budget must derive from the LOGICAL model id in `buildAntigravityEnvelope`, not the wire id (`gemini-3.1-pro` → wire `gemini-pro-agent` contains no `gemini-3`, so `thinkingConfig`/`includeThoughts` is never sent). Verify the outbound payload, not just the client response (`payload.request.generationConfig`). Streaming frequently returns only an encrypted `thoughtSignature` part with no text; non-stream returns the thought text — that is upstream behaviour. Verify thinking is present when claimed.
- **Codex SSE in one blob:** ChatGPT Codex omits `content-type` and always answers SSE (even `stream:false`). `await res.clone().text()` waits for the whole body. Detect SSE as `request.stream === true || contentType includes "text/event-stream"`; for untyped non-stream bodies, peek only the first chunk and replay it (`sniffSseBody`). Never `text()` a possibly-streaming body. Verify with a raw TCP probe: success = many `data` events with non-zero gaps.
- **Codex cache misses:** header affinity (`x-session-id`, `prompt_cache_key`, …) only reaches Codex when dispatch `context` is passed into `resolvePromptCacheKey(request, context)`; the 1-arg form never reads headers. Body `prompt_cache_key` wins over headers. Codex threshold is ~1792 tokens: two identical calls below ~1800 prompt tokens show `cached_tokens: 0` even with a stable key — that is upstream, not a bug; prove a hit with a larger prefix.

## Remove a bundled provider (clean cutover)

No alias, no shim, no commented-out block.

1. **Scope first:** `for p in <id> <dir-name> <symbol-prefix>; do grep -ril "$p" src test dashboard scripts; done`. Check name collisions before deleting — e.g. `xiaomi.ts` (providers `xiaomipg`/`xiaomitp`) is a *different* provider from any MiMo surface, and `models.model_id` is shared across providers. Read every hit; do not delete on a name match alone.
2. **Delete files:** `src/providers/integrations/<dir>/`, dashboard icon asset.
3. **Central registries:** drop the `RAW_BUNDLED_PROVIDER_METADATA` row (plus any comment block that introduced it) and drop the whole capability block in `default-registry.ts`. The record is `satisfies Record<BundledProviderId, …>`, so a leftover block fails typecheck.
4. **Dashboard mirrors:** `provider-names.ts`, `ProviderIcon.tsx` (`iconAssets`), `scripts/build-icons.ts` (only if the icon file itself is removed).
5. **Per-provider helpers that go dead:** grep for exported helpers only that provider used, then delete the whole chain — source row, resolver entry, every accessor. The `resolvers` object is `satisfies Record<keyof typeof VERSION_SOURCES, …>`, so removing only one half fails typecheck.
6. **Shared hooks whose only implementor was the removed provider:** delete the hook from the interface AND its call site — do not leave a hook with zero implementors.
7. **Docs:** `README.md` + any prose list naming the provider, `CHANGELOG.md` bullets (beware line-wrapped bullets: deleting a line range can splice the next bullet's opening line — edit by exact string match, then read the surroundings).
8. **Residual sweep:** use Python or an out-of-repo script (a sweep inside the repo root matches its own patterns and reports false hits). Patterns: `<id>`, `<dir-name>`, `<SYMBOL_PREFIX>`, removed symbol names. Expect zero.
9. **DB catalog cleanup — seeding never prunes.** Delete by `provider_id` / uuid — **NEVER by `model_id`** (shared across providers). One transaction, verify both directions (survivors still there). Check `model_aliases`, `cli_tool_mappings`, `tenant_disabled_models`, `studio_sessions`, `api_keys` jsonb first. **`telemetry_events` is history and must NOT be deleted.** Never print credential values — select `provider_id, label, status, credential_kind` only.
10. **Gates + report:** typecheck, dashboard:typecheck, build. State what was deleted, deliberately-untouched surfaces, DB rows removed vs preserved. Do not commit unless asked.

## Custom (BYOK) providers — the wire contract is derived

Everything comes from `src/providers/operations/byok-wire-profile.ts` (`resolveByokWireProfile`, `byokAuthHeaderShape`, `stripEndpointBasePath`, `modelDiscoveryBaseUrl`). Derivation rules: an explicit `compatibility_profile.endpoint_paths_by_wire_family` names **exactly** the served families; otherwise a `chat` default serves `chat` + `responses` (bearer), and a `messages` default serves `messages` **only** (`x-api-key`). Consumers that must all agree: `registerByokProviders` / `syncByokProvider`, `discovery/probing-service`, `testByokConnection`.

Never re-hardcode `authentication_header_shape` or `supported_wire_families` for a BYOK row. Include `wireFamilyDefault` in the registration fingerprint or a wire-family change won't re-register.

`CompatibilityProfile` (`src/providers/provider-metadata.ts`) is validated twice on create/update: the Elysia route schema in `src/console/providers/catalog/routes.ts`, and `validateCompatibilityProfile` in `src/console/providers/catalog/contracts.ts`. Adding a field means adding it to **both** gates, plus an explicit type check, plus a `ProviderResponse` projection + `sanitizeProviderResponse`. Also verify the Drizzle `insert().values({...})` in `store.create` includes the field (a field can be accepted and dropped there).

Ad-hoc connection test: backend `POST /providers/connection-test` (declared **before** `/:providerId` routes) → `testByokConnection`; dashboard hook `useTestByokConnection`, button left of Paste in the `AddCompatibleModal` API Key row. Non-2xx and transport errors are **reported**, never thrown.

## Non-OAuth2 auth handshakes (cookie-jar flows)

For providers whose auth is a multi-step HTTP dance (redirects + Set-Cookie) rather than PKCE:

1. **The handshake must NOT use `context.outbound_fetch`.** `ValidatedFetch` is SSRF-bound and follows redirects internally (`redirect: "manual"` + manual loop): a 302 arrives as a 200 with no `Location`, and `stripCredentialsOnCrossOrigin` drops the jar on cross-origin hops. The adapter passes its own fetcher instead (`resolveSessionCookie(credential, fetchImpl)`). This adds no SSRF surface **only if** every handshake host is a module literal, never request-derived — state that in a comment. `outbound_fetch` stays correct for dispatch itself.
2. **Diagnose by diffing fetchers.** Run the same handshake through both transports and print status + `Location` per step; the divergence names the bug. Also diff the **stored** credential against the **live** source (SHA-256 prefixes, never values) to rule the credential out before touching transport.
3. **A non-2xx upstream is not always your bug.** A 403 with a provider business code (e.g. `membership_required`) means auth was **accepted** and the account lacks entitlement — report it as such.
4. **A self-contained login targets the console callback.** `browserAuthorizeRedirectUri()` returns the constant `http://127.0.0.1:59653/callback` where nothing listens; a popup sent there hangs on "Waiting for popup authorization…". Return `oauthCallbackUrl(providerIdForCallback())` instead, and override `providerIdForCallback()` when the lower-cased label is not the registered slug.
5. **Reading a local credential store:** Chromium holds its cookie DB under an exclusive lock while the app runs (`EBUSY` on read/copy/open) — copy to a temp file, open the copy, delete in `finally`; a failed copy surfaces as "quit the app, then retry", never a generic login failure. Probe multiple profile dir names; on Windows the cookie `value` column is often plaintext — check before adding a DPAPI path.
6. **Credential parsers need a raw-string fallback** (same paste-box rule as §Add): accept a bare string, reject empty values and JSON objects lacking the field. Regression-test that the SSO legs do **not** hit `outbound_fetch`, prove it is load-bearing (reintroduce, watch fail), and prove auth end-to-end (a 4xx entitlement error counts).

## Live verification against the real upstream

Use when adding a provider, or when probe/dispatch fails and the request *looks* right. Separate three look-alikes: **our bug**, **wrong endpoint/auth**, **upstream entitlement**.

1. **Check the transport first** (same rule as above) — prove divergence with a two-fetcher comparison before changing code.
2. **Discriminate the error code — never infer from the status alone.** Send a deliberately bogus id alongside the real one: providers answer different codes for "not served here" vs "not entitled". If the real id returns the *same* code as a bogus id, the endpoint is wrong; a *different, more specific* code means the endpoint is right and the failure is elsewhere.
3. **Test one axis per hit** (model id with/without gateway prefix, reference-client default params, extra cookies, UA/origin/referer, alternate scopes/paths) and print a table. If every variant returns the same error, the axis is **not** the cause — stop and say so.
4. **Read the reference implementation's registry, not just its client** — a reference gateway may route a model id somewhere unexpected, and its translator rules are about payload shape, not auth (a common red herring for 403s).
5. **Reading a local app's credential store** — copy first, report a lock as its own reason, probe values before adding decryption, probe several profile dirs, keep manual paste working.
6. **Prove the flow end-to-end through the real surfaces** — real registry + real route. The `prefix` matters (routes mount under `/console/api`; without it you get a misleading 404). Assert the popup URL lands on a reachable route, the account persists, the secret round-trips through the adapter's own codec, and state is single-use. For operator-facing failures, prefer a probe over a chat call: a read-only endpoint proves auth without spending anything.

## OAuth login client ("Login with browser" button)

`oauthFlows` is derived in `provider-operations.ts` via `attachProviderCapabilities`: it resolves the registry's login client and sets `browser` when `buildAuthorizeUrl` and `exchangeCode` are both functions. No client ⇒ no button. So the ONLY wiring step is registering the client:

```ts
loadAuthentication: oauthCapability(() => import("./integrations/<x>/<x>-oauth"), "<clientExport>"),
```

`oauthCapability(loader, exportName, { withRefresher: true })` mirrors the client as its own refresher. Omit `withRefresher` when no refresh grant exists — registering one advertises renewal that cannot happen. (Device-code flows that unit tests cannot cover: verify in a real browser.)

Verify end-to-end with the real route + real registry: `beginAuthorize` → assert the URL targets `oauthCallbackUrl()`, not the shared dead constant; handle the request → assert status < 400 and the account persisted (persistAccount input field is `access`, not `secret`); assert the secret round-trips through the adapter's codec; replay the same URL → assert ≥ 400 (state is single-use). Tests that read `CARTETHYIA_PUBLIC_ORIGIN` must set it themselves (another suite clears it).

## Projecting a metadata field to the dashboard

A field reaches the UI through four layers — missing any one produces no error, just an absent field:
1. **Source** — `src/providers/provider-metadata.ts`: row value + `BundledProviderMetadata` interface doc comment + accessor (`providerCredentialUrl()`, `providerCredentialHint()`) beside `providerHasAdapterUserAgent()`. Bundled metadata is the single source of truth; consumers call the accessor.
2. **Contract** — `ProviderResponse` in `src/console/providers/catalog/contracts.ts`, optional with doc comment.
3. **Projection** — `sanitizeProviderResponse()` in `provider-operations.ts`: read from the accessor, **never from the stored row** (a stale/hostile record must not redirect the value). Hoist accessor calls into locals before the object literal.
4. **Dashboard** — hand-maintained mirror (`dashboard/src/lib/contracts.ts` re-exports the type, safe); render in `dashboard/src/routes/provider-detail/`.

Render rules: render nothing when there is nothing to show; label the action for what it does ("Sign in" when only OAuth flows exist, not "Get API Key"); prefer a real `<a href target="_blank" rel="noreferrer">` over `window.open` (survives popup blockers; see `OAuthDialogs.tsx`); provider-specific `credentialHint` wins over derived text. Verify every URL you add actually resolves (`curl -L`); do not guess a key page from a brand name.

## Add a provider account action (Quota page)

Reverse-engineer the reference first: `../Public/oh-my-pi/packages/ai/src/usage/` — wire fields, idempotency keys, and "no-op" business codes differ per provider; do NOT invent names.

1. **Service** (`src/providers/operations/<feature>-service.ts`): one shared `supportsX(providerId)` predicate + exported dashboard mirror of the same set. `listX` returns `null` on transport/auth failure ("unknown"), zero-count as authoritative "nothing available" — never conflate. Build headers from the existing UA authority (`getCodexVersion()`, `CLAUDE_CODE_USER_AGENT`). On success, repair the account in place + write a `health_events` row; on failure write the row with `errorCategory`. Both surface in the Health & Error Log modal.
2. **Console routes** (`src/console/quota/account-quota.ts`, Elysia chain): `GET` with `dashboard:read`, `POST` with `dashboard:write`. Resolve access in try/catch via `errorResponse`; 404 when the account is absent; 400 `X_unsupported` when `!supportsX`; resolve credential via `refreshDeps.resolveCredential`. Business no-ops return 200, not client errors.
3. **Dashboard hooks** (`dashboard/src/lib/hooks/quota.ts`): `useAccountX` on a dedicated `queryKeys.quota.X(accountId)` (do NOT mirror onto the quota overview), `useTriggerAccountX` invalidating `queryKeys.quota.all` + `queryKeys.providers.all` in `onSettled`, `supportsAccountX` mirror set, new key in `query-keys.ts`.
4. **Card UI** (`dashboard/src/routes/Quota.tsx`): icon button in the card action row opening a `Dialog` (follow `QuotaAccountHealthModal`); page-level `useState` target rendered next to the health modal; gate on `supportsAccountX`.
5. Keep the dashboard `supportsAccountX` mirror and the backend predicate in agreement, so button and route cannot disagree.

## `model_not_found` that is really a missing catalog row

When a working model (or configured alias/combo) starts 404ing after a rebuild/restart, the routing engine is usually fine — the row was pruned from the DB.

1. Read the error for the resolved target (`resolved_models` names the post-alias/combo target; older builds need manual resolution).
2. Dump aliases, combos, and candidate rows from the main DB (`models` has no `created_at`; `model_aliases` has `target_model`, no `target_provider`).
3. Confirm the model is real upstream (models.dev / opencode zen) — do NOT "fix" by inventing it. `git log --all -S "<model-id>"` empty means the row was never in the bundled catalog.
4. Prove the alias engine itself is healthy with an alias whose target exists: an **upstream** error proves resolution+dispatch worked; a `cartethyia` 404 proves routing.
5. Fix in the catalog, never in the DB: restore the row in the owning integration with authoritative metadata + a comment saying the id is addressed by tenant aliases/combos. The seeder reconciles on boot (`seedBundledModels` deletes `builtin` rows the catalog stopped declaring), so a manual insert is not a fix.
6. Verify materialization on an isolated DB (TEST database, never live) before restarting anything; static imports only, then delete the throwaway script.
7. Tell the user a restart is required. Never start a second gateway to verify (workers cannot be disabled → double OAuth refresh). Keep it scoped: do not "fix" by making `model_not_found` retryable.

## Provider-family quirks (Xiaomi MiMo, AutoClaw: read before touching)

- **Xiaomi MiMo** — three bundled ids share one upstream family and must not be conflated: `xiaomipg`/`xiaomitp` (`sk-` API key, `api.xiaomimimo.com/v1`, OpenAI chat), `mimodesktop` (Desktop **passToken**, `mimo-server-sgp.xiaomimimo.com/api/route/chat/completions`, OpenAI chat), `mimostudio` (Studio **serviceToken + userId + ph** cookies, `aistudio.xiaomimimo.com/open-apis/bot/chat`, bespoke SSE). The Desktop passToken is NOT an OAuth refresh token (the Xiaomi token endpoint answers 401 for it — the reference is stale); exchange it for a mimo-server session cookie over plain `fetch` (never `outbound_fetch`, which destroys the jar), cache ~25 min keyed by `sha256(apiBase + passToken)`, de-duplicate concurrent handshakes. Studio cookie values arrive wrapped in literal quotes — strip them. Both variants stream thinking inline as tags (`<think>` / `<thinking>`, NUL-padded, tags can straddle frames): use the shared stateful `MimoThinkSplitter` (`src/providers/integrations/mimo/think-stream.ts`), emit reasoning as `{ kind: "reasoning", payload: null, summary }` + answer as `{ kind: "text" }`, `flush()` before `terminal`. Hand-written adapters yield `response_start` before the first delta. Quota: Desktop `GET {api}/api/user/usage` and Studio `GET .../open-apis/v1/user/usage` (`percent` is **remaining**: `used = 100 - percent`), registered via `loadQuotaCollector`. Removing a MiMo variant: §Remove above plus the DB rule (never delete by `model_id` — shared across providers). `PROVIDER_CAPABILITIES` is read once at boot: rebuild + restart before believing a probe failure.
- **AutoClaw (CN-only)** — id `autoclaw`, CN UserAPI host, code in `src/providers/integrations/autoclaw/`. Credentials import as access + required refresh token + device ID (region fixed `cn`; user metadata is non-secret `auth_state`). Refresh needs both stored refresh token AND current access token (`requiresAccessToken = true`; service passes the decrypted access token ephemerally, never storing it). Dispatch tries direct OpenAI-compatible chat first; only typed route-not-found/channel-unavailable failures trigger the CN sandbox relay (validated WSS + HTTP capabilities, device-socket auth, `agent/send` over HTTP, SSE events; text-only — reject tool-bearing requests rather than discarding schemas). WSS contract: `wss:`, port 443, SSRF validation, pinned DNS, verified certs/SNI, through the reserved pool when one exists (pool failure never falls back to direct egress). Protocol behavior is reverse-engineered, not live-verified.

Always diff against live upstream before hardcoding a family behavior, using the two-fetcher comparison and the bogus-id error-code discrimination from §Live verification above.

## Verify (provider work)

```bash
bun run typecheck
bun run dashboard:typecheck
bun run build
```

Prove the change at the real boundary: `createDefaultProviderRegistry()` resolves the adapter with the expected `provider_id`, models carry the expected `endpointPath`, and a live request through the running gateway reaches the provider. Keep throwaway probes out of the repo and delete them when done. Update `CHANGELOG.md` in the same change. Do not commit unless asked.
