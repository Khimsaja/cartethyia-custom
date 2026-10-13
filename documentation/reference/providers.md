# Providers

`src/providers/` describes every upstream the gateway can dispatch to. A provider
is not a class and not a config file: it is a small set of declarations that four
layers read. Which layer owns a fact decides where a change goes.

This is the map. The procedure for adding, removing, importing, or authenticating
a provider belongs to the
[provider-catalog skill](../../.skills/cartethyia-provider-catalog/SKILL.md);
account health, cooldowns, and pool selection belong to the
[health-routing skill](../../.skills/cartethyia-health-routing/SKILL.md).
Neither is duplicated here.

## The layers

```mermaid
flowchart LR
  meta["core/metadata.ts<br/>identity + defaults"] --> mods["default-registry.ts<br/>capability composition"]
  mods --> reg["core/registry.ts<br/>lazy loader cache"]
  reg --> adapt["adapter<br/>wire bytes"]
  spec["flat API-key specs + complex integrations/<br/>adapter + catalog + auth + quota"] -.dynamic import.-> adapt
  db[("providers / models rows")] --> byok["BYOK registration"]
  byok --> reg
```

| Layer | Owns | File |
| --- | --- | --- |
| Metadata | Identity, base URL, default wire family, service kinds, whether an account is required, JWT verification defaults | `src/providers/core/metadata.ts` |
| Spec | Typed provider declarations for compatible API-key contracts | `src/providers/configured-provider.ts`, `src/providers/configured-openai-providers.ts` |
| Registry | One registration authority; lazy loader cache for adapter, auth, quota, and discovery | `src/providers/core/registry.ts` |
| Registration source | Central provider-specific rows plus typed groups for repeated capability shapes | `src/providers/default-registry.ts` |
| Adapter | Provider wire bytes | `src/providers/runtime/adapters/base-adapter.ts`, `src/providers/runtime/adapters/compatible-adapter.ts` |
| Integration | Per-provider adapter, catalog, OAuth client, quota collector | `src/providers/integrations/<family>/` |
| Discovery | Live model listing and one-shot probes | `src/providers/runtime/discovery/` |
| Operations | Seeding, BYOK wiring, account health, CLI identity, versions | `src/providers/operations/` |
| Quota | Provider billing windows | `src/providers/runtime/quota/` |

The split matters because a provider is reached through *dynamic* `import()`.
`PROVIDER_CAPABILITIES` (`src/providers/default-registry.ts`) holds no
adapter instance, only loaders: `loadAdapter`, `loadModels`,
`loadAuthentication`, `loadQuotaCollector`, `loadModelDiscovery`. Nothing in
`src/providers/integrations/` is evaluated until a provider is actually
dispatched to, probed, or refreshed. That is why a protobuf-heavy family costs
nothing at boot — and why "grep finds no static import of this module" is not
evidence that it is dead.

Provider core contracts and generic runtime machinery live under `core/` and
`runtime/`. Ordinary API-key specs and shared discovery-backed declarations
stay as flat files directly under `src/providers/`; only substantial
provider-specific integrations get folders. Buddy's four lazy capability rows
live beside the regional integrations in `integrations/buddy/capabilities.ts`.
The central registry remains the composition root for provider-specific
behavior.

## Boot, and bundled vs BYOK

`buildProductionDeps()` is the only place these steps run, in this order
(`src/boot/dependencies.ts:130-142`):

1. `seedBundledProviders(db)` — upserts one `providers` row per bundled module
   (`src/providers/operations/provider-catalog-service.ts:32`). Additive; it
   never deletes.
2. `retireUnbundledProviders(db)` — deletes unowned rows the bundle no longer
   declares (`:88`). Boot-only, because the test harness shares one database and
   a delete there would race other suites' fixtures.
3. `createDefaultProviderRegistry()` — registers every bundled module
   synchronously (`src/providers/default-registry.ts:499`). Registration is
   cheap; only the loaders are lazy.
4. `liveProviderUpstreamHosts(registry)` — a closure over the registry, not a
   snapshot, so a provider registered after boot resolves its SSRF binding on
   the next request (`provider-catalog-service.ts:112`).
5. `registerByokProviders(registry, db, ssrfPolicy)` — reads every
   `providers` row with a non-null `base_url` and `enabled = true` and registers
   it as an `OpenAICompatibleAdapter` (`:182`).
