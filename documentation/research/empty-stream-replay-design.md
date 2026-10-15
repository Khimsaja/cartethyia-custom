# Empty-stream replay + pre-start failover — design

- Date: 2026-10-15. Type: design spike, no source changes.
- Donor: the reference client `packages/ai/src/providers/google-gemini-cli.ts:931-1102`
  (`MAX_EMPTY_STREAM_RETRIES = 2`, `EMPTY_STREAM_BASE_DELAY_MS = 500` in
  `google-shared.ts:446-447`; first-event default 300s at `:324`;
  per-endpoint retry `MAX_RETRIES = 3`, 1s exponential, 5-min budget at `:322-329`).
- Ours: `src/transport/dispatch/attempt-loop.ts` (candidate failover),
  `src/transport/failure-policy.ts` (retry classification, backoff),
  `src/transport/dispatch/streaming/stream.ts` (first event primed pre-commit),
  `src/config/timeouts.ts` + `spec.ts:139-154` (budgets).

## 1. Where the helper lives

Proposed file: `src/transport/dispatch/empty-stream.ts`.

Why there: `src/transport/` has no generic stream-content helper today; the
closest owners are `dispatch/retry-policy.ts` (refresh/cooldown predicates),
`dispatch/upstream.ts` (dispatch-context builders), and root
`failure-policy.ts` (classification + `fallbackRetryDelayMs`). An
empty-stream policy is a dispatch-level retry predicate with its own fetch
loop, so it sits beside `retry-policy.ts`, not in `routing/` (no candidate
knowledge) and not in `surface/` (no wire decoding). One behavior, one owner,
per `.skills/cartethyia-engineering/references/taste.md`. It composes with —
not duplicates — the existing policy:

- Classification: on exhaustion it throws the existing `GatewayError`
  (`platform_unavailable`, 502, `upstream` origin — the same shape
  `antigravity.ts:356-362` already throws for a bodyless stream). Per
  `classifyUpstreamFailure`, 5xx is retryable, so the attempt loop
  (`attempt-loop.ts:312`) advances to the next candidate for free.
- Backoff between replays: caller-injectable `sleep`; defaults mirror the
  donor (500ms * 2^n), not `fallbackRetryDelayMs`, because empty-replay is a
  same-endpoint identical retry, not candidate failover. Inter-endpoint moves
  need no delay (donor does none pre-start).
- It must NOT reimplement `retryWithBackoff` (`src/network/retry.ts`): that
  helper is for idempotent metadata lookups with jittered backoff on thrown
  errors; empty-stream recovery keys off stream *content* (a 200 that decoded
  to nothing), which `retryWithBackoff` cannot observe.

## 2. Function signatures

The helper is generic over event decoding: it owns fetch, watchdog, backoff,
and endpoint rotation; the caller owns SSE decoding via the shared
`decodeSseEvents` (`src/protocol/sse-decoder.ts`). This is what keeps it
transport-layer rather than per-provider.

```ts
/** What the caller's drain observed. Counts only dispatched data events:
 *  comments/keepalives, `[DONE]`, and whitespace-only data are excluded. */
export interface StreamTally {
  readonly dataEvents: number;
  readonly meaningful: boolean;   // text/tool deltas or accepted content
  readonly thoughtOnly: boolean;  // STOP with reasoning but no final output
}

/** Drain one response body to a tally. Provider-supplied; uses decodeSseEvents. */
export type DrainStream = (response: Response, signal: AbortSignal) => Promise<StreamTally>;

/** Bound fetch for one endpoint. Receives materialized headers + serialized body. */
export type EmptyStreamFetch = (
  url: string,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<Response>;

export interface EmptyStreamPolicy {
  readonly maxEmptyReplays?: number;      // default 2 (donor parity)
  readonly baseDelayMs?: number;          // default 500 (donor parity)
  readonly firstEventTimeoutMs?: number;  // default: see watchdog below
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface EmptyStreamResult {
  readonly response: Response;  // the successful, undrained-or-drained response
  readonly tally: StreamTally;
  readonly endpoint: string;    // which endpoint produced it
  readonly replaysUsed: number;
}

/** Replays the byte-identical request while responses drain empty,
 *  failing over across ordered endpoints pre-start.
 *  Throws GatewayError (platform_unavailable, 502, upstream) on exhaustion,
 *  GatewayError (transport_closed, 499) on abort. No new error type. */
export async function fetchWithEmptyStreamRecovery(
  endpoints: readonly string[],
  request: { headers: Record<string, string>; body: string },
  deps: {
    fetch: EmptyStreamFetch;
    drain: DrainStream;
    signal: AbortSignal;
    deadlineMs: number;
    policy?: EmptyStreamPolicy;
  },
): Promise<EmptyStreamResult>

/** Pure predicate, exported for unit tests and the Codex call site. */
export function isEmptyStream(tally: StreamTally): boolean {
  return tally.dataEvents === 0 || (!tally.meaningful && !tally.thoughtOnly);
}
```

