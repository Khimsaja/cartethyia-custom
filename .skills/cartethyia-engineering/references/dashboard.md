# Dashboard development and verification

Dashboard conventions for `dashboard/` (React, TanStack Query, no jsdom) — page chrome, social meta, share page, SSR verification, and real-browser verification. Consolidates the dashboard-page-chrome, dashboard-server-rendered-meta, share-page, dashboard-ssr-verify, dashboard-ui-verification, and verify-ui-without-browser-daemon skills.

Dashboard code must remain browser-safe: never import backend modules (Elysia, DB drivers, filesystem, secrets, Node-only runtime deps). Dashboard tests live in `dashboard/test/`, mirroring `dashboard/src/`.

## Scroll model (know this first)

- The single scroll container is `.app-main-column` (`overflow-y: auto`). Everything the router renders lives inside it (`Shell.tsx`).
- The app header `.app-topbar` is `position: sticky; top: 0` inside that same scroller.
- `.dashboard-page` and `.route-enter` are **not** scrollers. Never attach sticky/overflow logic to them expecting page scroll.

## Pinning a page toolbar under the header

1. `:root` declares `--topbar-height: 56px` (38px control + 8px padding × 2 + 1px border × 2). Adjust that one var if the header chrome changes — do not hardcode 56 elsewhere.
2. Add the shared class (already in `styles.css`):
   ```css
   .page-toolbar-sticky {
     position: sticky;
     top: var(--topbar-height);
     z-index: 20;
   }
   ```
3. Apply it to the shared `<Toolbar className="page-toolbar-sticky">` (`dashboard/src/components/ui/toolbar.tsx`).
4. The pinned bar must be visually opaque (`background: var(--surface-2)`) and carry `box-shadow: var(--shadow-card)` so content scrolling underneath stays legible. `<Toolbar>` already sets both.
5. Only the content *below* the toolbar should scroll — keep the toolbar as a sibling above the grid, not inside it.

## Polling-list ordering

- The quota overview re-polls (~60s) and can also poll fast while refreshing. Any sort **must** be stable, or the grid reshuffles on every poll.
- Always supply a name tiebreaker:
  ```ts
  const byName = (l, r) => l.name.localeCompare(r.name, undefined, { sensitivity: "base" });
  return [...rows].sort(expiringFirst ? (l, r) => firstResetAt(l) - firstResetAt(r) || byName(l, r) : byName);
  ```
- Sort provider/filter option lists at the memoized source, not inline in JSX.

## Checklist

- [ ] Sticky offset uses `var(--topbar-height)`, not a magic number.
- [ ] Pinned bar is opaque + shadowed.
- [ ] Sort is stable with a name tiebreaker.
- [ ] `bun run dashboard:typecheck` and `bun run dashboard:test` pass.
- [ ] Confirm the built CSS actually contains the rule: `grep -o "page-toolbar-sticky{[^}]*}" dist/dashboard/assets/*.css`.

## Per-route social meta (single shared index.html)

`dashboard/index.html` is the ONE document served for `/` (landing), `/console/*` (admin console), and `/share/*` (public enrollment). Client-side routing happens in `dashboard/src/main.tsx` via `dashboard/src/lib/app-entry.ts` (`resolveDashboardApp`). Production serving is `src/console/dashboard-assets.ts` → `createStaticHandler({ buildDir })`, whose `serveDocument()` returns the SPA document for extensionless routes. Dev equivalent is the `multiPageRouting()` plugin + `/share` proxy bypass in `dashboard/vite.config.ts`.

Social crawlers (Discord, Twitter, Slack, WhatsApp) do NOT execute the client bundle, so `document.title = ...` never reaches them. OG/Twitter tags must be in the served HTML.

Recipe:
1. In `dashboard/index.html`, wrap the whole OG + Twitter meta block with sentinels: `<!-- cartethyia:social-meta:start -->` … `<!-- cartethyia:social-meta:end -->`.
2. In `src/console/dashboard-assets.ts`, add a `SocialMeta` type, a per-route constant (e.g. `SHARE_SOCIAL_META`), `renderSocialMeta()`, `escapeHtml()`, and `applySocialMeta(html, pathname)` that:
   - returns html unchanged when pathname is not `/share` or `/share/*`;
   - replaces the sentinel block via `/<!-- cartethyia:social-meta:start -->[\s\S]*?<!-- cartethyia:social-meta:end -->/`;
   - also replaces `<title>…</title>` and `<meta name="description" content="…" />`.
   Always HTML-escape injected values.
