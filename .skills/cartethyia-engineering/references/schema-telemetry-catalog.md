# Schema, telemetry, and model catalog

Schema migrations, per-request telemetry columns, full-stack renames, model metadata sources, catalog availability curation, in-flight leak diagnosis, and reasoning-replay invariants. Consolidates the schema-migration, add-telemetry-column, fullstack-rename, model-metadata, model-availability-curation, inflight-leak-debug, and reasoning-replay skills.

## Schema change (three places, all required)

Migrations apply in filename order and are recorded by FILENAME in `cartethyia_schema_migrations`. Editing an already-shipped `NNNN_*.sql` is a silent no-op on any DB that recorded it.

1. Edit `src/persistence/schema.ts` (Drizzle table) — source of truth for runtime types.
2. Fold the full shape into `migrations/0000_baseline.sql` (fresh installs only), same position/order as `schema.ts`. The baseline is the whole schema for a database created today; `migration-integrity` asserts it carries the folded-in shape, and `isolated-db` compares a freshly migrated database against `schema.ts` column by column. Nullable pattern when null means inherit/unlimited: omit `.notNull()` and `.default()`.
3. Add a NEW file `migrations/<next>_<desc>.sql` with only the forward change, idempotent:
   ```sql
   ALTER TABLE "telemetry_events" ADD COLUMN IF NOT EXISTS "resolve_ms" integer;
   --> statement-breakpoint
   ```
   `--> statement-breakpoint` separates statements. Next number = one past the highest shipped file.
4. Update `test/integration/isolated-db.test.ts` `expectedColumns` map (name, dataType, udtName, nullable).
5. Run `bun run typecheck` and `bun test test/integration/isolated-db.test.ts test/contracts/migration-integrity.contract.test.ts`.

Gotchas:
- Numeric Drizzle columns are string-typed: persist `String(value)`, not the raw number, or typecheck fails with "Type 'number' is not assignable to type 'string'".
- Absolute epoch-ms timestamps need `bigint(..., { mode: "number" })`; int4 overflows at ~2.1e9. Small ms counts (resolve overhead) are fine as `integer`.
- `migration-integrity` requires every post-baseline file to contain `IF NOT EXISTS` / `IF EXISTS` / `EXCEPTION`.
- `applySqlMigrations()` reads numbered `NNNN_*.sql` from the top level (non-recursive) at boot and applies each in order, recording it in the ledger — a deployment migrates itself with no hand-run step. Manual follow-ups in `drizzle/migrations/manual/` must be applied by hand to every database (the ledger skips recorded files), including Railway/prod — say so in the report.

## Add a per-request telemetry column (end-to-end chain)

A new usage field flows through this exact chain — touch every layer or the value silently never appears:

1. **Canonical model** — `src/transport/canonical-model.ts`: add the optional field to `UsageRecord`; document whether absence is meaningful (e.g. `undefined` = upstream never reported it).
2. **Normalizer** — `src/providers/usage.ts`: read the raw upstream field in `normalizeUsage` and spread it conditionally (`typeof input.<raw> === "number" && Number.isFinite(...) && >= 0`). Reject NaN/negative/out-of-range; never clamp silently. Test in `test/providers/usage.test.ts`.
3. **Database** — three files: `src/persistence/schema.ts`, `migrations/0000_baseline.sql`, `migrations/<next>_<desc>.sql` (§Schema change above).
4. **Telemetry writer** — `src/observability/telemetry-buffer.ts`: map it in `telemetryEventRow` (numeric columns need `String(value)`, `null` when absent).
5. **Console read path** — `src/console/observability/contracts.ts` (`UsageRequestItem`), `src/console/observability/store.ts` (`mapUsageRequestItem`, `Number(event.<col>)` guard), `dashboard/src/hooks/common.ts` (add the field name to the numeric validator in `assertUsageRequestItem`, or the dashboard rejects every response).
6. **Dashboard** — `dashboard/src/features/usage/UsagePage.tsx`: exported formatter + row render; test formatter cases including the absent/NaN path.

