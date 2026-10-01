# Repo invariants

Checks that stop silent drift. Pick the sections your change touches. No ceremony for trivial work.

## No compatibility aliases

Removals, renames, contract cutovers.

1. Search runtime, scripts, dashboard, active docs for every old symbol/path.
2. Migrate every caller; remove the obsolete export in the same change.
3. Reject aliases, deprecated re-exports, migration facades, silent fallback branches — unless an explicit external compatibility promise requires one, documented with a removal condition.

Clean cutover = zero references to the old name.

## Single source of truth

A value/contract mirrored across backend, dashboard, generated output, or docs.

1. Name the authority before editing.
2. Trace all consumers; separate generated/mirrored copies from a second source of truth.
3. Move shared logic to the authority or generate the mirror. Remove stale duplicates.

## Provider registry authority

- `src/providers/provider-metadata.ts` owns identity.
- `src/providers/default-registry.ts` owns capability + lazy-loader entries.
- Dashboard names/icons/sets, catalogs, docs are synchronized consumers.
- Every bundled identity needs exactly one capability entry; custom/BYOK paths stay separate.

## Wire bytes

Parser, codec, endpoint, header, query, adapter changes.

1. Name the surface codec + provider adapter that own the bytes.
2. Separate structural cleanup from intentional protocol changes.
3. Preserve exact paths, prefixes, content types, headers, query params, serialized shapes — unless the upstream contract changed.
4. Never swap a wire requirement for a generic helper because it looks redundant.

## Naming and location

File moves, splits, merges.

1. Confirm the canonical path from neighboring modules.
2. Trace imports, dynamic imports, scripts, Docker/build readers, active docs before moving.
3. Clean cutover: update callers, remove old path. No barrels or compatibility files to preserve the old location.

## Envelope and version boundary

Quota, telemetry, cache, API, persisted envelope changes.

1. Define canonical shape + version marker.
2. Decide whether reads tolerate prior data; state when the old-read branch goes away.
3. Write the new envelope consistently at every producer. Preserve bounded retention and validation while migrating callers and docs.

## Dead keys and branches

Env vars, settings fields, feature flags, fallback constants.

1. Search literal readers + semantic consumers across source, scripts, dashboard, Docker, active docs.
2. Separate live kill-switches/safety fallbacks from obsolete keys.
3. Remove dead key, parser/schema field, docs together; re-run a zero-reference search.

## Fix, don't hide

Every bug fix, especially validation, error handling, timeouts, retries, capability checks.

1. State the cause as a mechanism first: "X reads Y, which is undefined/wrong when Z". Can't state it → still guessing, and a guess encoded in production outlives the symptom.
2. Classify the change. **Hiding** removes the report: deleting/widening a throw, loosening a validator, catching an exception, raising a timeout, adding a fallback, special-casing an input. **Fix** removes the cause. Hiding is fine only as a named temporary boundary with a removal condition.
3. Separate intended design from hiding. Capability degradation, operator-configured fallback, documented compatibility path = product behavior. Keep, name in a comment, never describe as a bug fix.
4. For a guard/probe, ask what the *other* arm does before deleting.

## Docs in sync

Every behavior, setting, route, provider, schema change.

1. Name the code authority + every active doc describing it.
2. Update the smallest authoritative docs in the same change.
3. Remove dead links, stale counts, obsolete names, contradicted claims.
4. Cite symbols and paths, never line numbers — they drift on every edit. Keep historical changelog entries historical.

## Skill self-improvement

After a cleanup review, rejected change, or newly discovered drift class.

1. Lesson must be procedural/reusable, not a one-off implementation note.
2. Search the skill folder before adding; extend the closest owner instead of creating another file.
3. State trigger, required check, failure mode, expected evidence.

## Proved deadness

Every deletion; every guard/fallback branch proposed as redundant. See `references/verification.md` for the full procedure.

1. A symbol is not dead because grep finds only its declaration. Rule out interface dispatch, callback fields, re-exports, dynamic imports, own-file use, dashboard copies.
2. For a guard/probe, ask what the *other* arm does first.
3. Easiest proof: delete, run `typecheck`, read the failure. Wrong removal → restore with a comment stating why it stays.

## How to report

For every invariant you applied:

```text
Check: <name>
Authority: <canonical file/symbol>
Scope: <files/surfaces checked>
Evidence: <search/command result>
Exceptions: <intentional compatibility/history, or none>
```

Never call a check satisfied from prose alone — evidence comes from current source, search results, or executed checks.