6. `bundledModelCatalog(registry)` then `seedBundledModels(db, …)` — materialize
   static catalogs into `models` (`:126`, `provider-catalog-seeder.ts:8`).

**Bundled** means the id is in `RAW_BUNDLED_PROVIDER_METADATA`
(`src/providers/core/metadata.ts`). That is the whole test:
`isBundledProviderId` (`src/providers/core/contracts.ts`) answers from that list.
A bundled provider has a `ProviderModule` row composed from metadata and a
`PROVIDER_CAPABILITIES` entry, and `BUNDLED_PROVIDER_MODULES`
(`default-registry.ts:474`) throws at module load if an id has metadata but no
implementation.

**BYOK** (also called custom, or configured) means a `providers` row carrying a
`base_url`. It is tenant-owned, its slug must not collide with a bundled id
(`parseCustomProviderId`, `contracts.ts:215`), and it always dispatches through
`OpenAICompatibleAdapter` — no bespoke wire, no OAuth, no quota collector. Its
wire contract is derived by `resolveByokWireProfile`
(`src/providers/operations/byok-wire-profile.ts:55`) from the row's
`wire_family_default` and `compatibility_profile`; that function is the
authority, and re-hardcoding header or wire mappings elsewhere is the recurring
bug the catalog skill warns about.

Re-registration is idempotent by fingerprint, not by error: `upsert`
(`registry.ts:163`) replaces an existing registration and drops the cached
adapter, so an operator editing a BYOK row from the console changes dispatch
behavior without a restart.

## Credentials and auth

`CredentialKind` is a closed union: `none`, `api_key`, `oauth`,
`scoped_access_token`, `workload_identity` (`src/providers/core/contracts.ts`).
The storage enum is narrower — `api_key`, `oauth`, `none`
(`src/persistence/schema.ts:106`).

| Shape | Where the secret lives | Where the rest lives |
| --- | --- | --- |
| API key | `provider_accounts.credential_ciphertext` (encrypted) | — |
| OAuth | same column, access token | `provider_oauth_states` (`schema.ts:238`): refresh ciphertext, optional client-secret ciphertext, `expires_at`, refresh lease |
| Device code | mints one of the two above | — |
| No credential | nothing; `requires_account = false` and `credential_forwarding: "never"` | — |

`provider_accounts.auth_state` (`schema.ts:195`) holds non-secret per-account
upstream configuration — region, profile ARN, OAuth client id, token endpoint.
It travels beside the secret in `ResolvedCredential.auth_state`
(`src/providers/core/contracts.ts`) because a single opaque credential string
cannot express both, and the request an adapter builds depends on both.