Live-probe a provider field before wiring it: resolve a stored account credential (`resolveCredentialForAccount` + `readCredentialSecret`) and POST directly, never logging the secret. Note some providers need a specific shape (CodeBuddy needs `stream: true` AND a leading `system` message). Delete the throwaway probe afterwards.

Verify: typechecks, dashboard tests, `bun test test/contracts/migration-integrity.contract.test.ts test/providers/usage.test.ts test/console/`. Mutation-check the normalizer (flip the guard, confirm fail, restore).

## Full-stack persisted-field rename / strategy removal

1. TS source: enum in `src/transport/routing/route-model.ts` (or equivalent), router logic, console contracts, detail store, validation in detail routes, snapshot builder in `src/transport/routing/route-catalog.ts`.
2. DB: update `src/persistence/schema.ts` AND `migrations/0000_baseline.sql` in the same commit; add `drizzle/migrations/manual/NNNN_*.sql` following the header style of `0005_*` (hand-run note, why baseline edit is not enough, isolated-db test note). Enum removal: drop DEFAULT first, rename old type, create new type, `ALTER COLUMN ... TYPE ... USING col::text::newtype`, restore DEFAULT, drop old type.
3. Apply via `bun -e` with `bun:sql` to BOTH `cartethyia` and `cartethyia_test` (isolated-db asserts exact schema — run it with `CARTETHYIA_TEST_DATABASE_URL` set).
4. Dashboard: contracts re-export backend types, so update `dashboard/src/lib/hooks/common.ts` assertion + test, the hook, and the card. No alias fields.
5. Tests: convert or delete tests covering the removed value; add validation tests for the new field/bounds.
6. Docs: `src/transport/TRANSPORT.md` + the routing triage section in `references/debugging.md`.
7. Verify: typechecks, targeted tests, build. If surgical edits corrupt a file, rewrite it whole instead of more patches.

## Model metadata sources and `/v1/models`

| Source | What it carries |
|---|---|
| OpenCode `https://opencode.ai/zen/v1/models` | **id-only** — `id/object/created/owned_by`. No modalities, context, or pricing. |
| `https://models.dev/api.json` | **Rich.** Keyed by provider slug. Per model: `modalities{input,output}`, `limit{context,input,output}`, `cost`, `reasoning`, `tool_call`, `structured_output`, `attachment`, `release_date`, etc. |
| `src/providers/discovery/base-models.json` | Offline committed snapshot of models.dev. `ModelsDevCatalog` reads only this — never the network. |

Provider-id remap lives in `MODELS_DEV_PROVIDER_IDS` (`src/providers/discovery/models-dev-catalog.ts`).

`/v1/models` entries (served by `PublicModelCatalogStore`, `src/console/providers/catalog/public-model-store.ts`; routes in `src/app.ts` on the Elysia gateway with `prefix: "/v1"`):

```
{
  id: "<providerId>/<modelId>",
  object: "model",
  created: <unix-seconds>,
  owned_by: "<providerId>",          // alias/combo entries: "cartethyia"
  context_length?: number,
  max_completion_tokens?: number,
  capabilities?: { input: string[], output: string[] },
  reasoning?: boolean,
  tool_call?: boolean,
  web_search?: boolean,
  cost?: object
}
```

Optional fields are **omitted, not null**. Alias/combo entries always include `context_length`/`max_completion_tokens` (defaults 200000 / 64192).

The published `capabilities` uses the closed set **`text | image | audio | video | pdf`**. Catalog rows store provider-native spellings; normalize at the emission boundary (`document`/`file` → `pdf`; drop tokens outside the set; `undefined` when nothing survives). A pool may route to any member, so claim a capability only when **every** member has it, and quote a price only when all members bill alike (`commonCost` compares the `input/output/cache_read/cache_write` signature). Limits take the minimum across members.