What counts as "empty": zero SSE data events (zero bytes and valid-SSE-with-no-content
converge here — after `decodeSseEvents`, both yield no dispatched events), OR data
events with nothing meaningful (no text/tool deltas, no STOP finish). Carve-outs,
matching the donor (`:1023-1037`): a thought-only STOP is a *complete* provider
response — replaying it burns a full reasoning pass for nothing, so it breaks
without replay; a caller-accepted empty (e.g. Advisor-style `acceptEmptyResponse`)
is honored only on the last endpoint or with thought output.

First-event watchdog: the helper arms a pre-response timer per fetch, cleared on
the first data event; after that the gateway stall watchdog governs. Budget
composition with the real constants (`spec.ts:139-154`):

- `CARTETHYIA_UPSTREAM_TIMEOUT_MS` default 120s bounds the whole pre-stream
  phase including replays; every replay checks `deadlineMs - now` against the
  attempt-loop's 15s `MIN_RETRY_BUDGET_MS` floor before firing.
- `CARTETHYIA_STREAM_FIRST_CHUNK_TIMEOUT_MS` default 200s (min 30s, max 300s)
  is the default `firstEventTimeoutMs`, capped by remaining deadline.
- The donor's 300s default is deliberately NOT adopted: it exceeds our 120s
  pre-stream deadline, so it could never fire before the deadline kills the
  attempt. Donor parity on this number would be dead config.
- Post-establishment, `CARTETHYIA_STREAM_STALL_TIMEOUT_MS` (360s) already
  governs; the helper releases the timer at first event and never touches it.

Endpoint failover ordering: caller-supplied ordered list; Antigravity passes
`[prod, sandbox]` (production `daily-cloudcode-pa`, sandbox twin — same order
the donor builds at `:534-574`). Per endpoint: fetch (with first-event
watchdog) → drain → replay identical bytes up to `maxEmptyReplays` with
500ms * 2^n backoff → advance to next endpoint on continued emptiness.
Non-OK responses are NOT this helper's job: the adapter maps them via
`mapUpstreamHttpError` first (existing prod→sandbox 429/5xx failover at
`antigravity.ts:278-286` stays as-is for the first fetch). Last-good-endpoint
stickiness (donor `:1076-1081`) is out of scope; the helper only reports which
`endpoint` succeeded so a later stickiness change has the signal.

## 3. State the helper must NOT own

Credential resolution stays with the caller. The helper receives materialized
`headers` (Bearer already stamped) and a serialized `body` string; it never
sees `ResolvedCredential`, never refreshes OAuth, and never interprets 401/403
(the adapter maps those to `GatewayError` with `credentialEvidence` before the
helper is involved, so the attempt loop's reactive refresh in
`attempt-loop.ts:374-394` keeps working unchanged). Letting a transport retry
loop touch credentials would fork the single refresh path and risk double
refresh races between the helper's replay and the loop's `ensureFreshAccessToken`.

