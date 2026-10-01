# Payload and tracing

Decode captured telemetry payload frames and trace a gateway request from `request_id` to root cause. Consolidates the payload-forensics, payload-diagnosis, payload-debugging, telemetry-payload-decode, trace-request, and request-failure-trace skills.

## When to use

A request failed or behaved oddly and you need the *actual bytes*: the upstream request body, the upstream response, and what the client received. Payload retention is roughly 15 minutes, so read fast or the frame is gone.

## Locate the frame

Two tables in DB `cartethyia` (`DATABASE_URL` in `.env`):

- `telemetry_events` — one row per request: `request_id`, `provider_id`, `requested_model`, `status` (`completed`/`failed`/`cancelled`), `error_category`, `endpoint`, `source_surface`, `stream`, `latency_ms`, `created_at`. Start here; filter by `requested_model ILIKE` or `error_category`.
- `telemetry_payloads` — keyed by `request_id`. Typed file-reference columns only (`storage`, `file`, `offset`, `length`, `checksum`, `version`) pointing into `data/telemetry-payloads/<file>.jsonb`. Bodies never live in Postgres.

Find a row by request id:

```js
const { Client } = await import("pg");
const c = new Client({ connectionString: "postgres://postgres@localhost:5432/cartethyia" });
await c.connect();
const r = await c.query(
  "SELECT request_id, storage, file, \"offset\", length, checksum, version FROM telemetry_payloads WHERE request_id = $1::uuid",
  ["<request-id>"],
);
```

A payload over ~1 MB is stored as `{ _truncated: true, _original_bytes }`; the real body is in the file frame, so read the frame rather than the column.

Note: `psql` is not on PATH here; use `bun -e` with the `pg` package and `DATABASE_URL` from `.env`.

## Decode a frame — the format is not plain JSON

The `.jsonb` files are an append-only sequence of length-prefixed frames:

```
[4-byte big-endian length][JSON]
```

and the JSON is a frame envelope, not the payload:

```
{ version: 1, id, expiresAt, payload }
```

So read the 4-byte length, slice that many bytes, parse, then take `.payload`. Parsing the whole file and parsing the slice directly both fail. `ref.length` **includes** the 4-byte header.

```js
const { readFileSync } = await import("node:fs");
const buf = readFileSync("data/telemetry-payloads/" + ref.file);
const frame = buf.subarray(ref.offset, ref.offset + ref.length);
const payload = JSON.parse(frame.subarray(4).toString("utf8")).payload;
```

To walk every frame in one file, loop `offset += 4 + len` while `offset + 4 <= buf.length`, bailing when `len <= 0` or the slice overruns.

## What each column means

- `request_body` — what the client sent to the gateway.
- `provider_request_body` — `{ method, url, headers?, body }` actually sent upstream.
- `provider_response_body` — raw upstream response text. SSE frames arrive as one string; split on `\n` and keep the `data: ` lines to replay them.
- `client_response_body` — what the gateway streamed back to the client.
- `response_body` — the non-streaming client response.

Comparing `provider_response_body` against `client_response_body` localizes a translation bug: upstream correct + client copy wrong means the fault is in our parser or encoder, not the provider.

**`provider_request_body` is `{method, url, body}` — the `url` alone identifies the provider path and is the fastest way to confirm which adapter ran.**

## Replaying an SSE stream through a parser

Strip the `data: ` prefixes, re-emit each frame as `data: <json>\n\n`, wrap in a `ReadableStream`, and feed the surface decoder:

```js
const text = raw.split("\n").filter((l) => l.startsWith("data: "))
  .map((l) => l + "\n\n").join("");
const stream = new ReadableStream({
  start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
});
for await (const event of decodeChatSseStream(stream, request)) { /* inspect */ }
```

## Trace a request failure to root cause

Walk one gateway request from its `request_id`:

1. **Locate the record:**
   ```sql
   select * from telemetry_events where request_id = '<id>';
   ```
   Key fields: `status` (`completed|failed|cancelled|truncated`), `error_category`, `error_origin` (`cartethyia|upstream|network`), `ttfb_ms`, `first_content_delta_at_ms` (null ⇒ no content ever reached the client), `latency_ms`, `requested_model`, `provider_id`.

   Payloads: `telemetry_payloads` row → typed file columns → decode frames (see above; ~15 min retention — read immediately). If every body shows `{_truncated, _original_bytes}` the content is unrecoverable; sizes still inform (e.g. 6.7 MB request). Drawer "45B" panels are marker bytes, not payload size.

