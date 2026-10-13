# OpenCode 2.0.28 cache replay

**Status:** completed, live replay
**Date:** 2026-10-13 (UTC+7)
**Source checkout:** `preview-main`, `50b57c04478d4dbcf255c3ff80f7405794cbd450`

## Summary

Repeated no-credential requests to OpenCode Free returned measurable prompt-cache
reads. For an identical 5,695-token input, the second and third requests reported
5,617 cached tokens. Rotating `x-opencode-session` did not prevent a later request
from reporting the same 5,617 cached tokens.

This demonstrates that the tested OpenCode Free Responses route can serve cache
hits with the manually constructed request shape. It does **not** establish
that the replay matches requests from an OpenCode macOS terminal/CLI client.
The manual replay did not include a persistent client installation ID. A
separate capture below observes the locally installed CLI using a custom
OpenAI-compatible provider, but that binary is 2.0.26 on Windows, not the
macOS 2.0.28 CLI. Keep the manual, custom-provider, and macOS-artifact evidence
distinct.

Two local captures of the installed OpenCode CLI are now included below:
one through a custom OpenAI-compatible provider, and one through the CLI's
built-in `opencode` provider integration pointed at a local mock. Both used
version **2.0.26** on Windows, not the macOS desktop artifact's 2.0.28. Neither
is a request to the actual OpenCode Free service.

## Inspected macOS artifact

- DMG: `C:\Users\Aria\Desktop\opencode-desktop-mac-arm64.dmg`
- App: `OpenCode 2.0.28-arm64`
- Extracted `app.asar`: 176,294,750 bytes
- SHA-256: `1ABBC91EB7EE1BE2B28ADAE02F12999DF908A957D5A5D47ACF5F8C163B8BB2A9`
- Packaged `package.json` reports desktop version `2.0.28`.

The desktop ASAR contains the desktop shell and its UI/server API client. A scan
of its packaged JavaScript and source maps did not find the model-request
fingerprint headers or a model request builder. The inspected ASAR also does not
contain the OpenCode CLI/server package. Therefore, the desktop version is
verified, but the ASAR alone cannot prove the exact headers emitted by the
separately installed CLI. The macOS executable was not run on this Windows host.

## Live replay

Requests were sent directly to the unauthenticated public endpoint:

```text
POST https://opencode.ai/zen/v1/responses
```

The replay used model `muse-spark-1.2-contributor-free`, a synthetic repeated
prompt, streaming Responses input, and the `read` and `bash` function tools
required by the OpenCode Free request contract. No `Authorization` header or
user credentials were sent. The response text and generated identifiers were
not retained.

Request fingerprint used:

```text
user-agent: opencode/2.0.28
x-opencode-client: opencode
x-opencode-session: valid ses_... identifier
x-opencode-request: unique msg_... identifier per request
x-opencode-project: global
```

There was no `prompt_cache_key`; the test measured upstream prefix caching from
the usage returned by the Responses API. The request body and prompt were
identical between the completed replays. One replay group reused a session ID;
the second group generated a new session ID for each request.

**Identity caveat:** these headers were assembled manually. No persistent
client installation ID/client identifier was sent, and no macOS terminal/CLI
request was captured. Treat this as a route/cache smoke test, not a replay of
the actual macOS client fingerprint.

### Completed responses

| Replay | Session behavior | HTTP | Input tokens | Cached tokens | Cached share |
|---|---|---:|---:|---:|---:|
| Stable session 1 | Reused | 200 | 5,695 | 0 | 0% |
| Stable session 2 | Reused | 200 | 5,695 | 5,617 | 98.6% |
| Stable session 3 | Reused | 200 | 5,695 | 5,617 | 98.6% |
| Rotated session 1 | New ID | 200 | 5,695 | 113 | 2.0% |
| Rotated session 2 | New ID | 200 | 5,695 | 5,617 | 98.6% |

Each response completed successfully. The cache-read values came from
`usage.input_tokens_details.cached_tokens`.

