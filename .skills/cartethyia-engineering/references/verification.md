# Verification

Every change is verified at its real boundary before completion.

## Gates

```bash
bun run typecheck
bun run dashboard:typecheck     # when dashboard/ is touched
bun run build                   # when contracts/entry change (dashboard → AOT → binary)
```

The repository does not currently carry a test suite, so `typecheck` is the gate
and `build` proves the artifact still compiles end to end. Typecheck alone is
never proof of a behavior change: exercise the affected path at its real
boundary — a live request against the running gateway, the browser, or a
throwaway `.tmp-<topic>.ts` that calls the real function — and report what you
observed. State plainly when a surface is unavailable.

## Bug-fix loop

1. **Reproduce against the real function before changing code.** Write a throwaway `.tmp-<topic>.ts` at the repo root (gitignored via `.tmp-*`) and run it with `bun .tmp-<topic>.ts`. Print the actual output — the real pipeline, not a hand-built stub.
2. **State the mechanism, then fix the cause.** "X reads Y, which is undefined when Z." If the change only removes a throw, loosens validation, widens a type, adds a fallback, raises a timeout, or swallows an exception, it is hiding until proven otherwise.
3. **Verify at the real boundary before declaring done** (see above). Re-run the reproduction and read the new output.
4. **Sync docs in the same change** (`README.md`, `.env.example`, `CHANGELOG.md`, and this skill's references when a documented rule is reversed).
5. **Hand off:** `git add -A` — new source files are often untracked and `-a` misses them. `dist/` and `.env` are gitignored; `.env.example` is tracked. Tell the user the gateway must be restarted for transport/health changes to take effect.

## Proved deadness

Every deletion, and every guard/fallback branch proposed as redundant.

1. A symbol is not dead because grep finds only its declaration. Rule out interface dispatch, callback fields, re-exports, dynamic imports, own-file use, and dashboard copies.
2. For a guard/probe, ask what the *other* arm does first. A skipped transaction or advisory lock can be load-bearing for a partially-implemented dependency.
3. Easiest proof: delete, run `typecheck`, read the failure. Green output is evidence; confident reading is not.
4. Wrong removal → restore **with a comment stating why it stays**, so the next agent does not delete it again.

## Reproducing wire/encoding bugs

Drive the **real** pipeline from a `.tmp-<topic>.ts`, not a reimplementation:

1. **Parse the client surface** — `new MessagesAdapter().parse({ body, headers })` (or Chat/Responses adapter) with a realistic body. A minimal body hides the bug.
2. **Apply the same repair passes the dispatcher does** — for the buddy family, `dropIncompleteToolRounds` runs **before** `repairRequestToolCalls`; every other route runs repair alone (see `src/transport/request/preparer.ts`).
3. **Encode for the target wire** — `canonicalToChatPayload(request)` / `canonicalToClaudeMessagesPayload(request)`, then the provider's `prePayload` hook, since that is where system prompt, tool-name normalization, and reasoning fields land.
4. **Print the final `payload.messages` per turn** with `JSON.stringify`, plus reasoning/tool fields. Probe the whole space of turn shapes — the failing shape is often the one you did not think of.

**Fix rule:** if the same fact is re-derived in multiple call sites, do not patch the failing one. Hoist it next to the type it describes and switch every consumer.

## Migration ledger gotcha

`applySqlMigrations` skips any file already in `cartethyia_schema_migrations`, so editing `drizzle/migrations/0000_baseline.sql` never re-runs on an existing database. Hand-written follow-ups live in `drizzle/migrations/manual/` and must be applied by hand to every database. If a schema change must land on an existing deployment, say so and name the migration.

## Clean up

Remove every `.tmp-*` or `dashboard/tmp-*` before yielding. Leave no throwaway files in the tree.