2. **Interpret the signature:**
   - `completed` → done; not a failure.
   - `cancelled` + `error_origin: cartethyia`: `classifyTerminalCategory(err, signal)` in `failure-policy.ts` reads the abort signal — `transport_closed` = client disconnect ("request was cancelled by client"), `deadline_exceeded` = our own `TimeoutError` timer, and `unknown_error` only survives when no abort is behind the failure. Rows recorded **before 2026-09-22** show `cancelled + unknown_error` for plain client cancels — historical labeling, not a gateway bug.
   - `failed` + category X → the `GatewayError.code` at that site; `origin` separates upstream-rejected from gateway-raised.
   - Dashboard mapping: `Usage.tsx` `statusCode()` (cancelled → "499") and `errorMessageFor()` (category → message).

3. **Eliminate abort sources by timeout signature.** Resolve current values from `src/config.ts` (all env-tunable); defaults:

   | Source | Default | Abort reason it leaves | Telemetry signature |
   |---|---|---|---|
   | State request deadline (`request/state.ts`) | `CARTETHYIA_UPSTREAM_TIMEOUT_MS` 120 s pre-stream; **streams re-arm** to upstream+stall (480 s) | `DOMException TimeoutError` | `cancelled` + `deadline_exceeded` |
   | Stall watchdog (`dispatch/proxy-request.ts`) | first-chunk 200 s before first byte, then stall 360 s, re-armed per upstream read | `GatewayError deadline_exceeded` | `failed` + `deadline_exceeded` |
   | Server idle | `CARTETHYIA_SERVER_IDLE_TIMEOUT` 60 s | connection drop | `cancelled` |
   | Upstream deadline (`operations/upstream-deadline.ts`) | state's original `deadlineMs` | plain `Error("upstream_deadline_exceeded")` on the **fetch** controller only | `failed`, not `cancelled` |
   | Client disconnect | — | `DOMException AbortError` via `request.signal` bridge or `ReadableStream.cancel()` | `cancelled` + `transport_closed` |

   Only one source fits a given record; a stream whose state deadline fires at 120 s means the re-arm at Response commit never happened (first `iterator.next()` never resolved ⇒ pre-200 ⇒ check TTFB).

4. **Watch for the known traps:**
   - `requested_model` vs `provider_id` mismatch (e.g. `claude-opus-5` under `opencodeft`) is a model alias / CLI mapping working as configured. Never a wrong catalog route.
   - `ttfb_ms` counts the first client-visible canonical event; SSE keepalives (15 s) are excluded from TTFB and telemetry.
   - Non-stream vs stream failure paths differ: `dispatch/attempt-loop.ts` vs `emitStreamErrorAndClose` in `proxy-request.ts`; both classify through `classifyTerminalOutcome`.
   - "kadang hit kadang error" with TTFB but no content delta ⇒ upstream opened the stream then stalled; the client times out first and the gateway records a cancel. Confirm with payload forensics if frames still exist.

## Gotchas

- **Frame refs are typed columns now:** read `storage`/`file`/`offset`/`length`/`checksum`/`version` from the row — there is no jsonb `{_payload_ref:{...}}` wrapper to unwrap.
- Frames expire. If the payload is already gone, replay the *shape* instead: rebuild the frame sequence from the transcript and feed it to the parser. That still proves a parser fix even when the original bytes are unavailable.
- Outbound request headers were historically not captured at all; only the allowlisted non-secret set (`x-grok-*`, session ids, `user-agent`) appears under `provider_request_body.headers`. Do not conclude a header was absent just because an older frame omits it.
- Oversized payloads are truncated to `{ _truncated: true, _original_bytes: N }` above ~1 MB; the bytes are not recoverable.
- **`grep` on the raw files gives false positives.** They contain tool output and source excerpts when the session itself routes through the gateway. Filter by `request_id`, not by a substring.
- Running the query inside the JS eval kernel: a local variable named `URL` shadows the global `URL` constructor that `pg` uses internally and breaks `new Client(...)`. Run payload queries via `bun -e` in a subprocess instead.
- `data/` is gitignored — never `git add` it.
