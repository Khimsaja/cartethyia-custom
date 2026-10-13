# Provider area rework map

Implementation map for reorganizing `src/providers/` to make common providers
cheaper to add and provider-specific behavior easier to find. The runtime/core
and shared provider modules have moved, Buddy now separates Intl and CN, and
standard discovery-backed API-key providers use typed central declarations.
Provider IDs, database rows, wire behavior, and lazy-loading requirements stay
stable through the migration.

## Goals and guardrails

- Reduce repeated registration and capability wiring for standard providers.
- Put provider-owned behavior and its model catalog near that provider.
- Keep genuinely shared protocol, auth, discovery, and quota machinery shared.
- Keep special upstream protocols explicit instead of hiding them in a generic
  adapter.
- Make regional products visible as separate integrations, not aliases that
  accidentally inherit another region's endpoint or catalog.
- Keep provider modules lazy-loaded; registering a provider must not eagerly
  load its adapter, OAuth implementation, or large protocol dependencies.
- Keep BYOK/configured providers as runtime data. They are not bundled
  integrations and must not be forced into the static provider tree.
- Make capability completeness and provider identity compiler/test-checkable.

The intent is less boilerplate, not fewer files at any cost. A clear 20-line
provider manifest is preferable to a generic framework that obscures upstream
differences.

## Before: current layout

At the top level, provider responsibilities are split by technical category:

```text
src/providers/
├── adapters/                         # standard / special transport adapters
├── authentication/                   # shared OAuth and token flows
├── discovery/                        # model discovery infrastructure
├── integrations/                      # 18 provider families, 101 files
│   ├── alibabacp/
│   ├── antigravity/
│   ├── buddy/                         # 18 files, all four Buddy products mixed
│   ├── claude/
│   ├── cline/
│   ├── cloudflareai/
│   ├── codex/
│   ├── factory/
│   ├── github/
│   ├── grok/
│   ├── kilo/
│   ├── kimi/
│   ├── kiro/
│   ├── meta/
│   ├── muse/
│   ├── shared/                        # shared code placed under integrations
│   ├── xai/
│   └── xiaomi-mimo/
├── operations/                        # registry/catalog/account operations
├── quota/                             # quota infrastructure
├── search/                            # hosted search integrations
├── specs/                             # provider contracts, catalogs, OAuth specs
├── base-adapter.ts
├── compatible-adapter.ts
├── contracts.ts
├── credential-envelope.ts
├── credential-resolver.ts
├── default-registry.ts                # 600+ line central capability map
├── metadata.ts
├── model-definition.ts
├── reasoning.ts
├── registry.ts
├── sanitize.ts
└── usage.ts
```

Current directory counts are a snapshot, not an architecture constraint.
Provider behavior is spread across these locations:

| Concern | Current home | Consequence |
| --- | --- | --- |
| Provider identity and defaults | `metadata.ts` | Must stay synchronized with the implementation map |
| Capability wiring and lazy imports | `default-registry.ts` | Central file grows with every provider and capability |
| Generic API-key specs | `specs/`, `integrations/shared/configured-provider.ts` | The distinction between declaration and implementation is easy to miss |
| Bespoke adapter and provider model catalog | `integrations/<family>/` | Generally colocated, but not consistently named |
| Shared auth, discovery, quota | `authentication/`, `discovery/`, `quota/` | Shared runtime code is separated from the provider that uses it |
| Account/catalog operations | `operations/` | Correctly cross-provider; operational concerns should remain centralized |
| BYOK | configured-provider adapter plus `operations/` | Runtime-defined provider behavior coexists with bundled-provider wiring |

### Buddy before the move

All four products were registered independently, but their implementation
files and some shared catalogs/helpers lived together in one folder:

| Product | Provider ID | Before implementation |
| --- | --- | --- |
| CodeBuddy International | `cb` | `codebuddy/provider.ts`, `shared.ts`, `oauth.ts`, `quota.ts` |
| WorkBuddy International | `workbuddy` | `workbuddy/provider.ts`, `shared.ts`, `oauth.ts`, `quota.ts` |
| CodeBuddy CN | `cbcn` | `codebuddy/cn-provider.ts`, shared `oauth.ts` |
| WorkBuddy CN | `workbuddycn` | `workbuddy/cn-provider.ts`, `cn-oauth.ts` |

International CodeBuddy and WorkBuddy intentionally share the Intl roster and
discovery shape. The CN products use a separate catalog/discovery path and
regional behavior; WorkBuddy CN currently derives its bundled model rows from
the CodeBuddy CN catalog while retaining its own provider ID and endpoint.
The current layout makes those distinctions visible and keeps that deliberate
reuse explicit.

## Current layout and remaining target

