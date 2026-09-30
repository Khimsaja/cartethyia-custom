# Protocol

`src/protocol/` is the canonical↔wire translation boundary: codecs that encode
a `CanonicalRequest` into a provider's wire payload and decode wire responses
(JSON or SSE) back into `CanonicalEvent`s. The canonical model itself
(`WireFamily`, `CanonicalRequest`, `CanonicalEvent`) lives in
`src/transport/canonical-model.ts`, and the typed gateway failures
(`GatewayError`, its stable codes, the public-detail sanitizers) live in
`src/transport/gateway-error.ts` — protocol depends on both, never duplicates
either. SSE framing lives in `src/transport/streaming.ts`; retry classification in
`src/transport/failure-policy.ts`. Provider identity, adapters, and dispatch
context live in `src/providers/`; client-facing surface parsing lives in
`src/transport/surface/`.

Placement is enforced by `test/architecture/protocol-naming.test.ts`: the
canonical `src/protocol/{request,response,transport}` directories must exist,
old provider-local protocol paths must not, and no source file may import a
removed protocol path.

## Layout

```text
src/protocol/
  PROTOCOL.md             this file
  registry.ts             dispatcher: encodeWireRequest / decodeWireResponse / decodeWireStream + CodecContext
  primitives.ts           shared guards, UTF-16 coercion, tool-id normalization, Codex ids/effort,
                          Harmony escaping, endpoint/header/auth helpers, image-source resolution
  messages-errors.ts      Claude HTTP + SSE errors using the shared structured classifier
  stream-error-frames.ts  in-stream error frame → typed GatewayError, shared by chat/responses/codex
  request/chat.ts         canonical → OpenAI Chat payload
  request/responses.ts    canonical → OpenAI Responses payload
  request/messages.ts     canonical → Anthropic Messages payload
  request/codex.ts        canonical → Codex Responses payload (direct entry, not via registry)
  request/gemini.ts       canonical → Gemini payload (direct entry)
  response/chat.ts        Chat JSON/SSE → canonical events
  response/responses.ts   Responses JSON/SSE → canonical events
  response/messages.ts    Claude JSON/SSE → canonical events
  response/codex.ts       Codex frames → canonical events (stateful frame processor)
  response/gemini.ts      Gemini helpers (candidate/parts/usage/stop-reason/stream-event)
  transport/openai.ts     shared upstream JSON POST executor (deadline/abort lifecycle)
  transport/messages.ts   shared Claude request sender (status-first errors, SSE vs JSON branch)
```

## Registry (dispatcher)

`registry.ts` is the only entry point generic adapters use
(`providers/compatible-adapter.ts`: `preparePayload` → `encodeWireRequest`,
`transformStream` → `decodeWireStream` / `decodeWireResponse`):

- `encodeWireRequest(wireFamily, request, CodecContext)` → chat / responses /
  messages builders. Throws on any value outside those three.
- `decodeWireResponse(wireFamily, json, request, context)` → per-family
  JSON parsers.
- `decodeWireStream(wireFamily, body, request, context)` → per-family SSE
  decoders.
- `CodecContext`: `isOAuth`, `sessionId`, `supportsPromptCaching`, `signal`.

Codex and Gemini do **not** go through the registry; they expose dedicated
builders/parsers called directly by their adapters
(`integrations/codex/codex.ts`, `integrations/gemini.ts`,
`integrations/antigravity/antigravity.ts`).

## Request codecs (canonical → wire)

- `request/chat.ts` — `canonicalToChatPayload(request,
  supportsPromptCaching)`: `normalizeWireMaxTokens` fills `max_tokens` from
  `max_output_tokens`, and `extension:responses.*` controls fall back to their
  unprefixed `extension:*` spelling, so a Responses-authored request keeps its
  ceiling and its passthrough fields when it is served on the chat wire;
  system/instructions → `system`/`developer` messages;
  assistant tool calls → `tool_calls`; Messages-ledger tool results → `role:
  "tool"` with `[tool_error]` prefix; rich content → multipart (`image_url`,
  `input_audio` with MIME→`wav`/`mp3` map, `file`, document→`file`);
  `reasoning_content` side channel; prompt-cache breakpoints; tools /
  `tool_choice` (incl. `custom`, `allowed_tools`); `response_format` envelope;
  top-level `reasoning_effort`; `stream_options`, `modalities`, `audio`,
  `metadata`, `user`, plus `extension:*` passthrough.