Four preliminary requests with `max_output_tokens: 16` returned HTTP 200 but
ended with `response.incomplete` and no usable usage record. They are excluded
from the table. They may still have warmed the upstream cache, so this is a
warm-repeat experiment, not a cold-cache benchmark.

### Same-body `prompt_cache_key` toggle

Two live controls each reused one synthetic prompt and session for four
requests. Within each group, `prompt_cache_key` was the only request-body field
toggled; group A used omitted → present → present → omitted, and group B used
present → omitted → omitted → present. Both used the CLI-style
`x-opencode-client: cli` and user-agent, `store: false`, streaming Responses,
and the same `read`/`bash` tools.

| Replay | `prompt_cache_key` | HTTP | Input tokens | Cached tokens |
|---|---|---:|---:|---:|
| A1 | Omitted | 200 | 3,572 | 0 |
| A2 | Session ID | 200 | 3,572 | 3,569 |
| A3 | Session ID | 200 | 3,572 | 3,569 |
| A4 | Omitted | 200 | 3,572 | 3,569 |
| B1 | Session ID | 200 | 3,572 | 0 |
| B2 | Omitted | 200 | 3,572 | 3,569 |
| B3 | Omitted | 200 | 3,572 | 3,569 |
| B4 | Session ID | 200 | 3,572 | 3,569 |

Both contexts warmed after the first request, and every later request reported
3,569 cached tokens regardless of whether the key was present. For these
controlled prompts, dropping `prompt_cache_key` did **not** explain the warm
cache hit. This does not rule out effects for other cache states or bodies.

## OpenCode CLI custom-provider capture

The installed terminal binary reports **OpenCode v2.0.26**:

```text
C:\Users\Aria\.bun\bin\opencode.exe
```

It was run with `--standalone`, temporary home/data/config directories, a
synthetic prompt, and a local mock Responses endpoint configured as a custom
OpenAI-compatible provider. The configured API key was a dummy value sent only
to localhost; the capture confirmed it was never forwarded. No existing
OpenCode configuration, saved credentials, or user session data was read or
used. The mock returned a valid Responses SSE stream.

This captures requests generated by the actual CLI runtime for that custom
provider. It is **not** a capture from OpenCode's native provider, so
native-provider-specific headers could differ.

The CLI made two streamed `POST /v1/responses` calls: an automatic title
generation request, followed by the actual prompt request. The ordinary prompt
request contained 12 tool definitions. Both bodies had `store: false`,
`stream: true`, `include: ["reasoning.encrypted_content"]`, and a
`prompt_cache_key` equal to the active session ID.

Captured identity headers (session values redacted):

```text
user-agent: opencode/latest/2.0.26/cli
x-opencode-client: cli
x-opencode-project: <stable project hash>
x-opencode-session: <session ID>
x-opencode-session-id: <same session ID>
x-session-affinity: <same session ID>
x-session-id: <same session ID>
traceparent: <per-request trace ID>
b3: <per-request trace ID>
```

No `x-opencode-install-id`, client-install ID, `x-opencode-request`, or other
install/client-ID header appeared in these custom-provider requests. Their
explicit client identifier is `x-opencode-client: cli`; project identity is
represented separately by `x-opencode-project`. Trace IDs change between
requests, while session headers and `prompt_cache_key` stay the same for the
session. This does not establish which headers the CLI's native OpenCode
provider sends.

A no-auth attempt to replay the full captured CLI payload to OpenCode Free
returned `403 FreeTierError` for both the title request and the agent request,
so that run produced no cache-usage evidence. The failure was not isolated to
one request-body field and does not establish that an install ID is required.
A smaller synthetic body using the captured CLI-style user-agent/client
headers, session aliases, and matching `prompt_cache_key` did return HTTP 200;
its two responses reported 113 and 497 cached tokens out of 576 input tokens.
Thus the CLI marker and cache key are not categorically rejected, but the
full-body FreeTierError remains unexplained.