Egress pool selection stays with the caller. Leases, pool slots, and routing
reservations are acquired once per candidate attempt in `runAttemptLoop` and
released by the streaming branch (`stream.ts` owns release for the body
lifetime). The helper receives a `fetch` already bound to the selected pool
(the adapter's `context.outbound_fetch`) and performs all replays inside that
binding. Re-selecting egress per replay would orphan slots, double-count
admission, and break the in-flight gauge that `streaming-contract.test.ts`
pins.

## 4. Consumer sketches (pseudo-code)

Antigravity (`src/providers/integrations/antigravity/antigravity.ts`,
stream leg ~`:270-377`): freeze the envelope bytes once, then delegate.

```pseudo
// PSEUDO-CODE — inside the stream dispatch leg
const body = JSON.stringify(payload)          // built ONCE from session state
const headers = { ... }                        // Bearer already resolved
const { response, tally, endpoint } = await fetchWithEmptyStreamRecovery(
  [prodUrl, sandboxUrl],                       // prod → sandbox, donor order
  { headers, body },
  { fetch: (url, init) => outboundFetch(url, { method: "POST", ...init }),
    drain: (res, signal) => drainGeminiTally(res, signal),  // decodeSseEvents + responseParts
    signal: lifecycle.signal, deadlineMs: context.deadline,
  },
)
for await (const event of eventsFromTally(...)) yield event   // stream as today
```

Freezing `body` matters: `buildAntigravityEnvelope` mutates session state
(`stepIndex++`, `agentId ??=`, `:808-812`), so re-invoking the builder per
replay would advance the step and change `requestId` — the replay would not be
identical. Serialize once, replay bytes.

Codex (`src/providers/integrations/codex/codex.ts`, SSE leg `~:809-860`),
later SSE-to-replay fallback:

```pseudo
// PSEUDO-CODE — inside the SSE branch after decode
tally = { dataEvents: n, meaningful: processor.hasContent(), thoughtOnly: false }
if (isEmptyStream(tally) && !signal.aborted) {
  const retry = await fetchWithEmptyStreamRecovery(
    [codexResponsesUrl],                        // single endpoint today; WS-first adds a second
    { headers, body: frozenBody },
    { fetch, drain: drainCodexTally, signal, deadlineMs, policy: { maxEmptyReplays: 1 } },
  )
  // continue decoding from retry.response
}
```

Codex needs only `isEmptyStream` + the helper with a one-entry endpoint list;
when WebSocket-first transport lands, the WS leg becomes a second "endpoint"
only if its failure shape (transport error vs empty drain) maps onto
`DrainStream` — otherwise WS stays caller-side and SSE remains the helper leg.

## 5. Test plan

Replay safety check (from reading the dispatch path): all gateway dispatch
POSTs are inference requests — `proxy-request.ts:270-276` sends the canonical
payload with no client-mutating side effects, and non-stream legs
(`:344-379`) throw on failed terminals rather than committing. Replays fire
only pre-first-downstream-yield with byte-identical bodies, so client-visible
state is untouched. Two caveats, not blockers: upstream *metering* may count
each replay (billing, not correctness), and server-executed tools
(`googleSearch` injection at `antigravity.ts:860-866`) may run upstream even
when zero events return — see open question 1.

| # | Case | Proves |
|---|---|---|
| 1 | 200 + zero SSE events → replay fires once with byte-identical headers/body → 200 with content → success, `replaysUsed: 1` | core recovery path |
| 2 | 200 empty → replay → empty again (past `maxEmptyReplays`) → throws `GatewayError` `platform_unavailable`/502/`upstream` | exhaustion contract the attempt loop relies on for candidate failover |
| 3 | First endpoint empty through budget, second endpoint succeeds → result reports second endpoint | prod→sandbox ordering |
| 4 | First-event timer (injected short timeout, no timer mocks in prod code) fires mid-silence → abort → `transport_closed`, no replay started | watchdog precedes failover; asserts with fake `sleep`/signal, not wall-clock |
| 5 | Non-empty first response (meaningful tally) → `fetch` called exactly once | no replay on success; guards metering cost |
| 6 | Thought-only STOP tally → no replay, returns tally as-is | donor `:1033-1037` carve-out |
| 7 | Abort signal fires during replay backoff → rejects with last error, no further fetch | composes with `state.abortController` lifecycle |
| 8 | Non-idempotent guard: request carrying server-executed tools (e.g. `googleSearch`) + empty drain → per policy under test, either replays (accepted billing risk, documented) or skips — assert whichever the decision in §6/Q1 is | pins the safety decision so it cannot silently flip |

All unit-level with injected `fetch`/`drain`/`sleep`; no network, no env mutation.
`resetTimeoutCacheForTests` exists if any case reads resolvers.

## 6. Open questions

1. **Does the upstream meter server-side tool execution on requests that return
   zero events?** `googleSearch`/grounding runs provider-side; an empty stream
   may still have consumed quota or executed search. Settles test 8 and whether
   the helper needs a "no server tools" replay gate. Evidence: replay a
   search-enabled prompt against the sandbox twin and compare quota deltas, or
   read the quota-window counters before/after a forced empty replay.
2. **What exactly is the donor's `streamed.meaningful` predicate?** Used at
   `:1028` to accept a stream, but `streamResponse` was not read — tool deltas,
   citations, usage-only frames, and planning-leak-stripped output may or may
   not count. Settles `StreamTally.meaningful` parity. Evidence: read
   `streamResponse` in the donor (`google-gemini-cli.ts` / `google-shared.ts`).
3. **Can Codex's `CodexStreamFrameProcessor.terminalEvent()` supply a tally
   without a second decode pass?** The helper's `DrainStream` contract assumes
   the caller can tally while decoding; Codex decodes incrementally into
   canonical events (`codex.ts:810-860`), so the tally may need to ride the
   processor rather than re-read the body. Settles whether Codex reuses the
   helper as-is or needs a tally adapter. Evidence: read the processor's event
   accounting and `terminalEvent()` shape.