- `request/responses.ts` — `canonicalToResponsesPayload` +
  `markLatestResponsesCacheBreakpoint`: `extension:responses.*` names the
  canonical spelling and falls back to the bare `extension:*` one, and `verbosity`
  resolves through the shared `resolveOutputVerbosity` (`protocol/primitives.ts`),
  so the same intent arriving from any surface
  reaches `text.verbosity`; system/instructions → message items;
  tool calls/results → `function_call` / `function_call_output` (never
  swallowed into bare messages); `computer_call` / `computer_call_output` with
  `pending_safety_checks` restored from `extension:responses.item_metadata`;
  encrypted reasoning replay; `previous_response_id` / `conversation` /
  `metadata`; `reasoning{effort,mode,context,summary}`; `text{verbosity,format}`;
  `extension:responses.*` passthrough.
- `request/messages.ts` — `canonicalToClaudeMessagesPayload(request,
  { isOAuth })`: system/developer hoisting to top-level `system`; `tool` role
  → `user`; adjacent assistant turns merged into one (a `reasoning`+`toolCall`
  turn followed by the `text` turn that produced the same reply would otherwise
  wedge a `tool_use` from its `tool_result`, which Anthropic rejects as an
  assistant-prefill); stable-partition trailing `tool_use`; sampling-param strip when
  thinking is enabled; `stop_sequences` cap 4; `thinking{type,budget_tokens,
  display,block_binding}` + default `context_management`;
  `output_config{effort,task_budget}`; `container`, `inference_geo`,
  `service_tier` (only `auto` and `standard_only` are forwarded — any other tier
  is logged as a warning rather than rejected or silently discarded),
  `extension:metadata_user_id` merged into top-level `metadata.user_id`,
  OAuth tool-name prefixing. Rich content is re-encoded per
  part (`image` → `source`, `file`/`document` → `document.source`); an `audio`
  part degrades to a `[audio]` text placeholder because this schema defines no
  audio block — see `AUDIO_CAPABLE_WIRE_FAMILIES`, which keeps such a request
  off this wire in the first place.
- `request/codex.ts` — `canonicalToCodexResponsesPayload(request,
  { responsesLite, concurrentReasoningSummaries })` +
  `applyCodexResponsesLiteShape`: owns orphan tool-exchange repair (synthesize
  placeholder result / fold orphan result to a user note), `__`-composite tool
  ids, encrypted/summary reasoning items, Harmony escaping gated on
  `gpt-oss`/`gpt-5`, `reasoning{effort,summary,mode,context}` + forced
  `include: ["reasoning.encrypted_content"]` when reasoning is present,
  `text{verbosity,format}` (this wire has no top-level `response_format`, and
  the format is nested beside verbosity — a flat one is a 400),
  `prompt_cache_key` derived from the caller's `cache_hint`, forced
  `stream:true, store:false`. The Codex adapter then overwrites that key with
  the session id (`request.session_id ?? resolvePromptCacheKey(request, context)`), and
  `resolvePromptCacheKey` unifies chat, responses, and messages caller
  keys, then inbound session headers, into one affinity so switching wires does not miss the upstream cache.
  Client IP is never part of it. Lite shape strips image `detail`, sets
  `parallel_tool_calls:false`, hoists `tools` → leading `additional_tools`
  developer item, downgrades hosted `tool_choice`.