Separate **runtime machinery**, **typed standard-provider declarations**, and
**provider integrations**. Group shared code by what it serves; keep special
behavior beside the integration that owns it.

```text
src/providers/
├── adapters/                              # shared protocol adapters
├── authentication/                        # shared OAuth and token flows
├── discovery/                             # model discovery and probing
├── quota/                                 # quota contracts and helpers
├── provider-contracts.ts                  # provider identity and adapter contracts
├── provider-metadata.ts                   # identity and routing defaults
├── provider-model-definition.ts            # normalized model rows
├── provider-registry.ts                   # registry factory and lazy loader cache
├── provider-credential-envelope.ts
├── provider-credential-resolver.ts
├── provider-reasoning.ts
├── provider-sanitize.ts
├── provider-usage.ts
├── integrations/                          # code with provider-specific behavior
│   ├── alibabacp/
│   ├── antigravity/
│   ├── claude/
│   ├── cline/
│   ├── cloudflareai/
│   ├── codex/
│   ├── factory/
│   ├── github/
│   ├── grok/
│   ├── buddy/
│   │   ├── codebuddy/                     # provider, OAuth, quota; Intl + CN
│   │   └── workbuddy/                     # provider, OAuth, quota; Intl + CN
│   ├── kilo/
│   ├── kimi/
│   ├── kiro/
│   ├── muse/
│   ├── opencode/
│   ├── openrouter/
│   ├── xai/
│   ├── xiaomi-mimo/
│   ├── aihubmix.ts, bai.ts, cerebras.ts, deepseek.ts
│   ├── hermes.ts, meta.ts, mistral.ts, openai.ts, tokenharbor.ts
│   └── ollamacloud-quota.ts
├── configured-provider.ts                 # shared standard API-key adapter/spec
├── configured-openai-providers.ts         # typed endpoint-shape declarations
├── bundled-discovery-providers.ts         # shared API-key discovery behavior
├── provider-capabilities.ts               # shared lazy OAuth/quota helpers
├── operations/                            # cross-provider account/catalog operations
├── search/                                # search provider implementations
├── default-registry.ts                    # composes metadata and capability groups
```

This is the flattened shared provider foundation plus the migrated Buddy
integrations and standard-provider declaration group. Ordinary API-key providers
stay as flat files directly under `integrations/`; provider subfolders are for
substantial integrations such as OAuth/device-flow providers or protocols
with multiple owned modules. The central registry retains explicit exceptions.

### Buddy after: grouped by product, with capabilities kept separate

The four provider IDs stay four distinct, discoverable implementations:

```text
src/providers/integrations/buddy/
├── capabilities.ts                 # four distinct, lazy regional provider rows
├── buddy-*.ts                       # behavior shared across Buddy products
├── codebuddy/
│   ├── provider.ts                  # cb
│   ├── cn-provider.ts               # cbcn
│   ├── shared.ts
│   ├── oauth.ts                     # OAuth clients for cb and cbcn
│   └── quota.ts                     # quota collectors for cb and cbcn
└── workbuddy/
    ├── provider.ts                  # workbuddy
    ├── cn-provider.ts               # workbuddycn
    ├── shared.ts
    ├── oauth.ts                     # international OAuth
    ├── cn-oauth.ts                  # CN OAuth
    └── quota.ts                     # quota collectors for both regions
```

Rules for this grouping:

- Group provider-owned files under one product directory (`codebuddy/` or
  `workbuddy/`); keep OAuth, quota, provider, and shared modules as separate
  files rather than merging different responsibilities.
- Keep behavior shared across products in clearly named files directly under
  `integrations/buddy/`.
- CN catalog/discovery stays independent from Intl; do not make a CN model
  appear internationally or vice versa through an implicit shared list.
- WorkBuddy CN's reuse of CodeBuddy CN models stays explicit in its provider
  module.
- Per-product base URL, auth, endpoint path, and provider ID stay on that
  product's manifest. Sharing helper functions must not merge product identity.
- Shared chat normalization, media, and low-level OAuth/quota helpers stay in
  clearly named Buddy files when request/response evidence shows identical
  behavior.

## Provider declaration model

### Before: repeat capabilities in a central object

The current registration shape repeats loader declarations in one large
`PROVIDER_CAPABILITIES` map:

```ts
// Illustrative current shape; abbreviated.
const PROVIDER_CAPABILITIES = {
  openai: {
    loadAdapter: async () =>
      createApiKeyAdapter((await import("./specs/openai")).OPENAI_SPEC),
    loadModels: async () =>
      (await import("./specs/openai")).OPENAI_MODELS,
    loadModelDiscovery: openAIModelDiscovery("openai", {
      headers: (credential) => ({ authorization: `Bearer ${credential}` }),
    }),
  },
  // More rows with the same loader boilerplate.
};
```