3. Thread `pathname` into `serveDocument(document, pathname)` and encode the result with `new TextEncoder().encode(html)` (body stays `Uint8Array`).
4. CSP is computed from the served body in `applyStaticSecurityHeaders` via `dashboardContentSecurityPolicy(html)` which hashes inline scripts — injecting only `<meta>` tags keeps that safe.

Verify:
- `bun run typecheck` (root) — clean.
- `bun run dashboard:build`, then confirm `dist/dashboard/index.html` still contains both sentinel comments.
- Live check against a running gateway (default `:12800`): `curl` `/`, `/console/dashboard`, and `/share/<43-char-token>`; assert `og:image` is `/og_image.webp` for the first two and `/og_bansos.webp` for share, and that share `<title>` is the share title.
- Regression test: `test/console/dashboard-assets.test.ts` pattern — build a temp `index.html` containing the sentinel block, assert the swap for `/share/...` and non-swap for `/` and `/console/...`.

Gotchas:
- `dashboard/public/og_bansos.webp` (share) and `og_image.webp` (landing) are both 1760×576.
- Do not add a second html file / Vite multi-page input — the project deliberately unified to one document.

## Share page (public enrollment HUD)

`dashboard/src/apps/share/page.tsx` + `dashboard/src/styles/share.css`, mounted by `dashboard/src/apps/share/entry.tsx`.

- Backdrop: `when_yah/cartesa.webp` as a fixed `body` background with a veil layer. `--share-backdrop-veil` is 0.8 in light, 0.6 in dark (dark shows more art). Cards use `var(--glass-bg)` + `backdrop-filter` so they read as frosted glass, not opaque slabs.
- Theme: dark is the default for `/share` (bootstrap in `index.html` defaults an unset `console-theme` to `dark` only when `isShare`); toggle sits beside Home and writes the shared `console-theme` key. `readConsoleTheme(fallback)` accepts a fallback so share can pass `"dark"`.
- Model list has a Raw/Grouped switch beside "Copy all". Raw is the DEFAULT: an auto-fit grid of cards (`.share-model-grid`, `repeat(auto-fill, minmax(240px,1fr))`) showing full ids. Grouped buckets by provider, each bucket scrolling a single-column grid. A card (`ModelCard`) mirrors the provider catalog's model card — icon tile, mono name, icon-only Copy, then a capability/limits line — but offers Copy alone: no probe, enable/disable, or delete, which a share recipient must not be able to click.
- Token figures (quota rows, the Tokens KPI, both table bars) all read one unit from `ShareStatsProvider` in `dashboard/src/apps/share/stats.tsx`, so the hero and the tables can never disagree about the same number. The default is the exact count, matching the usage page; `TokenUnitSwitch` cycles raw → auto → T → B → M → K, and the choice is remembered under `cartethyia:share-token-unit`.

Tests render to static markup (`renderToStaticMarkup`) with `useShareData` mocked via `mock.module`, so markup-only changes are safe; stateful toggles must be asserted by their initial (default) rendering.

## SSR verification (no browser needed)

Use when a dashboard change needs proof but the browser is unavailable or when you only need structural/layout assertions.

Write a throwaway `dashboard/tmp-*.tsx` script (delete it afterwards — it is never a committed test):

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import Proxy from "./src/routes/Proxy";
import { queryKeys } from "./src/lib/query-keys";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
// Seed EVERY query the page reads, keyed through queryKeys (never inline keys).
queryClient.setQueryData(queryKeys.network.pools, [pool]);
queryClient.setQueryData(queryKeys.network.poolStrategy, strategy);