This is an actual CLI custom-provider capture, but it is **not** the native
OpenCode provider or the macOS 2.0.28 CLI: the available DMG contains the
2.0.28 desktop shell, not the CLI/server executable, and the macOS binary
cannot be run on this Windows host. Do not assume this 2.0.26 fingerprint is
identical to the 2.0.28 macOS terminal.

### Built-in OpenCode provider capture against a local mock

A second isolated run used the same OpenCode v2.0.26 executable, but selected
the CLI's built-in `opencode` provider integration, configured with a local
base URL and a synthetic `capture-model`. It used temporary config/home/data
directories and a dummy API key sent only to `127.0.0.1`. The mock returned a
valid Chat Completions SSE stream. The CLI completed one request successfully
without retrying. No OpenCode account, saved credential, upstream request, or
user session data was used.

The captured request was:

```text
POST /zen/v1/chat/completions
user-agent: opencode/latest/2.0.26/cli
x-opencode-client: cli
x-opencode-project: <stable project hash>
x-opencode-session: <session ID>
x-opencode-session-id: <same session ID>
x-session-affinity: <same session ID>
x-session-id: <same session ID>
traceparent: <trace ID>
b3: <same trace ID, with sampling and span fields>
```

The JSON body had `model`, `messages`, `tools`, `stream`, `stream_options`,
and `max_completion_tokens`; `stream` was `true` and the request included 12
tools. It did **not** contain `prompt_cache_key` or `store`. No
`x-opencode-install-id`, `x-opencode-request`, or persistent installation ID
was observed. The API key header was present only on the local mock request.
The CLI accepted Chat Completions SSE carrying `choices[].delta` content,
followed by `choices[].finish_reason: "stop"` and `[DONE]`.

This is evidence for the built-in provider integration's request shape when
using a locally defined generic model. It is not proof of the request shape
used for the actual `muse-spark-1.2-contributor-free` model: model definitions
can select a different wire protocol, and this synthetic model selected Chat
Completions. It also does not prove the macOS 2.0.28 CLI uses identical
headers. The earlier malformed mock response was not valid evidence; this
capture replaces that failed attempt.

### Non-interactive streaming observation

With `opencode run` (not the interactive TUI), a local mock sent two Responses
text deltas about 814 ms apart (at 3,369 ms and 4,183 ms after process start).
The process wrote its answer to captured stdout at 5,071 ms, after the final
event. This local non-interactive CLI/piped-stdout observation is not a
measurement of the TUI's rendering or a terminal-vs-gateway latency
comparison.

## Gateway parity and streaming

The custom-provider Responses capture supplied a stable `prompt_cache_key`
equal to its session ID. The built-in provider's synthetic Chat Completions
capture had no such field. Before the parity change recorded below, the gateway
disabled OpenAI prompt-cache controls for OpenCode, so it omitted a caller's
`prompt_cache_key`. That difference is now corrected: the adapter allows
caller-provided cache keys on wire families that support them. The controlled
live toggle above got the same warm-prefix cache read with the key present or
omitted, so the earlier omission was not established as the cache-miss cause.

The gateway's OpenCode fingerprint has been aligned with the observed CLI
identity: `x-opencode-client: cli`, `user-agent: opencode/latest/<version>/cli`,
four equal session headers, and matching W3C/B3 trace IDs. It no longer adds
`x-opencode-request`. When the inbound OpenCode client supplies
`x-opencode-project`, the gateway forwards that project hash. If absent, it
retains the existing `global` fallback because the gateway has no client
working-directory identity from which to reproduce the CLI's project hash.
For an affinity that is not already a valid `ses_...` ID, the gateway derives a
stable valid session ID, so repeated requests in the same conversation reuse
the four aliases rather than minting a new session per dispatch.