Selection is `CredentialResolver` (`src/providers/core/credential-resolver.ts`):
the first usable alternative in operator order. Decryption and caching live in
`src/providers/operations/provider-credential-service.ts`, with a 5 s TTL keyed
on `providerId:accountId` (the provider must be in the key — a routing candidate
can reuse another provider's account id).

`TokenEnvelope` (`src/providers/core/credential-envelope.ts`) strips one explicitly
identified prefix — `Bearer `, `OAuth `, `provider:` — so an adapter never emits
`Bearer Bearer`. It is a separate module because adapters consume it and the
registry imports adapters; the reverse edge would be a cycle.

Three auth client shapes exist:

| Shape | Base class | Family examples |
| --- | --- | --- |
| Browser PKCE | `OAuthClient.buildAuthorizeUrl`/`exchangeCode` (`src/providers/runtime/authentication/oauth-client.ts`) | claude, antigravity, kiro, codex, mimodesktop, mimostudio, openrouter, zcode |
| Device code (RFC 8628) | `OAuthDeviceFlow` (`src/providers/runtime/authentication/oauth-device-flow.ts`) | codex, github, cursor, grok, xai, kimi, cline, kiro, kilo, muse, qoder, factory |
| No OAuth | plain key path; `probeApiKeyConnectivity` is the account test (`src/providers/runtime/quota/quota-support.ts`) | openai, anthropic, mistral, meta, most compatible API-key providers |

Whether a refresher is registered is per-family and deliberate. A family whose
grant is absent or dead registers no refresher, because a refresh call that
always throws turns a recoverable 401 into a permanent one — see the comments on
`kilo` (`:351`), `qoder` (`:369`), `openrouter` (`:387`), `zcode` (`:421`),
`cloudflareai`, and `alibabacp` in `default-registry.ts`.
GitHub is the opposite case: its Copilot token is
short-lived and re-minted from the device-flow token, so it does register one
(`:446`).

Some issuers publish a JWKS; `metadata.ts:59` and `:74` declare `issuer` and
`jwksUrl` for `grok` and `xai`, and `jwtVerification` (`:258`) is the field.
Providers without one get registered-claim validation only.

## Discovery and catalog

A model becomes routable when a `models` row exists with `enabled = true` and
its provider row is enabled and not retired. Two writers produce those rows.

**Static catalogs.** Each bundled module declares `loadModels`, usually a module
constant built with `defineModel` (`src/providers/core/model-definition.ts`).
`defineModel` resolves limits and pricing against the offline base catalog and
leaves capability flags to the caller — capability does not fall back, because
an invented default is worse than a stated false. The offline catalog is
`src/providers/runtime/discovery/base-models.json` (~2 MB, `source: models.dev`,
`fetchedAt` in the file header), read by
`src/providers/runtime/discovery/models-dev-catalog.ts`. Provider ids that differ from
models.dev's spelling are remapped in `MODELS_DEV_PROVIDER_IDS` (`:139`).
`seedBundledModels` (`src/providers/operations/provider-catalog-seeder.ts:8`)
writes these rows as `source: 'builtin'`, prunes `(model, endpoint)` pairs the
catalog no longer declares, and reconciles capability drift on conflict while
leaving operator-owned `enabled` alone.

**Live discovery.** A module's `loadModelDiscovery` is a
`ProviderModelDiscovery` (`src/providers/runtime/discovery/discovery-types.ts`) taking
`baseUrl`, `credential`, optional `fetcher`, and optional `authState`. Most
OpenAI-compatible providers reuse `fetchOpenAICompatibleModels`
(`src/providers/runtime/discovery/openai-model-discovery.ts`). Per-account catalogs
declare `modelDiscoveryRequiresCredential: true` — Kiro's list answers with what the credential's plan reaches, so the
static rows are only an offline seed. Persisted rows get `source: 'discovered'`
or `'auto_free'` (`src/providers/runtime/discovery/probing-service.ts`), which keeps
a free-tier row distinguishable at the only point it is still known.

Whether the dashboard offers the "Fetch models" control is
`supportsModelDiscovery`, which asks `registry.hasModelDiscovery(providerId)`
(`src/providers/core/registry.ts`) — does a resolver exist for this provider — not
whether it is a custom provider. A bundled provider that registers no resolver
(`gmi`, `nvidia`, `fireworks`) still reports `false` and has no button; a BYOK row
reports `true` regardless.

Static and discovered rows are not rivals: discovery adds to the static floor
and never resets `enabled`. Catalog presence is not availability — a row is not
proof that a model answers. `/v1/models` reads the same rows.

## Quota and health

`QuotaFetcher` (`src/providers/runtime/quota/quota-support.ts`) is a per-provider
callback returning `ProviderQuotaResult` (`quota-contracts.ts:17`): a plan label
and a list of windows with percentages and reset times. Registered collectors are
resolved lazily through the registry (`:67`). Each window is explicitly marked
as `pooled` credit or, by default, an independent quota. Pooled refill/bonus
balances sum per account before applying the credit or percent floor; independent
windows such as 5-hour and weekly rate limits are checked separately and block
at zero. A percent floor also applies to each independent window, while a credit
floor applies only to the pooled balance. A missing reading is not proof that
allowance is gone, and `totalRemainingCredit` (`:40`) ignores independent usage
limits even when they expose absolute `used`/`limit` values. Health state lives
on `provider_accounts` via `healthColumns()`
(`src/persistence/schema.ts:93,198`): status, `cooldown_until`, per-model
cooldowns, last error category. Cooldown classes, recovery sweeps, leases, and
pool selection are owned by `.skills/cartethyia-health-routing/SKILL.md`.

Quota cache and refresh behavior is part of that routing contract. The cache is
bounded to 1,024 in-process entries, has a 15-minute TTL, and uses Redis as an
optional shared tier. It records attempt and successful-fetch timestamps
separately. A failed refresh retains a successful reading for up to 30 minutes
while exposing the refresh error; it does not immediately replace usable quota
with an empty result. `quota-refresh-sweep` runs every minute, refreshes entries
at least four minutes old, and bounds each pass to 40 accounts / 90 seconds.
See [Usage floor](../features/usage-floor.md) for how these readings affect
account eligibility.

## Per-family notes

Only what is verified in code. `bespokeWire` means the adapter frames its own
protocol instead of going through a canonical codec (`metadata.ts:316`).

| Family | What is non-standard |
| --- | --- |
| kiro | Bespoke (`metadata.ts:112`). AWS EventStream wire over `q.us-east-1.amazonaws.com`, no chat-shaped endpoint; reasoning arrives either as its own event or as `<thinking>` markers inside text (`kiro-stream.ts:1`). Device + PKCE. |
| cursor | Bespoke (`metadata.ts:118`). Connect-RPC over HTTP/2: unary calls send `application/proto`, the turn is a bidirectional `application/connect+proto` frame stream opened on `node:http2` because `fetch` cannot hold it (`cursor-transport.ts:1-9`). Catalog is per-account. |
| github | Base URL is only a fallback: the real host is read from the Copilot token's `proxy-ep` claim per dispatch (`github.ts:5`). Short-lived token, real refresher. |
| antigravity | Google OAuth, but the wire is a Gemini payload wrapped in an agent envelope POSTed to `v1internal:{generate,stream}GenerateContent` — no per-model path (`antigravity.ts:1-12`). Image generation streams that same envelope with `responseModalities: ["IMAGE"]` and reads `inlineData`. `/v1/search` uses the same envelope with Google Search grounding. |
| muse | Device-code login yields an OAuth token, which a follow-up `POST /muse-code/key` exchanges for the `api_key` the model backend accepts; the stored `oauth` secret is a `{oauthAccessToken, apiKey}` JSON blob (`muse.ts:1-12`). |
| meta | The *other* Meta surface: a plain developer-dashboard API key, no OAuth (`default-registry.ts:172`). |
| claude / codex | Subscription OAuth on Messages / Responses. Codex also serves websearch (`metadata.ts:43`). Its image path is separate from the chat turn: a Responses `image_generation` tool on a chat carrier, without the chat identity envelope. A catalog row is not an entitlement; a ChatGPT account can reject the tool. |
| gemini | `x-goog-api-key` header, per-model `:generateContent`/`:streamGenerateContent` paths; not OpenAI-shaped (`adapters/gemini.ts:2-3`). Image generation uses the same path and asks for `responseModalities: ["IMAGE"]` only. |
| xai / grok | Same issuer and JWKS, different surfaces: `grok` is the free Grok Build CLI proxy, `xai` is the paid API (`metadata.ts:64-78`). |
| kilo | Resells the OpenRouter catalog behind a `{accessToken, orgId}` JSON credential decoded at the auth boundary (`kilo.ts:1-14`). No refresh grant. |
| qoder | Device flow whose refresh endpoint answers 403; no refresher (`default-registry.ts:369`). |
| cline | Discovery reads only `recommended` + `free` — asking for the pass roster would write subscription rows an operator's account can only 401 on (`default-registry.ts:314-324`). |
| openrouter / zcode | PKCE ends by minting a **durable API key**, not an access token, so no refresher is registered (`:387`, `:421`). |
| xiaomi-mimo | Four ids: `xiaomipg`, `xiaomitp` (both key-based), `mimodesktop` (OAuth), `mimostudio` (browser cookies pasted from a signed-in session, `metadata.ts:182`). |
| cb / cbcn / workbuddy / workbuddycn | One billing system, so `BUDDY_PROVIDER_IDS` names the family for health, request prep, and daily check-in. WorkBuddy CN mirrors WorkBuddy's contract on `www.workbuddy.cn` and also carries the recent CN model additions published by CodeBuddy CN. The runtime directory and desktop `/v3/config` snapshot are different surfaces; see the [catalog-fetch procedure](../../.skills/cartethyia-provider-catalog/SKILL.md#fetch-a-buddy-model-catalog), [captured catalogs](../../data/provider-catalogs/buddy-live-model-catalogs-2026-10-12.json), and [Buddy media-generation status](../features/buddy-media-generation.md). |
| opencodeft | `requires_account: false` and `ipScopedRateLimit: true` (`metadata.ts:124`): rate limits follow the egress address, so a 429 cools the pool, not the account. |
| exa / parallel | `serviceKinds: ["websearch"]` only; served by `/v1/search`, never by the chat pipeline. Their route ids are `exa` and `parallel`. No account uses the public MCP; a stored API key uses the provider's higher-limit HTTP API. |
| deepseek | Bundled API-key provider. Dispatch uses the Anthropic Messages adapter at `/anthropic/v1/messages`; its OpenAI-compatible `/v1/models` discovery remains separate. The dedicated catalog is `integrations/deepseek/provider.ts`. See [BYOK base URLs and DeepSeek](../fix-byok-base-url-path.md) for the related endpoint-normalization context. |
| mistral, fireworks, nvidia, gmi, ollamacloud | Shared configured OpenAI-compatible spec rows; DeepSeek has a dedicated Messages integration. |
| factory | WorkOS device code against a proxy that multiplexes four wires by model family, so `dispatch` branches on `wire_family` rather than declaring one path (`factory.ts:1-30`). The credential is `{accessToken, orgId}` — the org id is the JWT's `external_org_id` claim and is sent as `X-Factory-Org-Id` — and the host comes from the account's residency region, not from metadata. A real refresh grant exists (`refresh` re-posts to the same WorkOS endpoint), and the token request is issued in the client rather than through `pollGenericDeviceAuth` because the shared helper drops `refresh_token` from the response. |
| cloudflareai | A gateway, not a model host: the account and gateway slugs are path segments of the base URL (`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic`) and are stored with the token, so the base URL is built at dispatch time. Auth is `cf-aig-authorization`, not `Authorization` or `x-api-key` (`cloudflareai.ts:11-19`). Messages wire only. No refresh grant. |
| alibabacp | Two plans — international and mainland China — served by different hosts whose keys are not interchangeable, so the region is stored with the token and resolved to a base URL at dispatch time. The resolved host already ends in `/compatible-mode/v1`, so the endpoint paths are unprefixed (`alibabacp.ts:27-33`). No refresh grant. |
| dashscope | Alibaba's mainland DashScope coding host, a plain bearer on `https://coding.dashscope.aliyuncs.com/v1`. Distinct from `alibabacp`, which is the Token Plan on `token-plan.*.maas.aliyuncs.com`; the keys are not interchangeable. Live `/v1/models` discovery plus an 8-row static floor (`integrations/dashscope-models.ts`). |
| factory / cloudflareai / alibabacp catalogs | Static rosters in `integrations/*/*-models.ts`. None of the three publishes a model-listing endpoint this gateway can call — Factory's roster is client-side and per-account, Cloudflare's lives behind the per-account path slugs, and the plan key lists nothing — so the catalog is the list. Limits come from the base catalog via the remaps in `models-dev-catalog.ts`; capability is declared per row because `defineModel` never reads it from the base catalog. |

## Where to change what

| Change | Start here |
| --- | --- |
| New provider, family, or catalog row | [Provider-catalog skill](../../.skills/cartethyia-provider-catalog/SKILL.md) |
| Provider identity, base URL, default wire, service kinds | `src/providers/core/metadata.ts` |
| Wire a bundled provider's adapter/auth/quota/discovery | `src/providers/default-registry.ts:82` |
| Behavior of one provider's wire | its module under `src/providers/integrations/<family>/` or `src/providers/runtime/adapters/` |
| A provider that speaks standard OpenAI chat/responses | add an `ApiKeyProviderSpec`, not an adapter (`configured-provider.ts`) |
| A provider whose base URL carries per-account state (a plan region, a residency host) | the spec's `resolveBaseUrl`, which overrides `base_url` at transport time from the decoded credential (`compatible-adapter.ts:45`) |
| Shared HTTP/SSE adapter behavior | `src/providers/runtime/adapters/compatible-adapter.ts`, `base-adapter.ts` |
| Provider registration, caching, lazy loading | `src/providers/core/registry.ts` |
| BYOK wire/header derivation | `src/providers/operations/byok-wire-profile.ts:55` |
| BYOK registration and SSRF binding | `src/providers/operations/provider-catalog-service.ts:182` |
| Static catalog seeding and drift | `src/providers/operations/provider-catalog-seeder.ts:8` |
| Offline limits and pricing | `src/providers/runtime/discovery/base-models.json`, `models-dev-catalog.ts` |
| Live model listing | the family's `loadModelDiscovery`, or `discovery/openai-model-discovery.ts:25` |
| Quota windows | the family's `*-quota.ts` collector, plus `src/providers/runtime/quota/quota-contracts.ts` |
| OAuth login, refresh, device flow | `src/providers/runtime/authentication/`, then the family's `*-oauth.ts` |
| Account health, cooldowns, pool selection | [Health-routing skill](../../.skills/cartethyia-health-routing/SKILL.md) |
