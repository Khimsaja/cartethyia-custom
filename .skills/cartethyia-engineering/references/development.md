# Development

Orientation, adding a provider, schema/routing changes, console-log fields, removal, dedup.

## 0 Orientation

1. State first: `git status --short` + `git diff --stat`. Uncommitted work is the real state.
2. Navigate by source: the target file and its direct callers are the authority. `.codegraph/codegraph.db` at the repo root answers "how/where/what calls X" in one call.
3. Then `package.json` scripts, then the boot chain `src/main.ts` → `src/runtime/lifecycle.ts` → `src/runtime/dependencies.ts` → `src/app.ts`.

**Authority map (current).**

- **Ingress:** `src/transport/middleware/` (pipeline, request-context, error-lifecycle).
- **Routing:** `src/transport/routing/router.ts`, `route-catalog.ts`, `route-model.ts`.
- **Dispatch:** `src/providers/compatible-adapter.ts`, `src/transport/dispatch/proxy-request.ts`, `attempt-finalize.ts` (`completeAttempt`), `attempt-loop.ts`, `leases.ts`, `upstream.ts`, `retry-policy.ts`.
- **Capabilities:** `src/transport/translation/capabilities.ts`, `src/transport/request/preparer.ts`.
- **Registry:** `src/providers/provider-registry.ts`, `default-registry.ts`, `provider-metadata.ts`, `model-definition.ts` (`defineModel`).
- **Config:** `src/config.ts` is the only sanctioned multi-subsystem env reader; single-subsystem reads live next to their consumer and must be documented in `.env.example`.
- **Network:** `src/network/ssrf.ts`, `outbound-fetch.ts`, `pool/`.
- **Observability:** `src/observability/log-ring.ts`, `payload-capture.ts`, `telemetry-buffer.ts`, `telemetry-status.ts`.
- **Console:** `src/console/providers/catalog/`, `providers/detail/`, `observability/`.
- **Persistence:** `src/persistence/schema.ts`, `postgres.ts` (migration ledger), `migrations/` (`0000_baseline.sql` is the whole schema for a database created today).
- **Scripts** are flat under `scripts/` (`ops-*`, `build-*`, `ci-*`); no `scripts/ops/` subdirectory.

**Watch out:** provider identity is mirrored, not imported — dashboard keeps hand-copied names, icons, id sets; a backend rename isn't done until the mirrors move / capability flags change the upstream payload / telemetry is metadata-only, never blocks requests / bare model-id ambiguity is rejected, not guessed.

## 0.1 Verifying a change

Done when you predicted how it fails, fixed the cause, and proved the fix at the real boundary. Full loop in `references/verification.md`.

1. **Goal sentence first.** "A `<surface>` request carrying `<input>` produces `<observable outcome>`." Observable = result, boundary, error, transition, security invariant, persistence contract.
2. **Predict the failure.** Which line reads which value, and why it's wrong today. Can't predict → run one probe first.
3. **Change what you observe, not how often.** Unexplained failure → switch the layer: raw vs parsed, request vs response, one provider vs one surface.
4. **Prove it at the real boundary.** A live request, the browser, or a `.tmp-<topic>.ts` calling the real function. Delete throwaways before reporting.

## 1 Add provider

Done when: the provider dispatches end-to-end, appears in the dashboard, and its catalog seeds without endpoint conflicts.