The adapter now allows cache-key controls through its wire encoders instead of
disabling prompt caching. It preserves a caller-provided `prompt_cache_key` on
wire families that carry it; it does not invent one on the synthetic native
Chat Completions request, which had no cache key. This matches the two distinct
captured body shapes rather than forcing the Responses-only field onto Chat
Completions. For Chat Completions, the gateway also emits the captured
`max_completion_tokens` field instead of `max_tokens`, and retains
`stream_options.include_usage`.

This is closer to the observed CLI fingerprint, not byte-for-byte proof of the
actual `muse-spark-1.2-contributor-free` or macOS 2.0.28 request. The local
native-provider capture used a synthetic Chat Completions model, while the
custom-provider capture used Responses. The gateway still translates a
canonical request, so model-specific body details (tool ordering, system
prompt, and optional fields) may differ. No live cache replay or latency
benchmark was run after the alignment.

The CLI `--format json` capture consumed a streamed Responses reply, but emitted
its answer as one JSON text event. This CLI mode is not the interactive TUI, so
it is not evidence that the terminal buffers tokens. It does establish the
requested wire surface: incremental Responses SSE with `response.*` events.

In the gateway source, the Responses encoder enqueues each canonical event as
soon as it is encoded; the dispatch stream is pull-driven, has no configured
token-batching delay, and sets `x-accel-buffering: no` and
`cache-control: no-cache, no-transform`. That rules out an intentional
post-encoding buffer in this path, but not time spent in routing, upstream
time-to-first-token, decoding/translation, deployment intermediaries, or client
rendering. A terminal-vs-gateway comparison needs timestamps at request start,
upstream first byte, first content delta, and first client-visible byte, plus
inter-delta gaps.

## Interpretation and limits

1. **Cache hits are reproducible on the no-auth Free route.** The completed
   repeated requests reported 5,617 cached tokens out of 5,695 input tokens.
2. **The captured v2.0.26 custom-provider Responses request pins
   `prompt_cache_key` to its session ID.** The gateway now preserves caller
   cache keys on supported OpenAI-compatible wire families. Controlled live
   toggles achieved identical warm cache reads with the field present or
   omitted; its earlier omission was not demonstrated as the cache-hit cause.
3. **A new session ID did not prevent a warm cache hit with the earlier
   manually assembled headers.** This does not establish cache behavior for
   the macOS 2.0.28 terminal fingerprint.
4. **Neither v2.0.26 local capture sent `x-opencode-request` or an install ID
   header.** The built-in provider capture also had no `prompt_cache_key`, but
   used a synthetic Chat Completions model. This does not prove the actual
   OpenCode Free model or macOS 2.0.28 terminal omits these fields; do not add
   an install ID or change cache policy based on assumption.
5. **The experiment does not isolate all possible causes of the original
   regression.** Body changes, tool ordering, model routing, backend cache
   state, and the exact CLI-generated request remain separate variables.
6. **No paid route was tested.** The request used the public OpenCode Free tier
   and no credentials.

## Relevant gateway implementation

- [`provider.ts`](../../src/providers/integrations/opencode/provider.ts) marks the OpenCode
  adapter behavior, including Free-tier request preparation and cache-key
  forwarding.
- [`fingerprint.ts`](../../src/providers/integrations/opencode/fingerprint.ts)
  builds the observed CLI client, session, project, user-agent, and trace headers.
- [`opencode-fingerprint.test.ts`](../../test/providers/opencode-fingerprint.test.ts)
  asserts CLI identity shape, stable session aliases, project forwarding, and
  per-request trace identity.

Next, capture a request using the actual `muse-spark-1.2-contributor-free`
model (ideally from macOS 2.0.28) before treating the synthetic-model Chat
Completions shape as representative. Separately, isolate the unexplained
`403 FreeTierError` from the full custom-provider body by varying one part at
a time; the minimal cache-key test cannot stand in for the full tool/system
payload. For streaming, compare first-byte/first-delta timestamps and
inter-delta gaps through direct and gateway paths using the same model,
session, and prompt.