- `request/gemini.ts` — `buildGeminiPayload` + `geminiModelUrl`: `contents`
  (assistant→`model`, tool→`user`), `systemInstruction`,
  `functionDeclarations` with Gemini schema sanitizer (`const`→`enum`,
  `type:null`→`nullable`, prune unknown `required`, empty-array `items`),
  `generationConfig{maxOutputTokens, thinkingConfig}` with thinking output
  floors. Media parts are projected through the shared `resolveImageSource` /
  `splitDataUrl` primitives (`protocol/primitives.ts`): inline bytes →
  `inlineData{Blob}`, a reference → `fileData{FileData}`. `FileData.mimeType`
  is optional and is omitted when the origin declared none — a fabricated
  `image/png` on a remote JPEG is a wire lie the upstream cannot detect. An
  image carrying only a Files API `file_id` has no Gemini equivalent (the id
  belongs to the originating provider's store), so it degrades to a text
  reference naming the id rather than a `fileUri` the upstream cannot resolve.
  A `toolResult` part becomes a `functionResponse` whose `response` is always a
  JSON object: string content is parsed, and array content is carried as
  `{ content: "<json text>" }` — `functionResponse.response` does not accept an
  array, so parsing a just-stringified array back into a value produced a
  non-record the upstream rejected.

## Response codecs (wire → canonical events)

Shared conventions: per-family stop-reason mappers, split-usage merge
(keep latest totals, keep max `cached_tokens` for the xAI split-usage pattern,
tolerate `usage:null`), tool-identity resolution with orphan fallbacks,
duplicate suppression via the tool-emit ledger (chat/responses) and
per-index/per-item identity maps (messages/codex), empty-delta suppression,
and a hard rule — a stream with **no terminal envelope fails** (`failed`),
never bills as success.

- `response/chat.ts`: per-index tool-id/name memory, `reasoning_content` →
  reasoning parts, audio → `extension:audio`, `[DONE]` terminal, missing
  `finish_reason` → `failed`.
- `response/responses.ts`: `output_text`, reasoning (summary +
  `encrypted_content`), `function_call`, `computer_call` /
  `computer_call_output`, unknown item/event types → `extension:responses:*`;
  argument-delta identity by `item_id` → `output_index` → last-seen → orphan
  id; the terminal lifecycle frames it names (`created` / `in_progress` /
  `completed` / `incomplete` / `failed`) drive status/usage only — every other
  event type, including lifecycle frames it does not name, becomes
  `extension:responses:*` content.
- `response/messages.ts`: `message_start` + `message_delta` usage merged so
  cache accounting survives; `redacted_thinking` → opaque reasoning;
  `server_tool_use` / `search_result` → extension; `error` frames →
  `mapClaudeStreamError`; requires `message_stop`, else 502.
- `response/codex.ts`: stateful `CodexStreamFrameProcessor` + `terminalEvent()`;
  `in_progress`/`queued` → `stop`, `completed` + tools → `tool_use`,
  `incomplete` + tools → `tool_use`, `failed`/`cancelled` → `error`/`aborted`;
  whitespace-loop guard → `tool_call_loop_detected`. Reasoning deltas
  (`response.reasoning_summary_text.delta` and
  `response.reasoning_text.delta`) emit a `content_delta` carrying `summary`
  **and** `summary_index` — read from the frame's `summary_index` when it is an
  integer, else `0` — so multi-index summaries stay distinguishable through the
  canonical part and the Responses encoder can rebuild each part separately.
  When a surface flattens separate summary parts into one visible reasoning
  string (Chat) or independently rendered blocks/items (Messages/Responses),
  it preserves token fragments within a part and inserts a blank-line boundary
  between distinct parts/items, including source items whose indices restart at
  zero.
- `messages-errors.ts`: `mapClaudeHttpError` and `mapClaudeStreamError` use one structured classifier,
  preserving the raw upstream status and provider identifier for account-health decisions.
- `stream-error-frames.ts`: `gatewayErrorFromStreamError` classifies explicit error envelopes inside
  `200 OK` bodies, shared by chat/responses/codex. Exact identifiers distinguish quota, capacity,
  authentication, policy (`11140`), and server failures; a numeric status is the fallback. Unknown
  upstream failures remain `platform_unavailable`, never `invalid_request`. Frame discriminators such
  as `type: "error"` are ignored as identifiers, and message prose is never classified.

## Shared primitives

`primitives.ts` is the single home for cross-codec helpers: wire guards
(`object`, `stringValue`, `finiteNumber`, `readString`/`readNumber`/
`readBoolean`), UTF-16 well-formedness, Anthropic tool-id normalization
(composite `|` split, invalid-char → `_`, 64-char cap with hash suffix,
`_dupN` dedup), `sanitizeSchemaForAnthropic` (allowlisted schema keys),
OAuth tool prefixing (`CLAUDE_TOOL_PREFIX = "_"`), billing-attestation drop,
Codex ids/effort/session state, `resolveOutputVerbosity` (the surface-agnostic
verbosity reader: `extension:responses.verbosity` → `extension:verbosity` →
the canonical slot, because no surface parser writes the canonical one),
Harmony escaping (gpt-5/gpt-oss only),
`joinUrl`/`endpointUrl` (OAuth `?beta=true`), `BUILTIN_DEFAULT_ENDPOINTS`,
`normalizeBearerToken`, `filterProviderCustomHeaders` (RFC-token name, 4 KiB
value cap, control-char reject, protected-name reject — protection list
imported from `src/security/outbound-headers.ts`), `resolveImageSource` (Chat /
Responses / Anthropic origin shapes — read by every builder that puts an image
on a wire where `image_url` must be a **string**, including the Codex and
Responses computer-screenshot renderers; forwarding the canonical payload
verbatim put an object on the wire and the provider rejected the request with
"expected an image URL, but got an object instead"), `splitDataUrl` (the single
RFC 2397 split, so no builder forwards a `data:` URI as a URI the upstream
cannot fetch), hash/JSON helpers.

## Upstream executors

- `transport/openai.ts` — `postUpstreamJson()`: POST with the
  deadline/abort lifecycle from `providers/operations/upstream-deadline.ts`;
  abort → `transport_closed` 499. Used by `CompatibleAdapter.executeTransport`.
- `transport/messages.ts` — `sendClaudeMessagesRequest()`: status-first error
  mapping, SSE vs JSON branch. Shared by the Claude and Anthropic adapters.

## How to extend

- **New wire family**: add request encoder + response decoder + registry case
  + stop-reason map + tests; `provider_stop_reason` stays diagnostics-only and
  must never leak across families.
- **New Codex/Gemini behavior**: extend the direct builders/parsers, not the
  registry — those families intentionally bypass it.
- **New shared helper**: put it in `primitives.ts` when two or more codecs
  need it; keep provider-identity-dependent helpers (e.g. Codex identity
  headers) with their provider.

## Surface × wire conformance

### Client surface is not provider wire

`SurfaceAdapterRegistry` selects the client's protocol from the explicit marker,
request path, or unambiguous body shape. After canonical parsing, `RouteCandidate.wire_family`
selects the provider codec. A Chat client can therefore route to a Responses provider, and vice
versa, only through the documented canonical conversions below; matching path names does not make
the payloads or stream envelopes interchangeable.

| Client surface | Public route and native contract | Current codec boundary |
|---|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions`; `messages` request; streamed choices/deltas and optional final usage chunk | `surface/chat` → canonical → `protocol/request/chat.ts` and `protocol/response/chat.ts`; OpenAI documents model-dependent text/image/audio and PDF-file support. |
| OpenAI Responses | `POST /v1/responses`; `input` items and typed `response.*` SSE lifecycle | `surface/responses` → canonical → `protocol/request/responses.ts` and `protocol/response/responses.ts`; summary reasoning is a requested summary, not raw reasoning. |
| Anthropic Messages | `POST /v1/messages`; top-level `system`, user/assistant turns, typed content blocks, required `max_tokens` | `surface/messages` → canonical → `protocol/request/messages.ts` and `protocol/response/messages.ts`; image/document/thinking/tool blocks are wire-specific. |
| Legacy Completions | `POST /v1/completions`; prompt/legacy completion envelope | `surface/completion` maps the prompt to canonical input and encodes legacy completion output; keep its text contract distinct from Chat. |

The canonical content union currently includes text, image, file, document, audio, refusal,
reasoning, tool-call/result, and opaque extension parts. It has **no video content type** and no
generic typed image-generation result. `RouteCapabilities` tracks image/document/audio, while audio
is denied to Messages because that wire has no audio block. Chat's OpenAI file part is PDF-only in
the upstream contract; Responses accepts a broader file set. Audio support is model- and endpoint-
specific: OpenAI's current audio-chat guide directs bounded audio input/output to Chat Completions,
so do not infer that every Responses model accepts it from the gateway parser accepting
`input_audio`. Unsupported modality data must be explicitly re-encoded, capability-degraded under
the declared policy, or rejected; it must not disappear silently.

Input and output are separate contracts. Chat audio output currently travels as a wire-specific
`audio` extension, not a canonical audio-generation result; generated-image calls and video frames
also have no common typed output/content part. Conformance work must cover output items and
stream events as well as input attachments, and only add a canonical type when at least two supported
surfaces/adapters need the same semantics.

### Reasoning visibility and replay

OpenAI reasoning tokens/private chain-of-thought are not a client-visible API contract. Responses
can return an optional reasoning summary and opaque encrypted reasoning state for supported
stateless replay; preserve encrypted state without decoding it. Chat's `reasoning_effort` and
provider `reasoning_content` side channel are separate from Responses `reasoning` items. Anthropic
Messages thinking blocks/signatures are likewise wire-native replay state. Cross-surface adapters
must preserve only what the source API actually returned and what the destination contract can
represent; never invent a reasoning summary.

The current Responses decoder handles `response.reasoning_summary_text.delta` and the Responses
surface encoder emits the summary-part lifecycle, carrying `summary_index` end to end. The earlier
missing-reasoning symptom was never reproduced; there is no confirmed defect to fix. If it recurs,
capture the request id, the upstream event sequence, and what the client rendered before assigning
a cause — see "Unified API hardening: current state" in `TRANSPORT.md`.

Which of the two shapes a provider sends is the provider's choice, not a gateway decision. Some
upstreams stream readable thinking (`reasoning_content` / `response.reasoning_text.delta`) and
others only a short summary heading plus opaque state; the ChatGPT Codex backend is in the second
group and no request-side field changes that. Per-provider measurements, the levers that were
tried, and the replay finding are in "Known limitations: reasoning visibility" in
`src/providers/PROVIDERS.md` — read it before treating a thin reasoning trace as a decoder bug.

### Token counting and compaction are protocol-specific

- OpenAI Responses exposes `POST /v1/responses/input_tokens`; it counts the Responses request input,
  including provider-side structure and multimodal items accepted by the endpoint, not just visible
  text. The reviewed sources establish no equivalent exact Chat Completions count endpoint.
- Anthropic exposes `POST /v1/messages/count_tokens`; it counts a Messages-shaped input, including
  tools, images, and documents, without generating a reply.
- The gateway's `estimateInputTokens()` currently counts text parts in `request.messages` only,
  using `ceil(characters / 4)` with a minimum of 1. It omits system/instructions, tools, and
  non-text parts, so it is an admission/accounting estimate, not an exact token-count API.
- Responses `context_management` is already preserved through the normal Responses parser/encoder,
  subject to upstream/model support. The standalone compact route at `/v1/responses/compact` is
  still the native Codex opaque-body transport. Generic OpenAI compact dispatch must keep the
  complete upstream compacted output intact for the next Responses request.
- Anthropic `context_management` is carried as a Messages extension and forwarded when the caller
  supplies it (alongside the existing thinking-request default). The separate on-demand `compaction`
  field, the returned compaction block, and `stop_reason: "compaction"` are **not** implemented:
  unknown Messages response blocks remain `messages:*` extensions. Treat generic compaction as a
  feature to build, not a contract the gateway already honors.

### Primary-source references

- OpenAI: [Chat Completions](https://developers.openai.com/api/reference/resources/chat),
  [Responses create](https://developers.openai.com/api/reference/resources/responses/methods/create),
  [streaming](https://developers.openai.com/api/docs/guides/streaming-responses),
  [reasoning](https://developers.openai.com/api/docs/guides/reasoning),
  [input token counting](https://developers.openai.com/api/docs/guides/token-counting),
  [input-token endpoint](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count),
  [compaction guide](https://developers.openai.com/api/docs/guides/compaction),
  [compact endpoint](https://developers.openai.com/api/reference/resources/responses/methods/compact),
  [image inputs](https://developers.openai.com/api/docs/guides/images-vision),
  [file inputs](https://developers.openai.com/api/docs/guides/file-inputs),
  [audio in Chat Completions](https://developers.openai.com/api/docs/guides/audio-chat-completions).
- Anthropic: [Messages](https://platform.claude.com/docs/en/api/messages),
  [count tokens](https://platform.claude.com/docs/en/api/messages/count_tokens),
  [vision](https://platform.claude.com/docs/en/build-with-claude/vision),
  [PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support),
  [threshold compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold),
  [on-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand).

These upstream contracts were checked on 2026-09-26. Model-specific support and beta availability
can differ; re-check the selected model's current reference when implementing a task.
