# Dashboard

`dashboard/` is the React/Vite client for the landing page, authenticated
`/console` surface, and public `/share/:token` enrollment app. One `index.html`
dispatches by pathname. Every app loads the same `src/styles/base.css`
(Tailwind, theme tokens, resets, and shared UI primitives) followed by one
direct, app-specific extension import: `console.css`, `landing.css`, or
`share.css`. There is no CSS barrel or duplicate global theme source.
Console-only shell and route styles stay in `console.css`; Landing's dark
story and manual chapter navigation stay in `landing.css`; Share's public HUD
stays in `share.css`, without a decorative background and with the same
`console-theme` preference as Console. Landing's GitHub badge sits immediately
before All view and links the repository with live star and fork counts; the
badge images come from external hosts admitted only under `img-src`; share-popup
images are HTTPS-only. `connect-src` remains same-origin, so the dashboard cannot
call arbitrary third-party APIs. Chapter auto-scroll is disabled.
- Public share links may include an owner-configured donation or information popup, click-opened from the Base URL card. `share.css` provides the responsive dialog layout for desktop and mobile.
Production serves the built files from `dist/dashboard`.

## Test tree

`src/` is production browser code only. Every dashboard test lives under
`dashboard/test/`, mirroring `src/` the way the root `test/` tree mirrors
`src/`:

- `test/` mirrors `src/` by role — `test/lib/api.test.ts` covers
  `src/data/api.ts`, `test/routes/Studio.tools.test.tsx` covers
  `src/routes/Studio.tsx`, and so on.
- `test/helpers/` holds shared scaffolding that imports `bun:test` and is never
  imported by `src/` (`test/helpers/test-helpers.ts`).
- `test/route-modules.test.ts` owns the render-level route contracts; the
  JSX-free backend-boundary contracts stay in the root `test/frontend/` tree.
- `bun run dashboard:test` runs `bun test test` inside the dashboard workspace;
  `tsconfig.json` includes `test` so `bun run dashboard:typecheck` checks the
  suite as well as the app. The root `bun run test` is the backend suite and does
  not run these.

## Route map

`src/main.tsx` dispatches landing, console, or share from the pathname. The
console app mounts a `BrowserRouter` with basename `/console` and lazy route
chunks:

| Path | Route component | Backend domain mirror |
| --- | --- | --- |
| `/login`, `/setup`, `/banned` | `Login`, `Setup`, `Banned` | `console/auth` |
| `/` | `Overview` | dashboard summary APIs |
| `/usage` | `features/usage/UsagePage` | `console/observability` and usage contracts |
| `/providers` | `features/providers/ProvidersPage` | `console/providers/catalog` |
| `/providers/:providerId` | `ProviderDetail` | `console/providers/detail` and catalog |
| `/combos` | `Combos` | `console/routing/model` |
| `/quota` | `features/quota/QuotaPage` | `console/quota` |
| `/proxy` | `Proxy` | `network/pool` and routing |
| `/customization` | `Customization` | none (browser-local: `dashboard/src/shared/customization`) |
| `/model-lab` | `Studio` | `console/domains/studio` |
| `/cli-tools`, `/cli-tools/:toolId` | `CliTools`, `CliToolDetail` | `console/cli-tools` |
| `/console-log` | `features/logs/ConsoleLogPage` | `console/observability/logs` and SSE |
| `/settings` | `Settings` | `console/settings` |
| Overview `API Credentials` row → share | `ShareManagementDialog` | `console/domains/api-keys` and `console/share` |
| Overview `API Credentials` header → `Banned Users` (platform admin only) | `ModelBansDialog` | `console/domains/model-abuse` |
| Overview `API Credentials` create / rotate / share-regenerate | `ApiKeySecretDialog` | `console/domains/api-keys` (one-time secret reveal) |
| `/share/:token` (public root route) | `apps/share/page.tsx` | public key enrollment (`/data`, `/issue`) and personal handoff (`/handoff`) via `src/console/share/share-router.ts` |
Landing's Console links point to `/console`, not `/console/login`: that
protected entry checks the same-origin session cookie and only routes to Login
when the existing session is absent or expired.

Unknown protected paths redirect to `/`. Session transitions clear the shared
query cache and navigate to `/login` or `/banned` rather than rendering stale
tenant data.

## Contracts and parity

- `src/data/contracts.ts` is the dashboard's API mirror. Backend DTOs remain the
authority; update the mirror in the same change and keep `dashboard/test/*-parity.test.ts`
  checks green.
- Provider display names in `src/shared/provider-names.ts` mirror the canonical
  bundled provider registry. Keep the exact bundled count and ids synchronized;
  BYOK providers are runtime data, not bundled registry entries.
- `src/components/ProviderIcon.tsx`'s `iconAssets` map and `features/providers/ProvidersPage.tsx`'s
  `FREE_LIMITED_IDS` / `FREE_AVAILABLE_IDS` / `FOUNDING_IDS` sets are the same
  kind of hand-copied provider-id list, guarded by
  `test/provider-lists-parity.test.ts`. The icon map may carry extra keys for
  ids a user can type into a compatible-provider form; every bundled id must
  have one.
- `src/data/contracts.ts` derives the session mirror from the backend
  `SessionStatusResponse` (a discriminated union on `status`) and pins it in
  `test/session-parity.test.ts`, so the wire arm and the dashboard view cannot
  drift field-by-field.
- `src/data/contracts.ts` re-exports the backend `USAGE_DIMENSIONS` tuple as a value, not a
  type-only copy, because the Usage page validates `?dim=` against it at runtime and offers one
  breakdown tab per member. It comes from `console/observability/usage-dimensions`, a module
  with no imports, rather than from `observability/contracts`, which imports Elysia and reaches
  `node:crypto` through the console error path. Pinned by `test/usage-dimensions-parity.test.ts`.
- Usage periods are generated into `src/data/generated/usage-periods.json` by
  `bun run codegen`; do not hand-maintain a second period list.
- Query keys, hooks, and route components must use the existing `consoleRequest`
  API boundary instead of constructing another HTTP client or importing backend
  modules.

## Browser-safe boundary

Vite bundles this tree for browsers. Never import backend modules, Elysia,
`node:*` APIs, database clients, provider adapters, secrets, or server-only
crypto into `dashboard/src`. Keep browser contracts as plain types and values;
hand-copy only the intentionally mirrored display metadata and protect it with
a parity test. OAuth tokens and provider credentials must stay server-side.

Vite only *warns* when a Node builtin is externalized for the browser, so this
rule is enforced by `test/architecture/dashboard-boundary.test.ts`, which walks
every `dashboard/src` value import into the backend graph and fails on the first
module that reaches Elysia, a `node:*` API, or a database driver. A backend
module a value must be shared from has to be import-free (like
`console/observability/usage-dimensions` and `security/access-control`) or
reached through a generated file, not through the module that happens to
declare it.

For route changes, update the lazy import, protected route map, shell navigation,
API hook, and this table together. For backend contract changes, update the
backend DTO, dashboard mirror, hook/request shape, affected route, and parity
coverage in one change.

## Development and verification

From the repository root, use the dashboard workspace scripts:

```bash
bun run --cwd dashboard dev
bun run dashboard:typecheck
bun run dashboard:test
bun run dashboard:build
```

`dev`, `typecheck`, `test`, and `build` run the usage-period code generator
first. Use `dashboard:build` before live-verifying a backend-served console.