const markup = renderToStaticMarkup(
  createElement(QueryClientProvider, { client: queryClient }, createElement(Proxy)),
);
```

Run with `bun dashboard/tmp-<name>.tsx`.

What to assert:
- **Count occurrences** of a heading to catch duplicates: `markup.split("Pool Selection").length - 1 === 1`.
- **Relative order** by index comparison: `markup.indexOf(a) < markup.indexOf(b)` proves placement.
- **Control presence by id**: `markup.includes('id="pool-strategy-rotate-count"')`.
- **Grouping/layout intent**: slice the region and check the wrapping `style="display:flex;...justify-content:space-between"` around the controls.

Gotchas:
- Pages with unseeded queries render their loading state, so seed all of them or the assertion silently passes against a spinner.
- `renderToStaticMarkup` does not run effects, so `EventSource`/SSE hooks and `useState`-driven interactions (toggle flips, blur handlers) cannot be verified this way — assert markup only and say so.
- `lucide-react` icons expand to full `<svg>` markup; anchor on ids/text, not on SVG attributes.
- The script is throwaway: remove it before yielding and report that visual confirmation in a real browser was not performed.

The repo's committed harness is the same technique: `dashboard/test/**` uses `bun:test` + `renderToStaticMarkup`. There is NO jsdom/happy-dom/@testing-library — assert on markup strings. Mock data hooks with `mock.module(...)` BEFORE dynamically importing the component under test. Mutation-test the fix (revert, confirm failure, restore, confirm pass).

Diagnosing a blank `/console/*` page: if the page renders nothing and the console has no errors, fetch the dev HTML and look at the script tag — if it references `/assets/index-*.js` (a hashed build chunk) that 404s, the dev server is serving a STALE build output. Fix: restart `bun run dashboard:dev`. Not a code regression.

## Real-browser verification (daemon unavailable)

Prefer this over the SSR-markup recipe when the claim is about *layout*, because `renderToStaticMarkup` runs no CSS. This drives system Edge over raw CDP, so it needs no npm dependency.

Steps:
1. **Launch Edge with CDP.** `msedge.exe` lives at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. Spawn with a throwaway `--user-data-dir` (a locked profile from the user's own running browser will fail). Poll `/json/version` until it answers — never assume the port is up.
2. **Attach over WebSocket.** `GET /json/list` for an existing page target, or `PUT /json/new?about:blank`. Talk CDP directly: `{id, method, params}` out, correlate responses by `id`, dispatch events to handlers. `Page.enable` + `Runtime.enable` first. Build helpers once: `evalJs(expr)` → `Runtime.evaluate` with `returnByValue` and `awaitPromise` (check `exceptionDetails` and throw, or failures surface as silent `undefined`); `shot(name)` → `Page.captureScreenshot`, write base64 to a temp file, then **read the image back** — a screenshot you never look at proves nothing.
3. **Serve the BUILT dashboard statically** (`Bun.serve`, SPA fallback to `/index.html`). Rebuild (`bun run --cwd dashboard build`) before each verification round — the static server reads `dist/`, so a stale bundle silently verifies the old code. **Do NOT reuse the user's `bun run dashboard:dev` on :5173** — often already running and, when its dep cache is stale, serves 504 for `/node_modules/.vite/deps/*` and the app never mounts. Do not restart or kill it either — serve your own build on another port.
4. **Intercept the console API.** `Fetch.enable` with `{urlPattern: "*/console/api/*", requestStage: "Request"}`, then answer `Fetch.requestPaused` by URL. Read the real call list first (`Network.requestWillBeSent`) rather than guessing. Traps: never use a catch-all `*` pattern (it pauses Vite's module graph → `net::ERR_ABORTED`); answer with the shape each endpoint actually has (returning `{}` for `/providers` throws `F.filter is not a function`); register handlers on a FRESH CDP connection when changing stubbing strategy; to hold a request open, `setTimeout` the `Fetch.fulfillRequest` instead of awaiting; rebuild/reload between rounds, prefer a fresh target over `Page.reload` when the DOM was mutated.
5. **Measure, don't eyeball.** For centering/overflow claims, assert numbers (`getBoundingClientRect`, `scrollWidth`/`clientWidth`). Check at **two viewport heights** via `Emulation.setDeviceMetricsOverride`; a layout that centers at 900px can overflow at 487px. When isolating a layout cause, mutate **one** property on a **pristine** DOM (reload first) and revert it.
6. **Tear down.** Stop the static server, close CDP targets, delete temp screenshots and the throwaway `--user-data-dir`. Report that verification was done in a real browser engine over CDP, not via the shared daemon.
