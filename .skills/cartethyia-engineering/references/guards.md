# Repo invariants

## Canonical ownership

- One behavior, one source of truth.
- Find every branch using a flag, status, enum, mapping, or envelope before changing it.
- Do not create aliases, forwarding shims, or compatibility names.

## Boundaries

- `dashboard/src` must remain browser-safe: no Elysia, DB, filesystem, secrets,
  or Node-runtime imports.
- Treat every boundary value as untrusted and fail closed by default.
- Preserve intentional provider wire bytes and header behavior.
- Change generated output through its source/generator, never by hand.

## Naming and structure

- Keep `scripts/` flat with `ops-`, `build-`, or `ci-` prefixes.
- Avoid `index.ts` barrels; use role names such as `contracts.ts`, `routes.ts`,
  `store.ts`, `service.ts`, and `errors.ts`.
- Exported APIs need explicit types; do not use `any` or suppressions.

## Fix, do not hide

Adding a catch, fallback, timeout, cast, or weaker validation is valid only when
it is an intentional, documented compatibility boundary. Otherwise find the
mechanism and fix the owning layer.

## Docs and config

Update README, `.env.example`, layer docs, or references when a change makes a
claim or setting wrong. Do not leave deleted paths or symbols as false authority.

## Proved deadness

Before deleting a symbol, check imports, re-exports, dynamic imports, callbacks,
simple reflection, scripts, and docs. After deletion, typecheck and search the old name.

Absence of a producer inside `src/` is not proof a reader is dead. Classify the
value by who can still supply it, and record the verdict:

- **Dead** — no producer anywhere, including history. Delete it.
- **Live contract** — the shape is persisted with no backfill migration, so
  pre-existing rows still carry it. Keep it and pin it with a test; deleting it
  silently disables the feature for those rows.
- **Replayable** — the value arrives from a client or a peer instance, not from
  our database. A client replays ids it stored under an older build, and an
  upstream error string can embed another gateway's own formatted text. Keep it.

For the third class, trace the boundary rather than the call site: ask which
remote process could still emit the shape, and whether the wire format rejects
it outright if unrecognized. A separator outside the upstream's accepted
character set is not cosmetic — an undecoded composite fails the provider's own
validation.

## Evidence

Reports distinguish gates run, boundaries exercised, remaining failures, and
unavailable surfaces. Typecheck is not runtime verification.