### Implemented: type-safe central declarations for standard API-key providers

Standard discovery-backed providers now share a typed declaration group in
`bundled-discovery-providers.ts` at the provider root. Its ID/spec table
ensures every listed provider has both the matching adapter spec and discovery
loader, while bespoke exceptions remain in the registry:

```ts
...createDiscoveryBackedProviderCapabilities(openAIModelDiscovery)
```

A provider with a meaningful exception remains explicit:

```ts
export const anthropic = provider({
  id: "anthropic",
  adapter: () => import("./provider").then((module) => module.createAdapter()),
  models: () => import("./models").then((module) => module.models),
  discovery: anthropicModelDiscovery(),
});
```

The final registration list should be assembled from typed declarations and
validated once:

```ts
export const bundledProviders = defineBundledProviders([
  openai,
  anthropic,
  codeBuddyIntl,
  workBuddyIntl,
  codeBuddyCn,
  workBuddyCn,
]);
```

The central map still owns provider-specific composition such as OAuth,
provider-specific discovery headers, quotas, static catalogs, and protocol
exceptions. This keeps their behavior visible without duplicating the standard
adapter/discovery pair.

### What should become data, and what should stay code

| Provider shape | Target representation | Examples |
| --- | --- | --- |
| Standard bearer API key, Chat-compatible endpoint | Small typed spec + optional fallback catalog | Most standard `specs/` providers |
| Standard API key with versioned root or custom path | A distinct typed spec shape; no duplicated `/v1` logic | Versioned-root API-key providers |
| Anthropic-compatible API key | Dedicated capability constructor or adapter declaration | Anthropic |
| OAuth with standard protocol but provider-specific endpoint | Local auth declaration using shared OAuth flow | Providers built on shared OAuth clients |
| OAuth with custom handshake, signing, event stream, or device identity | Explicit integration code | Codex, Kiro, Xiaomi MiMo, Buddy variants |
| Custom stream/request protocol | Explicit adapter and protocol modules | Kiro, Gemini/Antigravity or other bespoke wires |
| Provider-specific quota | Local quota module using shared primitives | OAuth/quota integrations |
| BYOK | Runtime database row + configured adapter | Custom providers |

Do not turn every provider into a class or create an empty manifest, auth, model,
quota, and discovery file for each one. A standard provider should be mostly
data. A bespoke provider should make its behavior obvious.

## Current-to-target mapping

| Current path | Proposed home | Notes |
| --- | --- | --- |
| `core/*.ts` | Flat, `provider-*.ts` files at `src/providers/` | Shared provider foundation without a wrapper directory |
| `runtime/adapters/` | `adapters/` | Shared wire behavior, one level closer to provider root |
| `runtime/authentication/` | `authentication/` | Shared flows; provider setup remains local |
| `runtime/discovery/` | `discovery/` | Discovery mechanics; provider paths and headers remain local declarations |
| `runtime/quota/` | `quota/` | Shared quota types/fetch helpers; quota interpretation remains local |
| Generic API-key declarations | Flat files at `src/providers/` | Avoid a directory layer for simple providers |
| `default-registry.ts` | Keep as composition root; standard groups in flat provider files | Extract only repeated, type-safe capability patterns |
| `integrations/buddy/*` | `integrations/buddy/{shared,intl,cn}/...` | Four products explicit; preserve independent IDs |
| Other `integrations/<family>/` folders | Same family name under `integrations/` | Co-locate each provider's implementation, catalog, auth, quota, discovery |
| `operations/` | `operations/` | Remains cross-provider; not nested into one integration |
| `search/` | `search/` | Remains separate if it owns hosted search providers rather than dispatch adapters |
| `integrations/shared/` | Split by ownership | Generic compatible-provider code to flat provider-root files; Buddy-specific helpers to Buddy shared; truly shared protocol helpers to the provider root categories |

### Existing integration families retained

This proposal does not delete or silently merge any currently registered family:

```text
alibabacp       antigravity      buddy (cb / workbuddy / cbcn / workbuddycn)
claude          cline            cloudflareai
codex           factory          github
grok            kilo             kimi
kiro            meta             muse
xai             xiaomi-mimo
```

Small integrations may remain a single file. Larger families can split into
`provider`, `models`, `auth`, `quota`, `discovery`, or protocol modules as
needed. Naming should follow codebase convention; the important point is that
the integration folder is the authority for provider-specific behavior.

## What stays centralized

Not every provider-related file should move under an integration:

- **Registry runtime:** duplicate-ID checks, lazy loading, cache invalidation,
  adapter identity checks, and registry snapshots are cross-provider behavior.
- **Bundled metadata:** one typed source for canonical ID, display name, base
  URL, upstream host, service kinds, default wire, and account requirement.