Known gaps: discovery (`openai-model-discovery.ts`) still hardcodes `modalities:["text"]` / `reasoning:false` when upstream states nothing (bare-id map keeps one row — attributing a stranger's capabilities would be wrong); only provider-keyed `resolve(providerId, id)` is trusted. The `models` table itself is not yet unified to the pdf/video vocabulary.

## Model availability curation

To probe every model a provider exposes and keep only the ones that actually answer: drive the console API over CDP — the procedure is real-browser verification (`references/dashboard.md`), not `decodeChatSseStream` through `bun -e` (that proves parser behavior, not availability). Confirm the gateway `:12800` and the browser share the provider's OAuth access (same upstream account) or the probe measures the wrong credential.

## In-flight / pool-slot leak (client disconnect mid-stream)

Symptom: dashboard Usage "in flight" gauge (or `proxy_in_flight`) climbs and never returns to 0, while pools look correct. Persistent across requests.

Model of the counter:
- `startProviderFlight()` registers a flight once per logical `/v1/*` request, after attempt leases are acquired (`src/transport/request/state.ts`).
- The flight is released ONLY inside `state.cleanup()` (idempotent via a `cleaned` flag), which is the single teardown point.
- The registry is owned by `ProxyRequestStateStore` (`inflight.ts`), so the gauge cannot count a request the store has already evicted.
- Non-streaming requests clean up via the root `afterResponse` hook (`registerTelemetryLifecycle` / `registerRequestCleanup` in `src/transport/middleware/error-lifecycle.ts`, mounted from `pipeline.ts`).
- Streaming requests skip that hook (`state.streaming = true`) and clean up only from `releaseStreamResources()` in `src/transport/dispatch/proxy-request.ts` — called from `pull()` (normal completion, mid-stream error, deadline/stall), `cancel()`, `finalizeStream()`, `emitStreamErrorAndClose()`, and the abort listener.

The leak: `pull()` runs only when the consumer asks for more data. A client that half-closes (stops reading, keeps the socket) reaches no release branch, and `cancel()` is not reliably invoked for an abrupt socket drop. If the abort listener also skips release for a deadline/stall abort (assuming a pull is watching), the reservation + pool slot + in-flight count leak for the process lifetime.

Diagnosis: confirm the gauge never returns to 0 (`GET /console/api/live/in-flight` or `proxy_in_flight`); reproduce in a unit test against `handleProviderProxyRequest` (`test/transport/dispatch/proxy-request.test.ts`) with a streaming adapter that yields a prelude then awaits a paused promise — never read from the body (so no `pull()` runs), then abort WITHOUT `reader.cancel()` (call `state.abortController.abort(new GatewayError("deadline_exceeded", 504, …))` directly) and assert the count settles to 0. Prove the test catches the bug by restoring the old `if (drain === undefined && !clientDisconnect) return;` guard (must fail `Expected: 0, Received: 1`).

Fix: the abort listener on `state.abortController` (registered before `releaseStreamResources` is used) must release on every
abort with no pending pull — not only an `AbortError`. A deadline/stall abort lands with no pending `pull()` whenever the client
half-closed (kept the socket, stopped reading), and the upstream iterator may ignore the abort, so nothing else releases it:

```ts
let pullActive = false; // set true at the top of pull(), false in its finally

function onStreamAbort(): void {
  const reason = state.abortController.signal.reason;
  const drain = drainAbortReason(reason);
  const clientDisconnect =
    drain === undefined && reason instanceof DOMException && reason.name === "AbortError";
  // A pending pull owns the abort it triggered (drain → terminal frame;
  // deadline/stall → records the outcome). Only a pending one.
  if (pullActive && !clientDisconnect) return;
  if (clientDisconnect && !state.outcome) state.outcome = { status: "cancelled", httpStatus: 499 };
  void (async () => {
    try { await iterator.return?.(); } catch {}
    await releaseStreamResources();
  })();
}
state.abortController.signal.addEventListener("abort", onStreamAbort, { once: true });
if (state.abortController.signal.aborted) onStreamAbort();
```

The gauge itself is now a registry **owned by `ProxyRequestStateStore`**, not a free-standing module — the store is the one
place that evicts a request, so a flight cannot outlive its state. As a last resort a periodic backstop
(`ProxyRequestStateStore.sweepOverdueInFlight`, the `inflight-backstop` scheduled task) force-releases any flight past its
deadline plus a grace window, so the number settles even for a disconnect shape the abort listener did not model. Do NOT release
from the abort listener when a pull is pending: it already emits the frame and records the outcome, and releasing early
double-finalizes telemetry.

## Reasoning replay across wire surfaces

Use when thinking is missing for a client, or the upstream answers 400 `the reasoning content from the previous turn must be passed back in thinking mode` (DeepSeek V4, WorkBuddy, CodeBuddy, MiMo).

The invariant: three wire shapes are ONE canonical `{ kind: "reasoning" }` content part, and every shape must survive a surface change:

| Wire | Inbound shape | Outbound field |
| --- | --- | --- |
| Messages | `thinking` / `redacted_thinking` block | `thinking` block (signature marks the turn) |
| Chat | sibling `reasoning_content` string | `reasoning_content` (assistant-only) |
| Responses | separate `input` item, `type: "reasoning"` | separate `reasoning` item |

Responses is the one that bites: the item's text lives under **either** `summary` (`summary_text` blocks) **or** `content` (`reasoning_text` blocks), and it streams as **either** `response.reasoning_summary_text.delta` **or** `response.reasoning_text.delta`. Reading only one of each silently drops the chain of thought.

Non-negotiable rules:
1. **Presence, not length.** Gate emission on the field/part existing, never on non-empty text. `display: "omitted"` yields an empty-text thinking block carrying a signature the upstream still demands back — `""` is correct there.
2. **Never fabricate.** Do not write `reasoning_content: ""` onto a turn that never had reasoning. The upstream reads that as "thinking mode with the reasoning stripped" and returns the same 400.
3. **Assistant-only.** A non-assistant turn never carries `reasoning_content`.
4. **Tool-call turns are the load-bearing ones.** The turn that decided to call a tool is exactly where the trace is required; a `tool_calls` turn must not drop it.
5. A reasoning-only assistant turn must not be dropped either.

Where to look: `src/transport/surface/chat/parse.ts` (inbound → canonical), `src/transport/surface/chat/encode.ts` (`eventReasoningText`, `mergedReasoningText`), `src/transport/surface/responses/parse.ts` (`responseReasoningSummary` / `responseReasoningContent` / `reasoningItemText` + the fold merging a `reasoning` input item into its assistant turn), `src/transport/surface/responses/encode.ts` (`openReasoning`, `openReasoningSummaryPart`, `content.kind === "reasoning"` push), `src/protocol/response/responses.ts` (SSE decode cases, `parseResponsesResponseToEvents`), `src/providers/usage.ts` (`RESPONSES_REASONING_DELTA_TYPES` / `readResponsesReasoningDelta`), `src/providers/reasoning.ts` (`backfillDeepSeekReasoningContent`, `applyDeepSeekReasoning`), `src/protocol/request/chat.ts` (`canonicalToChatPayload` — tool-call and plain-assistant branches each attach `reasoning_content`).

Procedure: read the failing request body from the payload capture (see `references/payload-and-tracing.md`) — never guess the shape. Write a `.tmp-diag.ts` running the REAL pipeline on that body and count the loss; list input items in order and note which `function_call` items have no adjacent `reasoning` item (providers emit the pair in both orders). Fix at the layer that lost it, and fix the sibling shape in the same change — the two Responses event names and the two item text fields always travel together.

Tests: `test/protocol/response/responses.test.ts` (SSE decode of both delta names + `content`-block item), `test/transport/surface/chat.test.ts` (tool-call turns, omitted-display block, reasoning-only turn, empty-string preservation), `test/transport/surface/responses.test.ts` (encode side), `test/providers/reasoning.test.ts` (backfill only from a real trace), `test/providers/integrations/buddy/*.integration.test.ts` (coalescing + no-empty rule). Mutation-test every new assertion (flip the gate, confirm fail, restore).