1. Identity row in `provider-metadata.ts` (`RAW_BUNDLED_PROVIDER_METADATA`): `id`, `displayName`, `baseUrl` as the true origin root. Optional `wireFamilyDefault`, `requiresAccount`, `defaultBypassProxy`, `jwtVerification`, `credentialUrl`, `credentialHint`, `hasAdapterUserAgent`. `BundledProviderId` derives from this array — no second id list.
2. Capabilities entry in `default-registry.ts` (`PROVIDER_CAPABILITIES.<id>`) — missing key is a compile error. Every loader lazy (`await import()`). Key-only hosts reuse `configuredProvider(id)` via `GENERIC_API_KEY_SPECS`.
3. Integration module under `src/providers/integrations/`: mirror a sibling. `<id>.ts` (adapter), `<id>-shared.ts` (`buildExtraHeaders`, `prePayload`, `defineModel`), `<id>-oauth.ts`, `<id>-quota.ts`. Versioned providers register a resolver in `client-versions.ts`. Catalog rows use `defineModel({ id, endpoint, vision, reasoning, toolCall })`.
4. Endpoint gotcha: dispatch reads each row's `ModelDefinition.endpointPath`, not `endpoint_paths_by_wire_family` (only the `resolveEndpoint` fallback). `bundledModelCatalog()` throws on same-family conflicts — a version-less `baseUrl` plus a versioned chat path means explicit `endpoint` on every row of that family.
5. Dashboard mirrors (hand-maintained): display name in `BUILT_IN_PROVIDER_DISPLAY_NAMES`, `iconAssets` in `ProviderIcon.tsx`, section sets in `ProvidersPage.tsx`, `PROXY_UNSUPPORTED_HINT_PROVIDERS` when proxy routing is withheld. OAuth section derives from `oauthFlows` — no list edit. Run `dashboard:typecheck` after touching the mirrors.
6. Seed/restart: `seedBundledModels()` upserts on `(provider_id, model_id, endpoint_path)` and deletes stale `source = 'builtin'` rows; `enabled` is operator-owned. Static catalog changes need a backend restart.
7. **No file pins a provider count** — the contract is set equality. A new id lands in every mirror; no count in `README.md` either.

## 2 Change gate and commit

1. Gates from the root: `typecheck` → `dashboard:typecheck` → `build` (`dashboard:build`, then `build:aot`, then `build:binary` — compiles `dist/main.js` with `NODE_ENV=production` baked in).
2. Changelog in the same change under `## Unreleased` — backend, provider, dashboard bullets each.
3. Commit subjects are plain imperative sentences; no `type(scope):` prefix, no attribution trailer. Never push to `origin` unasked. Restart the built binary after landing when runtime behavior changed.
4. Strays: `git status --short` shows only intended paths; `.env*` stays untracked except `.env.example`.
5. Constraints: schema + baseline same commit; `await import()` stays lazy in `default-registry.ts`; explicit exported types, `import type` for types, no `index.ts` barrels; `await snapshotInvalidator?.invalidate()` after writes in detail/catalog/oauth routes.

## 3 Feature removal

Done when: no fallback, shim, or dead code remains and the report states what was deliberately not cut.

1. Measure import edges, not LOC: dependents = files OUTSIDE the cluster importing INTO it, across `src`, `scripts`, `dashboard/src`, `Dockerfile`, `package.json`, `README.md`.
2. Cut in order, staying compilable: composition root (`app.ts`, `runtime/dependencies.ts`) → config (`config.ts`, `.env.example`) → registration (`default-registry.ts`, console routes) → modules → schema (`schema.ts` + `0000_baseline.sql`, same commit) → dashboard (routes, hooks, `data/contracts.ts`) → `scripts/`, `Dockerfile`, `package.json`. Typecheck after EACH cluster.
3. Report what was NOT cut and why (shared helper, facade, sub-union).
4. **Watch out:** hiding a control (a `false` flag, a commented route) instead of deleting = dead code — delete registration, module, and reader / cutting modules before the composition root breaks every intermediate step / `dashboard/src` copies aren't dead on arrival — grep separately / `generated/` protobuf looks hand-written but isn't — trace its importer before dropping.

## 4 Consolidating duplication

Done when: exactly one module owns it, every caller reads that owner, and the copies are gone.

1. **Diff before believing.** "Looks the same" usually isn't. Extract the bodies and diff/hash them before merging; divergent copies need the owner chosen + the losing policy stated.
2. **Owner by layering, not call-site count.** The lower layer both sides already import owns the helper.
3. **Consolidate the caller shape too.** Eleven handlers with the same access block — the win is deleting the repetition at the call site. For repeated wrappers, look for a framework hook before a per-call helper.
4. **Migrate in one pass, then delete.** Typecheck between the two catches the missed call site.
5. **Keep deliberate divergence.** Resemblance with different protocol behaviour stays separate, with a comment saying so.

**Watch out:** identical-looking bodies differing in a throw path/default/wire shape silently change behaviour — diff first / deleting a copy while a caller imports it through a re-export or relative dashboard path breaks both trees differently — run `dashboard:typecheck` too / loose helper returns (`Record<string, unknown>`) starve spread sites of required fields — type against the destination.

## Verify

```bash
bun run typecheck
bun run dashboard:typecheck     # whenever dashboard/ or route contracts touched
bun run dashboard:build         # whenever dashboard/ touched, before bun run build
bun run build
```