- **Operations:** seeding, catalog persistence, account credential resolution,
  health, version/client identity, and model discovery lifecycle are shared
  workflows.
- **Shared protocol primitives:** generic OpenAI-compatible request/response,
  OAuth flow implementations, quota response parsing, and cache primitives.
- **BYOK:** configured at runtime and routed through the compatible adapter;
  it is not one source file per customer-defined provider.

Provider-local declarations should consume these shared services. Shared code
should not import individual provider implementations.

## Desired before/after change shape

| Task | Before | After |
| --- | --- | --- |
| Add ordinary API-key provider | Add spec/catalog, find registration row, copy adapter/discovery loader wiring, ensure metadata exists | Add typed provider declaration with spec, catalog, and optional discovery differences; composed by the registry |
| Add OAuth provider | Add implementation files, then wire OAuth loader, optional refresher, adapter, models, and quota in central registry | Add provider-local manifest that opts into explicit capabilities |
| Change one provider's endpoint | Find provider constants/spec and verify registry's discovery path is synchronized | Update that provider's declaration; typed adapter/discovery capability derives from the same spec |
| Compare CodeBuddy Intl and CN | Inspect product folder and central registration table | Compare `buddy/codebuddy/provider.ts` with `buddy/codebuddy/cn-provider.ts`; shared behavior is separately named |
| Add model to one Buddy region | Edit shared catalog and risk publishing it to both regions | Edit the region-owned catalog; shared rosters require an explicit Intl-only decision |
| Add genuinely shared behavior | Copy implementation into another family or expand central registry | Add one runtime primitive and have relevant provider declarations opt into it |

## Invariants a refactor must preserve

1. Provider IDs remain canonical (`cb`, `workbuddy`, `cbcn`, `workbuddycn`, etc.).
2. Each adapter's `provider_id` matches the registration ID.
3. Metadata, upstream host/port, default wire, service kind, account requirement,
   and endpoint paths remain consistent with dispatch and SSRF checks.
4. The provider registry remains lazy. Do not statically import heavy adapters,
   OAuth clients, or protocol dependencies at boot.
5. Static bundled catalogs remain distinct from live discovery results and
   tenant-owned database rows.
6. Discovery requests use the correct region, URL root, auth headers, and
   provider ID. Do not infer a regional endpoint from a sibling provider.
7. Optional OAuth refreshers, quota collectors, discovery, and model loaders
   remain optional. Do not manufacture no-op implementations to satisfy a
   uniform object shape.
8. BYOK registration, fingerprints, and runtime re-registration keep current
   semantics.
9. No import cycle between `core`, `runtime`, `definitions`, and integrations.
10. Provider removal from the bundle must continue to retire only the intended
    bundled database rows under the existing lifecycle.

## Migration path

Completed migration work: provider core/runtime modules were moved, specs and
integrations were regrouped, Buddy Intl/CN files were separated, and the
standard discovery-backed API-key group was extracted. Typecheck and focused
Buddy protocol/catalog/media/activity tests pass. Continue incrementally:

1. **Lock down the current inventory:** enumerate every bundled provider ID and
   compare metadata, capabilities, adapter identity, models, auth, quota,
   discovery, and wire family. Record intentional absences.
2. **Complete standard declarations:** migrate remaining standard provider
   shapes from `default-registry.ts` into typed groups only when the group
   preserves their catalog, headers, quota, endpoint, and lazy-loading behavior.
3. **Move bespoke families incrementally:** start with a small family, compare
   request/response fixtures, then proceed to complex families such as Codex,
   Kiro, Claude, and Xiaomi MiMo.
4. **Verify dependency direction and import cycles** after each relocation.
5. **Remove compatibility re-exports and old paths** after all callers move.

Each phase should have a small diff, existing targeted tests, provider-registry
completeness coverage, and a before/after file-path map. No bulk rename should
combine with behavior changes.

## Decisions and remaining questions

- **Resolved:** standard API-key declarations are centralized in flat files
  under `src/providers/integrations/`; deeper provider folders are reserved
  for integrations with substantial OAuth, protocol, or provider-owned module
  complexity.
- Should `metadata.ts` remain a separate canonical list, or can typed provider
  declarations become its source of truth without creating eager imports?
- Should provider-specific discovery and quota declarations live in the
  provider manifest or stay in separate modules and be lazily referenced?
- Which repeated capability groups offer a clear reduction without obscuring
  provider-specific behavior?
- Which current family boundaries represent a real shared upstream contract,
  versus historical grouping that should be split?
- Is `integrations/shared/` to be removed entirely after its modules move, or
  retained for a small number of stable cross-provider implementations?

Keep the remaining questions scoped to later batches. The target is a reviewable
provider map, not a large one-shot rewrite.
