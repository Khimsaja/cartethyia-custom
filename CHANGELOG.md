# Changelog

## Unreleased

> All changes below are pre-release. Cartethyia has not been tagged or
> released; this document reflects the current production codebase architecture and capabilities.

### Each proxy pool reports the bandwidth it has carried

The proxy table's **Load** cell now carries a second bar: bytes carried against
the pool's own quota, so a metered proxy plan can be watched from the same row
as its concurrency. The quota is per pool (`quota_bytes`,
`0021_network_pool_quota_bytes.sql`, folded into the baseline), entered in GB in
the pool form and stored in bytes so the bar compares without a lossy round
trip; blank means unmetered and the bar then shows a running total only. It
turns orange at 80% and red once the allowance is passed. Each pool keeps its
own figure — there is no shared or relative allowance.

The measurement is taken at the **raw socket**, before TLS wraps it
(`network/pool/byte-accounting.ts`). That choice was forced by measurement, not
taste: a TLS-wrapped socket's `bytesWritten` stays at zero, and the TLS socket's
own counters report decrypted plaintext — a ground-truth run against a
byte-counting proxy showed them at about a sixth of the true wire volume. The
raw socket therefore sees the TLS handshake and record overhead, which is what a
proxy provider actually bills. The cost is one integer addition per TCP chunk
(16-64 KiB), not per byte, so the per-request overhead the operator asked to
avoid is not there.

Two limits are worth stating plainly. Totals are **in-memory and reset on
process restart** — the tooltip says "since this process started" rather than
implying a billing period, and nothing is flushed to the database. And the
figure covers the tunneled connection: for SOCKS5 the negotiation handshake is
not counted, only the tunnel that follows.

### A share link shows the family's quota and activity

The share page gains two things a recipient could not see before. The hero now
carries the **family quota** — lifetime, daily, and monthly, each a bar against
the limit the gateway enforces, or a running total when no limit is set, plus
RPM / concurrent and how many recipients are active. Below the credentials, a
collapsed **Stats & activity** section opens onto request/token KPIs, a
24-hour activity strip, top models, and top client IPs.

The figures are **family totals**, not the caller's own: the allowance is
shared, so a per-recipient number would understate what the link has spent.
They come from a new public `GET /share/:token/stats`, authorized by the same
bearer token that opens the page. Client IPs leave **masked** and there is no
setting to unmask them — this payload is rendered outside the tenant, so the
console's privacy preference does not apply to it.

### The proxy page summarizes pool health instead of asking you to pick a strategy

The proxy page's four summary cards are now **Enabled pool**, **Route capacity**,
**Latency**, and **Cooldown**. *Enabled pool* splits the enabled count from the
tenant total; *Route capacity* keeps the inflight/available split; *Cooldown*
shows the nearest wait rather than a bare count. *Latency* replaces the previous
*Routable now* card, whose "no pool enabled" detail said nothing the count had
not already said: it averages the last-known latency of the **active** pools
(disabled pools are excluded, and pools that have never succeeded are left out
rather than averaged in as zero) and says how many pools that average covers.
Until something has been measured it reads `—` / "no measurement yet" rather
than a confident `0ms`.

The pool table drops its **Type**, **Status**, and **Latency** columns. The
health verdict moved under the pool name, where it costs no horizontal space,
and now carries the measurement with it (`Connected · 62ms`), so latency is read
where the pool's state already is. Its **Address** column holds the pool's public
egress address, captured by dialing Cloudflare's trace endpoint *through* the
pool, so it reports where traffic actually leaves rather than the local DNS
answer for the hostname (which says nothing about the tunnel). It reads "not
probed" until the pool has been tested; the address is stored on the pool
(`0020_network_pool_egress_ip.sql`, and folded into `0000_baseline.sql` so a
database created today has it) so it survives reloads.

The pool table's header row is pinned: the table scrolls inside its own box and
only the rows move. This needed the table's own container to be the scroller —
`overflow` on the wrapper made the wrapper the nearest scrollport, which trapped
the sticky header and let it scroll away with the rows.

Long lists across the console (the pool table, the usage breakdown, the API key
list on the overview) now scroll the same way the sidebar rail does: a contained
region with a thin overlay scrollbar, so the surrounding card headers and page
chrome stay put while only the content moves. The main column uses that same
scrollbar style, so scrolling looks identical wherever it happens.

Every column except the selection box and **Actions** is sortable, toggling
ascending/descending on repeat clicks. Pools with no address yet, or none
probed, sort last in both directions rather than leading a descending sort —
"unknown" is not the same as "smallest". The row actions (**Activity**, **Test**,
**Edit**, **Delete**, plus **Clear** when a provider is cooling) are icon +
label pills that collapse back to square icons when the row is too narrow to
hold the text, so the wider layout degrades instead of overflowing. The
enable/disable switch sits at the far right of the row, set slightly apart from
the destructive **Delete** button rather than buried among the actions.

The **Pool Selection** card and its strategy control are removed — pool selection
is automatic admission, so the setting was inert from the operator's point of
view — and the standalone **Add pool** dialog is gone in favour of the bulk
**Add proxies** form. That form gains a **Test proxies** button: it probes every
pasted endpoint in one request (`POST /network/pools/test-batch`, capped at 100
targets and 10 concurrent dials) and prints per-endpoint verdicts into a
fixed-height scrollable log, so a batch of dead proxies is obvious before
anything is saved. The server never persists batch probes.

### Reorderable lists carry a stable index instead of sorting by creation time

The API credentials, model combos, and model aliases lists each gained an
explicit `sort_index` (`0019_list_sort_index.sql`, backfilled from creation
order). They previously ordered by `created_at`, which is not stable: rows
sharing a millisecond — or any row touched by an `UPDATE` — could swap places
between loads, so the list appeared to jump around. New rows append to the end
rather than displacing the rest.

Each row now shows a drag handle and its 1-based position, and can be dragged to
a new place; the order is saved as a whole (`POST /api-keys/reorder`,
`/routing/aliases/reorder`, `/routing/combos/reorder`), which rejects a partial
or duplicated list rather than silently renumbering rows. The position is
presentation only and is never sent to the client. The combo rows' redundant
`fallback`/`round-robin` badge is removed — the strategy dropdown beside it
already shows that value.

### Claude config downloads emit the fixed team template; the popup type is now a toggle

Generated Claude Code configs are the team's fixed template — bypass
permissions, the two LSP plugins, effort and compaction settings — with only
`env` (the selected endpoint and the **decrypted** secret of the selected key)
and `model` derived per request, so a downloaded `settings.json` needs no manual
editing. The dashboard now sends the wire field `models` the route actually
requires (it had been sending `modelIds`, which Elysia rejected with
`invalid_request: must have required properties models` before the handler ran),
fixing the download.

The share-page popup's `donation`/`information` type selector is gone: a single
**Enable popup** toggle turns one popup on or off, and the whole editor is
collapsed until it is on. The popup editor is now image-left, fields-right. The
share eyebrow text is dropped.

Remote Routing is now settable from two places — the CLI tool page and the API
key's edit form — both writing the one per-(tenant, tool, key)
`cli_tool_settings.mappings_enabled` flag and applying immediately, with no
separate save. It is opt-in: an absent settings row means off, so a fresh key
never inherits stale routes, and the transport snapshot now gates mappings on
that flag instead of ignoring it. A **Reset** control clears every route and
turns the flag off in one action; toggling the switch off keeps the saved routes
so flipping it back on restores them. The `routing:cli_mapping` scope is no
longer a separate grant row — it is folded into the Remote routing switch, which
grants the scope and enables the routes together so the two can never disagree.
The blocked-client-routers copy now notes that the same fingerprint match may
also block bazaar probe links. The popup's optional action button (label + URL)
is removed entirely — the popup is image, title, and message, with a Close
button; `0018_api_key_share_popup_drop_action.sql` drops its columns. The CLI tool page's "Enable bypass permissions
(YOLO mode)" card is removed, since the generated template already sets
`permissions.defaultMode`.

### Shared-key issuance requires a recipient name; Claude mappings support share profiles

The public enrollment endpoint now rejects missing or blank `nameHint` values before it creates a child key. The Claude CLI tool's single **Apikey Name** picker lists personal keys and share templates: a personal key supplies the credential written into the CLI config, while a share template owns the remote model mappings its child keys inherit at request time. Existing `routing:cli_mapping` scope and Claude User-Agent checks remain required.

### Payload capture is typed on disk and gains a metadata-only mode

`telemetry_payloads` no longer has a jsonb body column. Captured content lives
only in on-disk `.jsonb` frames; the Postgres row stores typed reference
columns (`storage`, `file`, `offset`, `length`, `checksum`, `version`). Existing
index rows are truncated on upgrade (`0014_telemetry_payload_typed_ref.sql`);
frame files are left for TTL prune.

Settings → Privacy now has three payload modes: `metadata` (default;
Proxy→Provider method + allowlisted headers only), `bounded` (full redacted
bodies), and `none` (drawer capture off). Both capture modes still prune after
the 15-minute payload TTL.
### Public share pages support owner-configured donation and information popups

API-key create/edit can configure a popup mode, an uploaded image, title, message, and optional HTTPS/mailto action. The image is uploaded and stored with the key (`bytea` + mime) and served from the gateway, so the share page never hotlinks a third-party host; the original `share_popup_image_url` column is dropped by `0016_api_key_share_popup_image.sql`. Public enrollment and handoff pages show a button under Base URL; the responsive dialog opens only on visitor action. The new nullable key fields are added to fresh installs and upgraded by `0015_api_key_share_popup.sql`. The create/edit modal itself is now a compact two-column form (`.api-key-form-columns`) whose columns balance the cards and collapse to one column under 720px, instead of one tall scrolling stack.

### Reasoning effort is recorded on every surface, and the Usage table names a provider

The Messages surface read effort only from Anthropic's own `thinking` and
`output_config` fields, so an OpenAI-shaped caller stating a top-level
`reasoning_effort` had it dropped and the request ran at the model default. Chat,
Responses, and Completion already honored that field. Messages now reads it through
the same shared parser, with Anthropic's spelling still winning when both are
present, so all four surfaces record the requested effort and the Usage table shows
it beside the model without opening the detail page.

The Usage table's Provider/model column also names a provider for a request that
failed before a candidate was leased. `provider_id` stays NULL there — it means the
provider that served the request, and no provider did — but the caller's qualified
`provider/model` ref still names one, so the column resolves from that instead of
rendering a bare dash.

### The sharing modal confirms before regenerating, spins on refresh, and graphs the budget

Three gaps in one dialog. Regenerating ran immediately on click with no
confirmation, so an irreversible rotation could be triggered by a misclick. The
confirmation copy is per-mode because the two paths destroy different things:
regenerating a personal key rotates the credential, so every client holding the
old secret starts getting 401s; regenerating a share template rotates only the
link token in place (`share_links` is updated, not re-created), so the URL stops
resolving while recipients keep the keys they already generated. Telling a share
operator their old keys are deleted would be false, and telling a personal-key
operator their recipients are unaffected would be dangerous.

The Refresh button's icon never moved. `animate-spin` is a Tailwind utility, and
the icon carried no conditional class, so a manual refresh looked identical to an
idle one even though the list also polls on a timer. It now spins only while the
refetch is in flight.

The personal key's Usage section gained a lifetime-budget bar and the recipients
section an active-user count. Only the lifetime budget can be graphed honestly:
the gateway enforces daily and monthly token limits from in-memory admission
windows that are never persisted and never sent to the console, so the sole
counter the response carries is `tokensConsumed`. A daily or monthly bar would
render a zero the operator could not distinguish from a real one. The bar is
omitted when no lifetime budget is set. Active users counts child keys whose
`revokedAt` is null — a revoked key still appears for its usage history but can no
longer be used, so counting it would overstate who can call the gateway.

Recipients rows also gained the React key the list was missing, which surfaced as
a duplicate-key warning once more than one recipient existed.

### The Usage table labels a request that resolved no effort as `default`

The effort suffix was omitted whenever `requested_effort` was NULL, so the Model
column showed a bare model id whose effort was indistinguishable from one the
table merely failed to display. `requested_effort` is NULL for both situations
that leave no effort resolved: the client stated none, and the client stated one
the canonical model does not carry (`auto` is not in `REASONING_EFFORTS`, so
`parseReasoningIntent` drops it before it can be recorded). Both now read
`(default)`. Grouping, routing, and cost joins still read the bare model id —
`usageBy` aggregates on the column, not the display string.

### A disabled account keeps showing its last known per-model health

Disabling an account is not recovery: the backend deliberately preserves
`model_cooldowns` on a status toggle and clears it only when the operator uses
Recover or replaces the credential, because a model-scoped throttle excludes just
that (account, model) pair while the account stays routable for every other model.
The account badge checked `disabled` first and returned after its status and
error-category chips, so the per-model backoffs disappeared from the row and the
operator lost the account's last known health at exactly the moment they were
deciding what to do about it. The `cooldown` arm had the same gap. All three arms
now render one shared chip, so a future arm cannot silently drop it again.

### WorkBuddy quota reads the reference billing filter

Tencent billing queries now send the reference filter envelope (`ProductCode: p_tcaca`, statuses `[0, 3]`, and the 101-year package window) plus `X-User-Id` when the access token carries a UID. An empty `{}` could answer success with zero credit packages for an account that has them, which surfaced as “No credit package found”.

### Account labels adopt a learned identity only over the default

OAuth refresh and quota refresh now carry a learned display identity (`accountLabel`) and write it back only when the stored label is still the provider default. Operator renames are never overwritten; the check and the write stay in one statement so a concurrent rename cannot lose.

### Usage requests show the requested reasoning effort

Telemetry records the canonical effort the client asked for (`requested_effort`), and the Usage requests table renders it as a model suffix — `gpt-6-luna (xhigh)`. Grouping and cost joins keep reading the bare model id.

### Health history shows model-scoped failures

The account health log records and displays the affected model on the event row. Its wider, viewport-bounded dialog keeps long model IDs and error details readable with scrolling on narrow screens. Disabling or re-enabling an account no longer clears its failure evidence; only explicit recovery or replacing the credential resets it.

### Correct OpenCode MiMo Flash context limit

`opencodeft` and `opencodezen` both expose `mimo-v2.6-flash-free` with a 1,000,000-token context limit.

### A Messages-shaped `context_management` no longer reaches a Responses upstream

The two wires disagree on this field's shape: Anthropic Messages sends a map (`{edits: [...]}`)
while the Responses wire requires a sequence. The Responses codec read a bare
`extension:context_management` fallback, which the Messages parser populates, so a Messages request
routed to a Responses-wire model (for example `opencodeft`/`muse-spark-1.3-contributor-free`)
forwarded the map and the upstream rejected it with
"`context_management`: invalid type: map, expected a sequence". The Responses codec now accepts only
its own `extension:responses.context_management` spelling for that field; every other passthrough
field keeps the bare fallback, because the Chat parser files those and their shape is wire-neutral.

### Kiro (AWS CodeWhisperer) is a bundled provider

Kiro joins the bundled providers as a bespoke adapter, because its wire is not chat-shaped: a request is a
`conversationState` ledger posted to a `generateAssistantResponse` operation, and the answer is an AWS
EventStream binary frame sequence rather than SSE. `kiro/aws-event-stream.ts` owns the framing and verifies
both CRCs, so a truncated or interleaved message is a corrupt stream instead of plausible JSON; the events
are emitted as they arrive rather than buffered, so time-to-first-token is preserved.

A conversation the upstream cannot reconcile earns a terminal `400` that cools the account, so
`buildKiroWireRequest` repairs what it can — merging adjacent same-role turns, pairing tool results with
their calls, sanitizing tool names and ids to the wire's lengths — and refuses locally, without spending a
request, on what it cannot. The system prompt travels as a prefix on the opening user turn rather than a
field of its own, because a top-level `systemPrompt` is itself one of the shapes that earns the `400`.

Endpoint choice follows the auth family: the Amazon surfaces are tried first and the vendor gateway last,
since the vendor gateway answers a modern body with a terminal `400` while Amazon answers a foreign token
with a rotatable `401`/`403`. An account-bound credential (API key, Identity Center, enterprise) is never
sent the shared placeholder profile ARN — it belongs to the vendor's own account and earns a `403` — so it
sends only what the account resolved, an empty value meaning "use the token's own default".

All seven sign-in paths are supported: AWS Builder ID and Identity Center device flows (with the client
registration AWS SSO OIDC requires, and the client secret replayed at every later refresh), Google/GitHub
social sign-in, imported refresh tokens, enterprise Microsoft identity-provider JSON, and API keys validated
against the model catalog the key will actually be used on. Quota (`getUsageLimits`) and per-account model
discovery (`ListAvailableModels`) are wired, each with the client identity its own surface expects.

### Per-account auth configuration persists beside the credential

A credential string cannot express an account whose requests depend on where it was minted and which
upstream profile it is bound to. `provider_accounts.auth_state` now carries that non-secret configuration
(auth method, region, profile ARN, OAuth client id, token endpoint), populated by the login flow and read by
the adapter, by token refresh, and by the quota and discovery surfaces. A companion secret a login mints —
an OIDC client secret — is encrypted separately in `provider_oauth_states.client_secret_ciphertext`.

`OAuthTokenRefresher.refresh` gains an optional third argument (`OAuthRefreshContext`) carrying the account
id, that configuration, and the decrypted companion secret, so a provider client reaches the right endpoint
with the right client without reading the database itself. All fields are optional and additive: providers
that need none are unaffected, and a refresh that reports no state leaves the stored one alone.

Provider-specific login inputs (which identity provider, which organization URL, which region) now travel
through `OAuthDeviceFlowContext.parameters` and `OAuthAuthorizeRequest.parameters` from the console's start
request to the client, and are persisted with the flow correlation so a later poll rebuilds the same
context. One start route therefore serves providers whose logins differ.

### Reasoning and encrypted reasoning are no longer redacted

`redactTelemetryValue` now passes `reasoning_content`, `reasoning`, `thinking`, `encrypted_content`,
`signature`, and `redacted_thinking` through verbatim, before any other rule runs, and
`isOpaqueEncrypted` returns `false` unconditionally. Redacting them stripped the chain of thought a
thinking model needs on multi-turn replay, so a replayed turn arrived without the reasoning the
upstream demanded back. The exemption is key-based rather than value-based, so encrypted signatures
and IP-like numbers inside math or code inside a reasoning block are preserved too; credential,
secret-key, and IPv4 rules are unchanged for every other field.

### Reasoning visibility differs by provider, and the Codex limit is upstream

A provider streams either readable thinking or a short summary heading, and which one is the
provider's choice: `cb`, `cbcn`, `workbuddy`, and `mimodesktop` send the model's reasoning as text,
while the ChatGPT Codex backend sends only a short heading plus opaque
`encrypted_content`. Measured on `gpt-5.6-luna` with the same prompt, Codex spent *more* reasoning
tokens than the others while disclosing the least, so the thin trace is the server withholding it,
not a decoder dropping it.

No request-side field widens it: every mode of `reasoning.summary`, `context: "all_turns"`, the
Responses Lite shape, the WebSocket transport, and three other models all produced the same
heading, and the two spellings that look like the answer (`reasoning.summary: "none"`,
`include: ["reasoning.text"]`) are rejected with `400`. Two further points that read as levers but
are not: `x-reasoning-included` is a response header about past-token accounting, and omitting
`include: ["reasoning.encrypted_content"]` does not stop the server attaching the blob. Replay is
unaffected by dropping it — a stripped replay and a replay with no reasoning item at all both
answered correctly. The levers tried, the replay finding, and the coverage caveats are recorded
in "Known limitations: reasoning visibility" in `src/providers/PROVIDERS.md`.

### The logger sanitizes once, and for both sinks

`log.debug/info/warn/error` now build one sanitized argument list and use it for the console ring and
pino alike, instead of sanitizing separately per sink. `log.error` additionally rebuilds a redacted
`Error` for pino rather than handing it the original object, so custom enumerable fields carrying
credential material cannot reach the JSON transport. Every path falls back to
`[unserializable args]`, and a failure in one sink still cannot throw into the log call.

### Cache affinity reaches the adapter that mints session ids

Dispatch resolves `conversationAffinity` once per request from `resolvePromptCacheKey` and threads it
onto the dispatch context as `conversation_affinity`. An adapter that generates its own per-request
session id consumes it instead of a random value — opencode sends it as both `x-opencode-session`
and `x-opencode-request` — so a repeated conversation keeps one stable upstream cache key instead of
missing on every turn. `resolveInboundSessionId` also derives a stable `aff_<sha256 prefix>` key from
the opening turn when the client sends no session header and no conversation id, so a stateless HTTP
client that repeats its opening turn keeps hitting the upstream prompt cache. Text under the
30-character threshold derives nothing, so a trivial prompt cannot collapse unrelated conversations
onto one key.

### Buddy gateway requests keep the caller's system prompt

`applyBuddySystemPrompt` still guarantees the fixed leading `system` turn the upstream validates
(`11128`/`11151`), but now appends the caller's own `system`/`developer` text behind it instead of
dropping it. The upstream constrains which turn comes first, not its text, so merging is safe and
prompt caching keeps hitting the same prefix. The CN variant installs its neutralizer the same way.

### Dispatch re-projects per candidate, and terminal upstream failures keep their detail

When a candidate's `model_id` differs from the requested model, dispatch re-runs
`projectForRoute` against that candidate's own capabilities. The preparer projected against the
intersection of all candidates, so a failover target reached later may accept a narrower set than
the one that produced the request. Separately, `terminalFailure` now forwards an upstream `failed`
state's `provider_stop_reason` as `details.provider_code` and spreads its `stop_details`, instead of
flattening every such failure to a bare 502 "upstream request failed".

### Request validation and error classification tighten at the edges

A request with no `model`, or a blank one, is rejected 400 `invalid_request` at the top of
`ProxyRequestPreparer.prepare()` — before the snapshot read, so it never reserves capacity. An
unhandled throw reaching the ingress normalizer before canonical parse is classified 400
`invalid_request` with the error's own message rather than a generic 500, because a body that broke
a parser is the caller's request. A JSON proxy route receiving a non-`application/json` content-type
now returns `unsupported_media_type` 415 instead of `invalid_request`.

### Wire builders accept the other surface's spelling of shared controls

`normalizeWireMaxTokens` fills `max_tokens` from `max_output_tokens` on wires that accept only the
former, so a Responses-authored request keeps its ceiling when served on the chat or Messages wire
instead of falling back to that wire's default. Chat and Responses passthrough fields now fall back
between the `extension:responses.*` and bare `extension:*` spellings, and `verbosity` resolves from
any of its three sources. That fallback is for fields whose shape is wire-neutral; `context_management`
is excluded because Anthropic Messages and the Responses wire disagree on it, so only the
Responses-spelled key may supply it. On the Messages wire an unsupported `service_tier` is logged as a warning
rather than rejected or silently discarded, and `extension:metadata_user_id` merges into
`metadata.user_id`. Gemini `functionResponse.response` is always a JSON object — array content is
carried as `{ content: "<json text>" }`, since parsing a just-stringified array back into a value
produced a non-record the upstream rejected. Codex reasoning deltas now carry `summary_index`, so
multi-index summaries stay distinguishable through the canonical part.

### Error envelopes name the failing side

Every public error message now carries an origin label: `Cartethyia Error:`, `Upstream Error:`, or
`Network Error:`. Previously an upstream failure was emitted with **no** prefix at all, which was
meant to keep the gateway from being blamed but produced the opposite effect — a bare message is
ambiguous, so a provider rejection and a gateway defect were indistinguishable and every unlabelled
failure read as ours. `labelGatewayMessage` owns the mapping and applies it exactly once, so a value
that passes through both the ingress normalizer and the console error handler is not double-prefixed.

The `origin` field on each construction site was corrected to match reality. A provider that stopped
sending mid-stream, an upstream stream that ended before its terminal event, an upstream that produced
no terminal event, and a model-discovery fetch to a provider endpoint were all reported as `cartethyia`
— they are now `upstream`. An unresolvable upstream hostname was a 400 `invalid_request` blaming the
caller's request; it is now a 502 `transport_unavailable` with `network` origin. The
`proxy_unreachable` DNS-failure path keeps its `network` origin, which is what degrades a network pool.

### MiMo Desktop requests SSE explicitly

MiMo Desktop now sends `Accept: text/event-stream` with streamed Chat requests
and `Accept: application/json` with non-streamed ones, plus the native
`X-Client-Version` alongside its existing MiMo User-Agent and `X-Mimo-Source`.
The shared Chat decoder continues forwarding upstream reasoning and answer frames
incrementally.

MiMo Desktop's `/api/route/chat/completions` is served through Xiaomi's `MiFE`
edge proxy, which emits the SSE body in a few large bursts rather than per token,
so a short Desktop answer can arrive in one or two frames. This is an upstream
property; MiMo Studio's bot endpoint flushes per token and stays smooth.

### Connection strings resolve from the platform's published variables

`requireDatabaseUrl()` now checks `DATABASE_URL`, then `DATABASE_PRIVATE_URL` and
`DATABASE_PUBLIC_URL`, then assembles a URL from `PGHOST`, `PGPORT`, `PGUSER`,
`PGPASSWORD` and `PGDATABASE`. An empty value is treated as absent, which is what
a `${{ Service.VAR }}` reference to a misspelled service name produces on Railway
— that used to reach boot as "DATABASE_URL is required" with no hint that the
variable existed but resolved to nothing. Credentials and the database name are
percent-encoded when assembling, explicit host and port are still required, and
the boot error now names every variable that would satisfy it.

`requireRedisUrl()` follows the same order — `REDIS_URL`, then
`REDIS_PUBLIC_URL`, then `REDISHOST`/`REDISPORT`/`REDISUSER`/`REDISPASSWORD` —
so a Redis reference that resolves to an empty string no longer takes the
gateway down with a bare "REDIS_URL is required". Both resolvers share
`connection-url.ts`; neither ever infers a Docker or Laragon host.

### The data directory repairs its own ownership

A volume mounted at `/app/data` arrives owned by root, while the application
runs as uid `10001` — so every telemetry payload capture failed and the console
still reported the switch as On. The image no longer declares `USER`; the
entrypoint starts as root, takes ownership of the data directory for
`10001:10001`, and drops privileges with `setpriv` before exec'ing the binary, so
the application itself never runs as root and a root-owned mount needs no
host-side preparation. A container forced to start unprivileged still gets the
warning naming the ownership the host directory needs.

### Provider detail shows where to get a credential

Every bundled provider now declares its credential page in `provider-metadata.ts`, and the
provider detail page renders it as a "Get API Key" action with one line of guidance. A
provider whose sign-in runs through its own login flow is labelled "Sign in" instead, and
providers with no published page show nothing rather than an empty card. The link and hint
are projected from bundled metadata, never from the stored provider row, so a stale or
hostile record cannot redirect them; posting either field as a compatibility-profile
override is rejected as an unknown field.

### MiMo Studio keeps one conversation per chat

MiMo Studio no longer mints a random upstream `conversationId` per request. The adapter
now resolves it per provider account: an inbound session id pins one upstream conversation
for that chat, and a request whose history extends a tracked turn range continues it.
Callers sharing one Studio account therefore stay in separate chat sessions instead of
overwriting each other, and a multi-turn chat keeps its own thread. Because the upstream
keeps the history, a resumed turn sends only the turns the upstream has not received, which
also keeps a long chat inside the endpoint's request limit.

### MiMo Studio supports tool calls and reports upstream rejections

The Studio bot-chat endpoint ignores a `tools` field and accepts one `query` string, so the
gateway carries tool use in the prompt using the convention MiMo models already emit, and
turns closed blocks into canonical tool calls with `stop_reason: tool_use`. History tool
calls and results replay as the same blocks. The `query` is capped at the measured upstream
limit of 50 000 characters by dropping the oldest turns, instead of failing a request whose
history the model's own window could hold. An in-band `error` frame is now surfaced as a
typed gateway error — 413 for `query is too long`, 409 for a duplicate in-flight submit —
rather than ending the stream with no terminal event and reporting a generic 502.

### Xiaomi MiMo streaming distinguishes completion from interruption

MiMo Studio now forwards the request cancellation signal and reports an SSE body that
ends without `finish` or `[DONE]` as failed, rather than showing a truncated answer
as complete. A stream carrying both end markers emits only one terminal event.
MiMo Desktop inference now sends its service session cookie and native MiMo headers
without also leaking the stored passToken as an `Authorization` bearer token.

### Xiaomi MiMo integrations share one family directory

The Xiaomi API-key adapters (`xiaomipg`, `xiaomitp`), MiMo Desktop, and MiMo Studio
now live under `src/providers/integrations/xiaomi-mimo/`, alongside Studio's
think-tag splitter. Their provider IDs, credentials, upstream wire formats,
models, and quota behavior remain independent.

### Buddy thinking replay keeps parallel tool calls on one assistant turn

WorkBuddy and CodeBuddy now coalesce adjacent assistant fragments before dispatching
Chat wire. A Responses history with reasoning followed by parallel function calls
replays the trace on the combined assistant turn rather than leaving later calls
without it. Tool results and user turns remain boundaries; absent traces are not invented.

### Xiaomi MiMo AI Studio joins bundled providers

Cartethyia supports Xiaomi MiMo AI Studio (`mimostudio`) via pasted cURL,
JSON credentials, or `serviceToken` + `userId` cookies and translates its SSE stream
for `mimo-v2.6-flash` and `mimo-v2.6-pro`. The configured Studio quota endpoint
currently returns HTTP 404; quota verification and cookie renewal are not established.

### Xiaomi MiMo Desktop joins bundled OAuth providers

Cartethyia integrates Xiaomi MiMo Desktop (`mimodesktop`) using its local passToken
to acquire a MiMo service session through Xiaomi SSO. The adapter preserves the
OpenAI-compatible chat stream and its native `reasoning_content`; model aliases
and the Desktop quota collector remain separate from MiMo Studio's cookie-based flow.

### Route identity respects adapter User-Agent ownership

Routing Strategy now supplies its configured User-Agent only to built-in API-key providers whose
adapter does not build a native User-Agent. Provider-native identities, including Qoder's
`Go-http-client/2.0`, remain intact, and the dashboard hides the route setting for those providers.

### Antigravity quota reports the free-tier weekly window, and its catalog drops retired models

**The quota collector called one endpoint and parsed the other's shape.** Antigravity serves
quota from two endpoints, each carrying a window the other does not: `fetchAvailableModels` has
the per-model windows, and `retrieveUserQuotaSummary` has the weekly summary groups — the *only*
quota a free-tier account has, because the upstream omits per-model quota for it. The collector
requested the summary first but parsed only a `models` key, so a free-tier account showed no
quota at all and a paid one never showed its weekly allowance. Each endpoint is now parsed by
its own function and both are read, either may fail without discarding the other's windows, and
the family row takes the worst tier in its family — the one the operator runs out of first.

**Quota rows no longer name models the catalog cannot serve.** The upstream returns every
deployment the account can reach, including internal ones and one entry per effort tier. The
collector now collapses each key with `collapseAntigravityVariant` and keeps it only when the
catalog serves the result, so `gemini-2.5-pro` — a live deployment the catalog had dropped —
can no longer report a quota row for a model that cannot be selected. The accepted set is
derived from `ANTIGRAVITY_MODELS`, so a catalog change carries its quota rows with it.

**The static catalog matches the reference provider list.** Removed: `gemini-2.5-flash`,
`gemini-2.5-flash-lite`, `gemini-2.5-pro`, `gemini-3.1-flash-lite`, `claude-sonnet-4-5`,
`claude-opus-4-5`, and the two `tab_*_preview` entries — deployments the provider no longer
serves, which is why the rows were invalid. Added: `claude-sonnet-4-6` and `claude-opus-4-6`.
Live discovery remains the authority at runtime; this is the static floor, and it now names the
same families the reference list does.


### Browser OAuth completes on its own: the gateway now binds the loopback redirect

Every browser OAuth client advertises a **loopback** redirect URI — Codex
`localhost:1455`, OpenRouter `127.0.0.1:54549`, Antigravity `127.0.0.1:51121`,
Claude `127.0.0.1:54545`, and the gateway default `127.0.0.1:59653/callback`.
That URI names the machine the *operator's browser* is on, and nothing was
listening on it: the redirect landed on a dead page with the code stranded in
the address bar, so every browser login needed the URL pasted back by hand, and
on a local install even the manual path was the only way it could ever work.

**The cause was a stated premise, not an oversight.** The OAuth domain carried a
comment reading *"Cartethyia hosts the callback itself (it's a server process,
not a local CLI), so there is no loopback-listener/port-selection problem."* The
gateway is a server process, but it is not the server those redirects arrive at.
The claim is corrected in place where it stood.

**`callback-listener.ts` closes the gap.** `beginAuthorize` now binds the
redirect's loopback port for the life of the flow — on `127.0.0.1` *and* `::1`,
because `localhost` resolves to either and binding only IPv4 hands the code to
whatever else holds the IPv6 loopback on that port — and releases it when the
flow settles, so an idle gateway holds no extra sockets. The exchange runs
`completeLogin`, the same function the hosted console callback uses, so token
material still never reaches the dashboard. A port that cannot be bound fails
the login immediately rather than advertising an address nothing answers, and a
redirect the process cannot bind (the `zcode://` custom scheme, a remote host)
keeps the manual paste path.

The listener enforces the same replay and correlation rules as the hosted route:
the flow is claimed before the exchange so a retried redirect cannot spend the
code twice, and a state-less redirect (OpenRouter omits `state` entirely) is
matched to the one flow waiting on that port. The manual paste path stays as a
fallback, not as the only way in.


### The provider list reports per-model cooldowns, and every card is clickable end to end

Two provider-list defects, both invisible on the provider's own detail page:

**A per-model throttle was reported as a healthy connection.** A 429 scoped to
a single model writes only `modelCooldowns` and deliberately leaves
`status: "active"` and `cooldownUntil` untouched, because the account stays
routable for its other models (`account-health-service.ts`). The card built its
badges from `status`, so a provider whose detail page said "1 model cooling"
read as "1 Connected" in the list. The card now counts cooling accounts from
`modelCooldowns` — via `modelCoolingCount`, the same helper the Accounts tab
reads, so the two views cannot disagree — and shows a `Cooling` badge beside
`Connected`, which is accurate: the account is connected and cooling for the
models named in the map. The count is of accounts, not backoffs, so one account
cooling three models is one row to look at rather than three.

**A card could not be clicked near its bottom edge.** `.provider-grid` stretches
every card in a row to the tallest one, but each card's `<Link>` was only as
tall as its own content, so a card shorter than its row left a dead strip below
the link where a click hit the card and did nothing. The card is now a flex
column and the link carries `flex: 1`, so the clickable area spans the whole
card in both the built-in and custom-provider grids.


### Every OAuth provider's token request and exchange is verified, and two poll bugs are fixed

All 17 OAuth clients were audited against the three failure shapes this
codebase has already produced — an ignored redirect URI, a `pending` verdict
for a real failure, and a token body read as success without a token — and two
live instances of the second were found and fixed:

**Grok** read its poll body through the shared parser, which answered
`access: ""` for a body carrying no token, so a 200 with an `error` field
reported `complete` and persisted an account whose bearer was empty. **Kimi**
returned `pending` for the same body, so a rejected authorization polled until
the flow expired and showed the operator nothing. Both now fail with the
upstream's own reason. `parseTokenResponse` itself refuses a body without an
`access_token` (an access-only credential is still valid), which covers the
direct callers that read a token body outside the generic device poll.

**Dead code removed.** `providerIdForCallback` on the OAuth client base class
and its two overrides had no caller — the callback URL is now derived from the
route, not the client — and were deleted rather than left as a silently
unused hook.

Verified live: all 12 device-code providers complete a real device
authorization request and a real token poll (`pending` before approval), and
all 6 browser clients advertise the same redirect URI at authorize and at
exchange.

### xAI Grok Subscription joins as `xai`, and three provider ids are renamed

**`xai` is a new bundled provider** for the paid xAI subscription (SuperGrok /
X Premium+), served at `api.x.ai/v1` over the OpenAI Responses wire. It is
deliberately separate from the existing `grok`, which is the *free* Grok Build
CLI surface at `cli-chat-proxy.grok.com` carrying that CLI's own session,
turn-index, and identity headers: the two share an authorization server and a
public client id but not a base URL, a model roster, or a header set. The xAI
device flow registers a real refresher (`offline_access`), its own `/v1/models`
drives discovery, and the canonical reasoning-effort scale is mapped to xAI's
(`minimal`→`low`, `xhigh`/`max`→`high`) — xAI has no `minimal` and nothing above
`high`, and the shared codec clamps `max` to `xhigh` before this runs.

**Three provider ids were renamed** for brevity: `github-copilot`→`github`,
`kilocode`→`kilo`, `siliconflow`→`sifo`. This is a clean cutover — every module,
symbol, test, dashboard mirror, and doc reference was migrated and the old ids
are gone. Two facts stayed put because they belong to the upstream, not to us:
`base-models.json` keys (the generator writes models.dev's own provider names,
so `github`/`sifo` are mapped in `MODELS_DEV_PROVIDER_IDS` instead of editing
generated output) and the `X-Kilocode-OrganizationID` request header, which is a
wire byte the upstream reads. Display names and icon assets are unchanged.

**Browser OAuth exchange now sends the redirect URI it advertised.** Two
providers hardcoded the gateway's own console callback inside `exchangeCode`
instead of using the URI the authorize step sent, so Google answered
Antigravity with `redirect_uri_mismatch` (400) and the Claude exchange sent a
URI Anthropic has not registered. Both now declare their registered loopback
callback (`http://127.0.0.1:51121/oauth-callback` for Antigravity,
`http://127.0.0.1:54545/callback` for Claude Code) and the exchange uses the
caller's value, which is the same string the authorize step used.

**A pasted redirect URL with no `code` is no longer sent as the code.** The
dashboard dialog returned the whole URL when it found no `code` parameter, so
the token endpoint answered `Invalid or expired code` — an error naming the code
that was really a failed parse, sending the operator back to retry the same
broken paste. A URL carrying `error` now reports the provider's own description,
and a URL with neither is refused with a message saying so.

**An unknown device-poll verdict fails instead of polling forever.** GitHub
Copilot's device poll returned `pending` for any error it did not recognize, so a
permanent upstream rejection looked like a login that never finished: the dialog
spun until its own expiry with no reason shown. Unrecognized errors and non-2xx
responses now fail with the upstream's reason. The xAI client gained the
matching guard that a 2xx carrying an `error` field and no `access_token` is a
failure, not a completed authorization.

### Provider-native User-Agent precedence

Route-selected upstream User-Agent now fills only when the provider adapter has not set one, so
API-key identities such as Qoder remain intact.

### GitHub Copilot gets live discovery, capability routing, long context, and quota

Copilot was registered with a six-row static catalog and nothing else, so the
model list could not reflect the subscription's own entitlement and a
responses-only SKU had no route. Four gaps are closed:

**Live model discovery.** `github-copilot-discovery.ts` reads the account's own
`/models` using the host and token from the credential envelope. The envelope is
OpenAI-shaped but the rows are not: `supported_endpoints` names the surface each
SKU answers on and the window is nested under
`capabilities.limits.max_context_window_tokens`. A row is registered against the
wire family it actually serves — chat when it serves chat, `/responses` when
that is the only surface — and a row that serves neither on the OpenAI wire is
skipped rather than mislabelled as chat. An unreadable directory returns `null`,
leaving the static catalog in place.

**Long-context tier.** A SKU whose window reaches 500k carries Copilot's
`contextTier: "long_context"` request extension, injected only on the chat and
responses wires because the native Anthropic surface validates against its own
schema and rejects an unknown top-level key. The qualifying ids are recorded by
discovery, which is the only place the account's real window is known.

**Quota.** `github-copilot-quota.ts` reads plan and windows from
`/copilot_internal/v2/token`, the same call that mints the inference token. That
endpoint authenticates with the *GitHub* token rather than the minted one, so
the credential envelope now carries both; a window is emitted only when it
carries a usable number, never fabricated.

**Refresher wiring is pinned.** A new registry test asserts that every OAuth
provider registers a token refresher exactly when it has a refresh grant —
present for the short-lived-token providers, absent for Kilo Code, OpenRouter,
Zcode, and Devin, whose sign-in ends in a durable credential. Registering one
where no grant exists turns a recoverable auth failure into a permanent one;
omitting one where a grant exists lets a short-lived token expire silently.

### Quota account cards

Quota cards now show four usage windows at a time with previous/next pagination. Compact
square-corner meters keep account cards denser.

### API-key access controls and dialog

The Create/Edit key dialog now uses a responsive single-column layout with descriptive switches for
blocked client routers and scopes. Provider allowlists are removed from authorization and persistence;
migration `0005` drops the column. Existing provider restrictions are intentionally lost on upgrade;
model rules and scopes remain. Migration `0006` widens the existing `share_links` constraint to allow
personal handoff links.

### The Cloudflare Workers AI provider is dropped

The bundled `cloudflare` provider is removed: its adapter and request suite, its
identity row in `provider-metadata.ts`, its registry capabilities entry, its
dashboard display name and icon, its entry in the free-tier list, its icon
asset, and its documentation references. The bundled provider count in
`README.md` follows.

The composite `{apiKey, accountId}` credential was the only provider shape that
required a caller to supply a second identifier in the secret itself, and its
catalog served no model the remaining providers do not. Removing it leaves no
alias and no forwarding shim: the id is no longer a bundled provider, and both
`registry.resolve` and `registry.resolveModelDiscovery` answer `undefined` for
it rather than loading a module that no longer exists.

A deployment that already holds a `cloudflare` row keeps the row. `seedBundledProviders`
upserts only the ids the registry still ships and never deletes, and the bundled
rows it writes carry no `base_url`, so the row is not walked by `registerByokProviders`
either — it simply stops resolving to an adapter, which is the state any retired
provider reaches.

### Kilo Code is a bundled provider

`kilocode` joins the bundled set: a device-code OAuth login, an OpenAI-compatible
chat adapter on `api.kilo.ai/api/openrouter/chat/completions`, and a live model
directory at `api.kilo.ai/api/gateway/models`. The bundled provider count in
`README.md` follows.

Three things about this upstream decided the shape of the port, and each is
pinned by a test rather than left to a comment:

- **The poll key is the user code, not the `device_code`.** The start response
  carries both; polling with the `device_code` is answered `410 expired`, so the
  user code is what the flow carries forward. The first implementation of this
  port copied the wrong field and the flow could never complete.
- **The directory is OpenRouter-shaped, so it does not go through the shared
  `/models` fetcher.** Limits live under `top_provider`, modality under
  `architecture.input_modalities`, capability under `supported_parameters`.
  Feeding that to the tolerant fetcher does not fail — it publishes every row at
  the `200_000/64_192` floors with `toolCall: false`, and `toolCall: false`
  makes capability preflight strip `tools` from the request, so every model
  would silently lose tool calling.
- **There is no refresh grant, so no refresher is registered.** The client
  declares `refresh` as a throw and the registry wires it without
  `withRefresher`, which is what makes the credential path and the 401 retry use
  the stored token as issued instead of calling a method that always throws.
  Because the issuer advertises no token lifetime either, the stored `expires_at`
  is a far-future fallback; a nearer value would mark a working token as due for
  a refresh that cannot happen.

The stored credential is a `{accessToken, orgId}` envelope, because the console
keeps one opaque string per account while the gateway scopes every request to
the account's organization. Both consumers decode it: the adapter at the auth
boundary, where it also stamps `X-Kilocode-OrganizationID`, and the model
directory reader, which would otherwise put the JSON on the wire as the bearer.
That second one is invisible against the live endpoint — the directory answers
identically with no credential at all — so it is pinned by a test rather than
left to observation. The static fallback catalog carries 18
rows read from the live directory, and every one of them was verified present
there; the eight ids another gateway's fallback list carries are not reused,
because three of them (`anthropic/claude-sonnet-4-20250514`,
`anthropic/claude-opus-4-20250514`, `deepseek/deepseek-reasoner`) no longer
resolve upstream.

### DeepSeek and Hugging Face are bundled providers

Both join as bearer-authenticated OpenAI-compatible hosts, and the bundled
provider count in `README.md` follows.

**DeepSeek** is a zero-hook host: bare root `api.deepseek.com` with the
`/v1`-prefixed wire paths, so its adapter is one row in `GENERIC_API_KEY_PROVIDER_IDS`
plus its metadata entry. Verified live: `/v1/chat/completions` and `/v1/models`
both answer 401 to a bad key (a route that exists). Because a zero-hook host
declares no `loadModels`, it also carries an `openAIModelDiscovery` loader — the
same shape `ollamacloud` uses — so the operator does not have to type model ids
by hand. The base catalog already files four `deepseek` rows under that exact
id, so limits and pricing resolve without a filing-name mapping.

**Hugging Face** is not a zero-hook host, for one reason: the router's `/v1/models`
listing is OpenAI-shaped in its envelope but not in its entries. Each row is one
model with a nested `providers[]` array — the router brokers to several backends
at different prices and context lengths — and capability lives under
`architecture.input_modalities` plus a per-backend `supports_tools`. The shared
tolerant fetcher reads a top-level `context_length` and a `modality` string, so
against this listing it would publish every row at the `200_000/64_192` floors,
drop tools from every model, and lose the image input that **28 of the 78
bundled rows** declare. `integrations/huggingface.ts` reads the nesting instead,
with two judgement calls stated in the code: the window and price come from the
cheapest live backend, and `supports_tools` is ANDed across backends because a
model routed to a backend without tool support cannot call tools. The base URL
carries `/v1` (the bare host answers 404 on both `/v1/models` and
`/v1/chat/completions`), so the row path is the suffix that completes it.

### GitHub Copilot is a bundled provider

`github-copilot` joins the bundled set with a device-code login, and the bundled
provider count in `README.md` follows.

**Two tokens, and storing the wrong one is invisible until dispatch.** The
device flow issues a GitHub access token, which is then exchanged for a
short-lived Copilot token at `/copilot_internal/v2/token`; only the Copilot token
is accepted by the inference API. The GitHub token is stored as the refresh
value because it is what re-mints the Copilot token — which expires on the order
of half an hour, so without a real refresher every session would need a fresh
device authorization. This is the first bundled OAuth provider whose grant is
genuinely short-lived and refreshed rather than a durable key.

**The API host is per-account, so the credential carries it.** The Copilot token
embeds a `proxy-ep` claim naming the account's host, and an enterprise account is
served from a different host than an Individual one. A declarative spec cannot
express that — its `base_url` is fixed at registration and routing resolves one
base URL per provider, not per account — so this is a bespoke adapter that reads
the host out of the stored `{access, apiHost}` envelope. Payload translation,
SSE decoding, and error mapping stay with the shared pipeline. Its client
identity headers are a protocol requirement rather than cloaking: the API rejects
a request that does not identify a Copilot client, so they are stamped after the
shared pipeline and win over a route-level User-Agent.

`CARTETHYIA_GITHUB_ENTERPRISE_DOMAIN` points the login at a GitHub Enterprise
domain; empty (the default) means github.com.

**Not verified against the live API.** No Copilot subscription credential was
available in this environment, so the device flow, the token mint, and dispatch
are covered by tests against the upstream response shapes rather than by a real
request. The shapes come from a working client implementation (the token format,
the `proxy-ep` claim, the required headers, and the pending-state answers).

### The Codex GPT-6 context window was understated by two thirds

The bundled `codex` catalog recorded a 272k context window for the GPT-6
generation. That is the model's *default* window, not its capacity: the live
Codex registry (`/backend-api/codex/models`, read with a real account) reports
`gpt-6-astra` with `context_window` 272000 and `max_context_window` 872000, and
OpenAI documents 1.05M total context for the generation — 922k input plus the
128k output ceiling — so 922k is the input capacity and the registry's 872k is
the stale figure. Every routing alias and combo that resolves through a
`codex/gpt-6-*` row inherited the understated number.

`gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` keep the full 1M window they
were given when OpenAI raised it; the same registry still reports the pre-raise
272k for those ids, which is why the catalog does not read its limits from it.
`gpt-5.5` is genuinely capped — its `max_context_window` is 272000 — and
`gpt-daybreak-blue-latest` reports the standard window despite riding the 5.6
generation, so both stay at 272k.

Worth recording for the next reader: `model_context_window` is **not** a request
field. Sending it is rejected with `Unsupported parameter`, and the Responses
Lite header is likewise never sent by this gateway (`responses_lite` is not
enabled anywhere), so the window is the model's own and the catalog figure is
client-side bookkeeping. The extended window therefore needs no opt-in flag on
this path.

### Three providers gain OAuth sign-in, and Codex browser login is fixed

Codex, OpenRouter, and a new `zcode` provider (Z.AI Coding Plan) can be signed
into from the console. The bundled provider count in `README.md` follows.

**Codex browser login could never complete.** The console advertised one
gateway-wide loopback redirect URI to every provider, but authorization servers
allowlist redirect URIs exactly: OpenAI registers only
`http://localhost:1455/auth/callback` for the Codex client and answers any other
value with `invalid_request` *before* a consent screen. A login client may now
state its own `browserRedirectUri`, which the console route prefers over the
gateway default, and the same string is reused at exchange because the token
endpoint compares it against what the authorize step sent. The authorize request
also now sends the two flags the reference client sends —
`id_token_add_organizations` and `codex_cli_simplified_flow` — since without them
the reduced consent screen is skipped and the id token omits the organization
claim the account label reads. The device-code flow was already working and is
unchanged; both flows remain one merged client.

**A callback that carries no `state` is correlated by provider.** OpenRouter
never echoes `state`, so its callback arrived with no key to look the pending
flow up by and every sign-in would have failed as "unknown or expired state".
`OAuthFlowStore` now writes a per-provider pointer alongside the state key and
`handleCallback` falls back to it when `state` is absent. The pointer is
last-write-wins — a second console login for one provider repoints it, and the
operator's newest attempt is the one they are watching — while the state key is
still consumed atomically, so a callback can never inherit a spent verifier.
OpenRouter's authorize request is also non-standard in ways a "make it look like
the others" refactor would undo, so each is pinned by a test: it names its
callback `callback_url` rather than `redirect_uri` and sends no `client_id`,
`response_type`, or `scope`.

**`zcode` is a separate provider from `zai`.** Z.AI's Coding Plan is a
subscription served on a different host (`api.z.ai/api/coding/paas/v4`) with its
own catalog and its own credential, so it is registered as `zcode` rather than
folded into the pay-as-you-go `zai` provider that already existed.

**Its sign-in is two-stage, and the second stage is what makes it usable.** The
authorization code is exchanged for a short-lived OAuth access token, which is
then traded through Z.AI's business APIs — business login → resolve the default
organization/project → find or create the gateway's own named key → read its
secret — for the durable `<apiKey>.<secretKey>` the coding endpoint actually
accepts. Storing the OAuth token instead produces a credential that
authenticates nowhere, and the failure would have surfaced at first dispatch
rather than at login, so the whole chain is pinned by tests: the minted key and
never the token, each hop's auth, re-login reusing the existing key rather than
creating a second one, and the secret read from the copy endpoint because the
list endpoint masks it. Z.AI rejects every loopback URI for this client, so the
flow uses its `zcode://` desktop scheme and the operator pastes the final
redirect URL.

All three register no refresher where the grant ends in a durable key
(OpenRouter, `zcode`), matching how the 401 retry path and the credential
resolver already behave for Devin and Kilo Code: a registered refresher would
make the retry call a method that always throws.

A Gemini route (the `gemini` provider, or Antigravity) received images,
documents, and audio through an encoder that resolved only two payload shapes
of its own. Everything else — a Responses `input_image`, a bare string
`image_url`, a document, an audio part — fell through to a text placeholder,
so the request succeeded and the model answered as if nothing had been
attached. The same encoder put a `data:` URI in Gemini's `fileUri` field, a
field the upstream treats as a fetchable reference, and stamped a hardcoded
`image/png` on every remote image. This is the path an IDE or a router in front
of one takes, and its images arrive as data URIs by construction.

The encoder now projects media through the shared `resolveImageSource` and
`splitDataUrl` primitives that every other wire builder already used: inline
bytes become `inlineData` under the media type the caller declared, a remote
URL stays a `fileData` reference, and a non-image attachment is encoded as the
inline bytes or reference it actually is. `fileData.mimeType` is omitted when
the origin declared none, rather than guessed. An image that carries only a
Files API id still degrades to a text reference naming the id — the id belongs
to the originating provider's store and is not a Gemini file URI — but it is
never silently dropped. The cross-protocol fidelity matrix now includes the
Gemini wire, which is why this gap went unnoticed: it covered the three codec
wires and not the two direct-entry ones.

### One key in both credential headers is accepted

A client that presented the same API key in `x-api-key` *and*
`Authorization: Bearer` was rejected `400 conflicting credential headers`, so
every request from it failed. That pairing is a compatibility idiom, not a
mistake: an Anthropic-compatible client sends both so a gateway reading either
header works, which is why one such router sends them together by design. The
pair is now accepted when both carry the same token.

Two *different* credentials are still `400`, and a non-Bearer `Authorization`
alongside `x-api-key` is still `400`: tolerating the pair must not mean picking
one at random, because that would silently decide which identity the request
runs as. A single header, or neither, behaves exactly as before.

### A repeated OAuth login replaces the account it belongs to

Logging in again with an email that was already enrolled added a *second*
account instead of refreshing the first. The account identity was the
refresh-token fingerprint, and a fresh login mints a new refresh token — so the
identity index never saw a duplicate, and the unique constraint only caught a
replay of the exact same credential. The result was the pair an operator saw:
the original sitting `Disabled` with `Re-login required`, and a new `Active`
row for the same email.

The identity is now the label the provider reports — the account's email or org
name — which is stable across logins. A login whose identity already exists
replaces that row and its stored refresh state, and clears the failure state
with it, because a fresh credential makes the previous rejection meaningless by
definition: the account comes back `Active` rather than leaving an operator to
delete the stale row by hand. A provider that reports no label keeps the old
behaviour and still rejects an exact replay, and a different email is still a
different account.

Two consequences worth stating. Renaming an account in the console changes the
stored label, so a later login is treated as a new account instead of silently
overwriting the rename — the tradeoff the identity index always had, now
recorded where the decision is made. And two logins for the same identity
racing each other can still collide on the unique index; the second answers the
existing `provider_account_duplicate` 409, and a retry replaces.

### Payload capture failures are visible, and a bind-mounted data directory is prepared

Telemetry payload capture could be switched On in the console and store nothing,
with no error anywhere. The bodies are written to local `.jsonb` frames and the
database row holds only a reference to the frame, so when the frame write fails
there is no row at all — and the failure was swallowed by an empty `catch` on
the fire-and-forget capture path. A deployment could not tell "capture is off"
from "capture is on and broken".

The usual cause is a deployment one. The container runs as a non-root user, and
a bind-mounted data directory arrives with the *host's* ownership, so the
payload directory is not writable and every capture fails. The image's chown of
`/app/data` cannot help: the mount overrides it. The entrypoint's existing
permission fix could not help either — it was guarded on `id -u = 0`, which
never holds under the image's own `USER`, and it tested `/app/migrations`
instead of the data directory.

Three changes. Capture failures now log a single warning per process naming the
directory and the remedy, so an opted-in tenant that stores nothing can see why.
The runtime uid/gid are pinned to `10001` so a host directory can be prepared
against a known id. And the entrypoint prepares the data directory when it can
run as root, reporting the uid to chown to when it cannot — which is the normal
case, and now documented in `README.md` and `.env.example` with the one-line
`chown` that fixes it.


### Error codes preserve distinct failure types

Untyped gateway exceptions now return `internal_error`/500, not `invalid_request`/400. HTTP and stream
errors share structured provider-code classification, retaining upstream status details. Proxy pools
are disabled only for network-origin 402/407 responses; an upstream 402 remains a provider quota error.

### The in-flight gauge can no longer be stranded by a bookkeeping failure

The console's in-flight gauge climbed and never came back down under traffic.
The counter is incremented when a request is admitted and decremented exactly
once by `state.cleanup()`, which on a streamed response is reached only through
`releaseStreamResources()`; the root `afterResponse` hooks deliberately skip a
request whose `state.streaming` is set. That release sat at the end of the
streaming error path with nothing protecting it, and `completeAttempt` claims
the terminal outcome *before* it awaits the usage reconciliation — so a store
failure there unwound past the release, the error frame, and the close. The
request's slot was gone from the state map, so nothing could reclaim it and the
gauge stayed one higher for the life of the process. A stalled provider reached
the same place with no client action at all.

Two changes, both at the cause rather than at one caller. Usage reconciliation
is now swallowed like the health and pool reports beside it, because it is
bookkeeping and a failed report must not decide the request's outcome; and the
two streaming error paths that await it now release in a `finally`, so no
throwing await between the terminal outcome and the release can skip it. The
release was already single-shot, so reaching it twice is safe.

Reproduced before the fix and pinned after: with a rejecting usage commit, a
mid-stream failure left the gauge stuck at 1. Removing the guards again fails
that test, which is what makes it a regression test rather than a description.

### A PaaS edge can be trusted without an allowlist

`TRUSTED_PROXY_CIDRS` accepts a third form: the single value `platform`. The
gateway previously offered only an allowlist or nothing, and behind a PaaS edge
(Railway, Fly, Render) neither works — the edge terminates TLS and the container
has no public address, so every request arrives from an edge node whose CIDRs
are not published and not stable, no allowlist entry can match, and the
forwarding headers were ignored. Every request was recorded under the edge's own
address instead of the client's, which also collapsed per-IP enrollment and
per-IP abuse accounting onto one key.

`platform` trusts the forwarding headers from any peer, so it is opt-in and
documented with the condition that makes it safe: the container must be
unreachable except through the edge, or a direct caller could forge its client
IP. It is matched only as the whole value, so a list that also names CIDRs stays
a real allowlist rather than silently widening to trust-everything. Unset still
means `disabled`, and the raw peer is still the client there.

The two single-valued edge headers (`CF-Connecting-IP`, `True-Client-IP`) remain
preferred because the edge overwrites them. A forwarded chain is still read from
its left end, which assumes the edge prepends the address it observed; that
assumption is now stated in the code rather than left implicit, and the headers
that do not depend on it are the ones recommended for a deployment whose edge
behavior is unknown.

### Documentation corrected against the code

An audit of the README, the layer docs, the environment template, the CI
workflow and the contributor docs checked each claim against the implementation.
The corrections, most consequential first:

- **`.env.example` inverted the SSRF default.** It said private upstreams are
  blocked by default and showed `CARTETHYIA_ALLOW_PRIVATE_UPSTREAMS=false`.
  The setting is a flag — enabled unless the literal `false` is set — so leaving
  it unset *permits* a provider base URL that resolves into a private range. An
  operator who trusted the comment and left the line commented ran with the
  permissive policy. The template now states the real default and how to narrow
  it, and the `README` telemetry-capture default was corrected the same way
  (`telemetryPayloads` defaults to `none`, not `bounded`).
- **The CI push trigger named a branch that does not exist on the remote.** Only
  `dev` and the GitHub default branch are published, and the default branch
  carries no copy of the workflow, so `push: branches: [main]` could never fire
  and direct pushes to the integration branch went unverified. The filter now
  names `dev`.
- **`README.md` and `CONTRIBUTING.md` described a development supervisor that
  no script runs.** `bun run dev` is `dev:stack` — `concurrently` over the
  backend and the Vite dev server on two ports — with no proxy, no CTRL+R
  in-place restart, and no request holding. `scripts/ops-dev-supervisor.ts`
  exists but is referenced by nothing, including the docs that described it.
- **`TRANSPORT.md` contradicted the middleware it documents.** The IP-abuse
  middleware was listed as a stage of the `/v1/*` chain (it mounts on the root
  `request` hook, ahead of the whole chain), `EligibilityEvaluator` was said to
  filter out `cooldown` and a `unhealthy` reason that no longer exists, and
  `resolveMaxInflight()` was said to prefer an account value the function never
  reads. `ARCHITECTURE.md` repeated the stage-order error.
- **`PERSISTENCE.md` and `CONSOLE.md` described share links as hash-only and
  enroll-only.** They retain the bearer token encrypted so the console can
  re-display the link, and a personal key gets a `handoff` link while a share
  template gets an `enroll` one. `PERSISTENCE.md` also claimed a GIN index on
  `providers.capability_profile` that no migration creates — the same false
  claim sat in a `schema.ts` comment, which is where the doc had copied it from.
- **`SECURITY.md` named an API that was renamed and listed two thirds of the
  scope union**, omitting the four `providers:*`/`models:*` scopes that are
  tenant-assignable and security-relevant.
- **The engineering skill's build command produced a broken binary.** It
  compiled `src/main.ts`; the real entrypoint is the AOT output `dist/main.js`,
  because bundling the raw source leaves Elysia's lazy `require("typebox/type")`
  unresolved. Its prescribed commit trailer and `type(scope):` prefix appear in
  no commit in the repository, and it named a `test/providers/integrations/qoder`
  directory that does not exist — a path that still exits 0 by falling back to a
  filename filter, so a reader would take it as a passing run.
- Smaller corrections: `NODE_ENV=production` no longer gates the migrations
  folder (in `README.md`, `Dockerfile`, and both build scripts), the baseline is
  no longer described as the directory's only file, `bun run fetch:binaries`
  was an instruction for a script that does not exist, the dashboard's test
  command was confused with the backend's, `AGENTS.md` now records the
  `scripts/*.test.ts` exception and the dashboard's actual TypeScript subset,
  and the pull-request template no longer grants committed docs an exception to
  the line-number ban.

### Unified protocol hardening map

Documented the distinct Chat Completions, Responses, and Messages contracts; mapped token-count and
compaction APIs, modality/reasoning boundaries, Responses failure work, and Cursor Editor BYOK
constraints. The stream path also sends downstream SSE keepalives during upstream silence without
changing upstream watchdogs or retries. The Responses encoder now preserves multi-part reasoning
summary indices through completion, fixing a confirmed output bug. The broader missing-reasoning
report and HTTP 400 cause remain unconfirmed and are not claimed fixed.

### A fresh install starts from the current health statuses

`0000_baseline.sql` still declared the `health_status` enum with the retired
`degraded` label, so a new database created the four-value type and then ran
`0002` to fold it down to three on the same boot. The baseline is the schema a
fresh install starts from and is supposed to describe the current shape, so it
now declares `active | cooldown | disabled` directly; `0002` keeps its guard and
becomes a no-op for a database that already has the right type, which is what
that guard was written for. A contract test pins the label out of the baseline,
the same way the retired `native` wire family is pinned out.

### The dashboard mirror no longer pulls a Node builtin into the browser bundle

`dashboard/src/lib/contracts.ts` re-exported the usage-dimension tuple from
`console/domains/stats/contracts`, the module that also declares the usage
routes. That module imports Elysia and reaches `node:crypto` through the console
error path, so the browser bundle externalized the builtin and carried a slice of
the backend graph for one list of strings. The tuple now lives in an import-free
`console/domains/stats/usage-dimensions`, which both the route module and the
mirror re-export, so the shared binding is unchanged and nothing backend-shaped
enters the bundle.

Vite only warns about an externalized builtin, which is easy to lose in a build
log, so `test/architecture/dashboard-boundary.test.ts` now walks every
`dashboard/src` value import into the backend graph and fails on the first module
that reaches Elysia, a `node:*` API, or a database driver. A type-only import is
not a violation — the bundler erases it.

The committed usage-period file had the same shape of blind spot: every
dashboard script runs `codegen` before doing anything, so a period added to the
backend and not regenerated was overwritten before a test could read it and
failed nothing. The file is committed, so it now has a parity assertion against
the backend tuple — the only mirrored constant that did not have one.

### A key can refuse a downstream router

An API key may now name client routers it refuses. Several gateway products can
themselves be pointed at this gateway, and the reason to refuse one is usually
commercial rather than security — a key resold to a router, or spent by one whose
retries multiply upstream load.

The gateway labels the caller from inbound headers using values those products
emit themselves, and a request whose label is in the key's list is rejected `403
client_router_denied` before a route is planned. The editor offers only the
routers the gateway can fingerprint, and a write naming anything else is refused,
so a stored rule is always one that can match.

This is a best-effort label, not an authentication boundary: a client that sends
no fingerprint is simply not matched, and a provider-level User-Agent override
removes the User-Agent tells while leaving the header tells intact. An earlier
revision also matched signals shared with genuine first-party CLI clients and was
discarded after it labelled a real client request as a router — a signal that
cannot separate an imitator from what it imitates is worse than none. Header
order is not inspected either, because the request headers are normalised before
this layer sees them.

### Public pages carry a repository badge, and the share page loses its policy panels

The landing page and the public share page now link the project repository with
live star and fork counts, rendered as badge images from an external host that the
dashboard Content-Security-Policy admits under `img-src` only — `connect-src`
stays same-origin, so the page still cannot call a third-party API.

The share page drops its enrollment-terms panel, the key-prefix pill and the trust
copy, and announces a status only when it changes what the recipient can do: an
unavailable link or an already-claimed address, not the ordinary ready state. The
owner-side share dialog is denser, fits without horizontal scrolling when the link
is long, and no longer queries recipients for a personal key — that endpoint
belongs to a share template and answered `404` for a personal key, which surfaced
as an error over the key's own usage.

### User-Agent controls for built-in API-key providers

Provider Routing Strategy now saves a User-Agent per tenant/provider for built-in API-key providers
without OAuth login flows. It defaults to Codex; operators can select Claude Code or enter a custom
value. OAuth details do not expose the control, and custom providers keep their existing client identity
selection and wire configuration. The schema upgrades automatically at backend startup.

### A replayed reasoning item is folded into the turn it belongs to

A client replaying a conversation to the Responses surface hit `400 the reasoning
content from the previous turn must be passed back in thinking mode` on
WorkBuddy. The request carried six `reasoning` items, so the client was not
omitting them; two decoding faults were. A `reasoning` item is its own entry in
`input`, emitted on either side of the assistant item it belongs to — the
captured history has `reasoning, function_call` in one turn and `function_call,
reasoning` in another — and decoding item by item split each turn into a
reasoning-only assistant message plus the tool-call message, so the Chat encoder
attached `reasoning_content` to the wrong one and the tool-call turn went out
without it. The pair is now folded into one message, reasoning first, whether the
item arrived before or after its turn. The reasoning text was also read only from
`summary`, while a replayed item states it in `content` as `reasoning_text`;
those items parsed to no text and emitted `reasoning_content: ""`, which the
upstream reads as thinking mode with the reasoning stripped — the same 400.
Both fields are read now, summary first. Against the captured request, all five
tool-call turns carry non-empty reasoning, where three previously carried none.

### Cooldown is a deprioritization, and the `degraded` status is retired

A cooling account was excluded from routing outright, so a deployment whose only
account for a model was cooling answered `503 accounts_unavailable` while a
usable credential sat idle — reported as "cooldown blocks the account completely,
cannot be used at all". `EligibilityEvaluator` now keeps a cooling candidate
eligible and `plan()` orders it after every healthy sibling, re-asserting that
order after provider rotation (which is deliberately health-blind and could
otherwise float a cooling account back to the front). A healthy account always
wins; a cooling one is reached only when nothing better is left. `disabled`
remains a hard exclusion, because only an operator reverses it.

`degraded` is gone from the health machine, so the account and pool statuses are
`active | cooldown | disabled`. It sat between "working" and "parked" and each
consumer read it differently — routing treated it as a hard exclusion, the sweep
treated it as recoverable, and the console showed it as a third badge — which is
what made it ambiguous to operate. The two facts it mixed now each have a value
that means one thing: a self-clearing fault is a cooldown with a deadline, and a
fault needing an operator is `disabled`. A 5xx, timeout, or unclassified failure
is therefore a cooldown, and the pool health machine parks a pool on its first
failed probe rather than after a third. Migration
`0002_retire_degraded_health_status.sql` folds existing `degraded` rows onto
`cooldown` (never `disabled`, which would park an account that was recovering on
its own) and supplies a deadline where one was missing, since the sweep selects
on `cooldownUntil IS NOT NULL`. It rebuilds the shared `health_status` enum and
moves all four dependent columns, including the `health_events` history.

A bare upstream `402` no longer means the account ran out of quota on its own.
inferhub answers `402` with `no provider's ask matches your max-per-mtok bid` —
a verdict on the caller's price ceiling, not on the credential — and classifying
it as quota exhaustion cooled a fully-credited account down for an hour. A price
refusal is now recorded with `mutatesAccount: false`, so only that request fails;
a `402` whose message carries a real balance or quota signal still cools the
account down.

### A cooldown states when it ends, and a compound duration is read in full

A model-scoped throttle (a 429 for one model) writes `modelCooldowns` and
deliberately leaves `cooldownUntil` untouched, because the account stays
routable for every other model. The dashboard therefore had to read the
per-model map to answer "when can this be retried?" — and it did not. The
Accounts badge computed the soonest deadline and then discarded it, rendering
only "1 model cooling", and the health dialog showed a deadline only from
`cooldownUntil`, so a per-model 429 displayed a reason with no time at all. Both
now show the deadline, the badge names the model that clears first, and the
countdown timer is armed by the per-model deadlines too — it previously ran only
for `cooldownUntil`, so a per-model badge never ticked.

The reset duration itself was read incorrectly. `parseProviderResetDuration`
matched a single `amount unit` pair, so Cline's "Try again in 4h 13m" became 4h
and the stored deadline was 13 minutes earlier than the window the provider had
stated — long enough for the account to re-enter rotation before the limit
lifted. A relative phrase is now summed across every pair that continues it
(`4h 13m`, `1 hour and 30 minutes`, `1h, 15m`, `2h30m`), and `m` no longer
swallows the `ms` of a millisecond backoff or the `mo` of a month. The
`sweepExpiredCooldowns` pass that prunes elapsed per-model keys and the manual
recover that clears them were already correct and are unchanged.

### A built-in seed row is only kept while the provider still serves it

`seedBundledModels` deletes a `builtin` row its static catalog no longer
declares, which makes the catalog list the owner of that row: nothing else
prunes one, so an id the provider has retired stays in the catalog — and stays
routable — forever. Cline's seed carried two ids
(`nvidia/nemotron-3-ultra-550b-a55b:free`, `google/gemma-4-31b-it:free`) that
its live free roster no longer publishes, so both rendered as built-in cards
whose every probe could only fail. They are removed, and a test now pins the
seed against the roster the adapter actually reads so a retired id cannot be
re-seeded.

### Free-tier discovery, and a model list grouped by where each row came from

Two providers publish a free tier, and neither was reachable through "Fetch
models". **OpenCode Free** shares its `/zen/v1/models` listing with the billed
Zen catalog — 81 ids, of which only the free ones are routable without a
credential — and its discovery applied no filter at all, so a fetch wrote
`claude-opus-5`, `gpt-6-astra`, and every other billed id into the catalog as
ordinary rows. It now filters to the free tier and marks what survives; one
listed id (`deepseek-v4-flash-free`) is excluded because a real free-tier
dispatch answers `400 Model is unavailable` even though the listing still
advertises it. **Cline** discovery asked for the pass roster (`pass: true`) for
every account, writing subscription rows into the catalog of an operator who may
hold no pass — rows whose dispatch can only 401. It now asks for the free tier
only.

The model list is grouped into four labelled sections in reading order —
**Built-in models**, **Free models (auto)**, **Manually added**, and **Fetched
from provider** — replacing the previous two-way split that put the free tier
and ordinary fetched rows in one group. A new `source: "auto_free"` records a
discovered free-tier row, written by `syncModels` from a marker the discovery
module sets on the definition, so the grouping survives the write instead of
being re-derived from the id afterwards. Cline's tier comes from the roster's own
`free` bucket, not the id prefix: the bucket serves ids with no `cline-free/`
prefix (`deepseek/deepseek-v4-flash`), so a prefix test would drop served models.

### The Models card separates built-in from fetched, and a probe follows a Thinking setting

The provider detail page's model list rendered the compiled catalog and the
operator's own fetched/manual rows as one undifferentiated grid, so a built-in
entry (disable-only, immutable) and a row this deployment added (deletable)
looked alike. The list is now grouped and labelled — see the section above for
the four groups it settled into — with each group's count and a note on what may
be done to it. A row whose `source` is `null` (written before that column
existed) is treated as built-in, which is the conservative reading: disable, not
delete.

The Models card header now carries one **Thinking** selector, to the left of
"Fetch models", offering `auto`, `minimal`, `low`, `medium`, `high`, `xhigh`.
The list is derived from the backend's `PROBE_REASONING_EFFORTS` tuple, so the
selector cannot offer a value the route schema rejects. The setting is
section-wide and owned by the header, so every test in the card follows the one
choice rather than each card needing its own — the Add-Model dialog keeps a
selector too, for the test it runs before registering. `auto` — the default —
sends no reasoning intent at all, and a specific effort is forwarded only when
picked; that is what lets a test follow a setting. Previously the probe always
built a `medium` Responses reasoning intent, so a model without reasoning support
failed a probe that should have passed, and a test could not be made to exercise
a particular effort.

Probes now **stream by default** (`stream: request.stream ?? true`), set once in
`buildProbeCanonicalRequest` so all three entry points — one model, all models,
all accounts — share one transport. A streamed probe is the only one that
observes time-to-first-byte, and it keeps the connection open while a reasoning
model thinks instead of waiting for a complete body. The empty-content retry
raises the output allowance and forces streaming for the same reason. An explicit
`stream: false` is still honoured. The probe request resolves only after the
stream is consumed, so the card's completion toast already reported a finished
result rather than a queued one; "Fetch models", which was silent, now reports
what it synced.

### Provider limits come from the catalog, and three login flows stop misreporting themselves

Four defects, all of which showed up as "the model list is wrong" or "login does not work":

- **Cline's roster was published with invented limits.** The recommended-models endpoint
  reports only `id`/`name`/`description`/`tags`, so the fetcher filled in a fixed
  `200_000`/`64_192`. Most of the roster is larger — the subscription entries are
  1M-context — so every Cline model advertised a window far below its real one. Limits now
  come from Cline's own sibling catalog (`/ai/cline/models`, which states `context_length`
  and `top_provider.max_completion_tokens`, and whose `input_modalities` is authoritative
  for vision), falling back to the base catalog through `defineModel` when that fetch is
  unavailable. Measured against the live endpoints, 35 of 37 published rows now carry the
  provider's own limits; the remainder is one anonymous id no catalog records.
- **A model the catalog knows but does not agree on fell to a fixed default.**
  `modelsDevCatalog.resolve` fails closed on disagreement, which is right when a limit may
  be left unstated — but Cline is filed as `cline-pass`, never `cline`, so every non-pass id
  missed entirely. `majorityFor(bareId)` now votes per field across the rows for that id
  (18 of 19 file `claude-opus-5` as `1000000/128000`; the dissenter is one reseller's 64k
  output cap). Only what the vote answers is taken — an id nobody records keeps the
  documented default — and an explicit row value still outranks it.
- **Every Cline pass id was double-namespaced.** The endpoint already prefixes its own ids
  (`cline-pass/…`, `cline-cloud/…`, `cline-free/…`), and the fetcher prefixed them again,
  producing `cline-pass/cline-pass/glm-5.3-flash` — an id no route resolves. The endpoint's
  spelling is now kept as given, and the `recommended` and `clineCloud` buckets, previously
  dropped outright, are read.
- **An output cap could exceed the context window.** `defineModel` published the catalog's
  output figure unclamped. The base catalog states `output === context` on 1084 rows and
  `output > context` on 69 (a Kimi K2.6 row is filed `262144/262144`), so a request could
  reserve more output tokens than the model accepts as input. `outputLimit` is now
  `min(declared, context)`; a `null` limit stays `null`.
- **Codex's device poll blocked for the whole authorization window.** `pollDeviceAuth` slept
  and retried up to 120 times inside a single console request (~16 minutes), so the
  dashboard's poll interval never applied and one worker was occupied for the duration. It
  now performs one attempt and returns `pending`, like every other provider. The device
  state is also deleted only after the token exchange succeeds — the authorization code is
  single-use, so deleting first stranded a failed exchange with no way to retry.
- **Device-only providers advertised a browser login.** `oauthFlows.browser` tested only for
  the *presence* of `buildAuthorizeUrl`/`exchangeCode`, but the base `OAuthClient` always
  defines both (device-only clients override the exchange to throw). Cline, Cursor, Grok,
  Kimi, Muse and Buddy therefore showed "Login with browser", and the click failed with
  `browser_code_not_supported`. An explicit `supportsBrowserCode: false` now suppresses the
  flow.
- **Cline's device flow asked the operator to retype the code.** The client published the
  bare `verification_uri` and ignored `verification_uri_complete`, which carries the user
  code in its query string. Opening the page now enters the code automatically.
- **The device dialog's auto-open was blocked.** It called `window.open` from an effect that
  runs after an awaited request, outside the click's user gesture, so the browser blocked
  the popup. The dialog keeps an explicit "Open" button and a link — both real gestures —
  and leaves auto-opening to the browser flow, whose popup is created synchronously in the
  click handler.

### An audio attachment no longer fails a Claude request

The Anthropic Messages request schema defines no audio content block — its
content blocks are text, image, document, search_result, thinking,
redacted_thinking, tool_use, tool_result, the server-tool result blocks, and
container_upload, and no accepted `media_type` admits an audio MIME type. Three
layers disagreed with that fact, and together they turned an audio attachment on
a Claude route into a rejected request:

- **The capability ladder claimed audio on every codec wire.**
  `buildCapabilityProfile` granted `image`/`document`/`audio` to every
  codec-backed route on the premise that "the codec wires can all carry those
  parts". True for image and document; false for audio on `messages`. A Claude
  (or Claude Code, or Kimi) route therefore passed the pre-lease gate for a
  request it had no way to encode.
- **The builder then emitted an invalid block.** `partToClaudeBlock` produced
  `{type:"audio", media_type, data}` — a block type the schema does not define —
  and the provider rejects the *whole request*, so the caller lost their text
  along with the attachment.
- **The response-direction encoder pinned a shape that cannot exist.**
  `messages/encode.ts` emits `{type:"audio", source:{…}}`, and
  `messages/parse.ts` reads it back, so an audio part appeared to round-trip on
  a wire that has no audio block at all.

`AUDIO_CAPABLE_WIRE_FAMILIES` (`chat`, `responses`) is now the single
declaration of which codec can encode an audio part, and `routeCapabilitiesFor`
narrows audio against it. A declared `audio` modality no longer overrides that
narrowing: the flag describes the *model*, and no declaration adds a block the
schema does not define. An audio request on a messages-only route now degrades
through the existing capability path — the attachment becomes a visible
`[audio]` placeholder and the text survives — instead of failing upstream. Image
and document are untouched, because every codec wire defines those blocks. The
builder degrades the part to the same placeholder rather than emitting an
undefined block type, so an unexpected part costs only the attachment.

### The agent contract cites real sections, and the last subfolder doc is gone

`AGENTS.md` carried stable rules under unstable headings: other files cited it by
section *name* (`"Verification gate"`, `"Documentation currency"`, `"cleanup
rules"`), and none of those names existed — so every citation resolved to
nothing. The contract now opens with a section index that maps each number to its
exact title, and the three broken citations in `ci.yml`, the PR template, and
`CONTRIBUTING.md` point at the numbered sections instead. The rule against fixing
a symptom rather than its cause was stated in five sections; it is now stated
once in §5 and applied by §6 and §7, with the test-specific prohibitions
(mocking the defect, hardcoding success) kept where they belong in §7.

A new §3 "Action gate and context budget" adds what the contract was missing for
long tasks: when the CodeGraph index is present, a wide "where is X / what calls
X" question is one explore call rather than a grep-then-read loop, and a search
spanning many files belongs in a subagent that returns the conclusion instead of
the file dumps. It also states the reasoning-effort guidance that previously
applied only to one model, generalized to every model.

`src/console/cli-tools/injectors/CONTRACT.md` was the last layer doc living in a
subfolder, against the rule that each top-level `src/` folder owns exactly one
doc for its whole subtree. Its content — the `InjectorSpec` lifecycle, the
`fs-ops.ts` surface, and the eight house rules for a new spec — is folded into
`CONSOLE.md` as an "Injector contract" subsection, verified against the source it
describes, and the file is deleted.

### Cross-protocol media no longer breaks the request

Moving a session between protocols — a Messages client onto a Chat model, a
Responses client onto a Claude route — could lose the caller's image or document,
or send a shape the provider rejects outright. A canonical content part is an
*opaque origin payload*, so the same image arrives as a Responses
`{type:"input_image", image_url:"…"}` string, a Chat `{image_url:{url}}` object,
or an Anthropic `{source:{type:"base64"}}` object, and the builder has to
re-encode it into its own wire vocabulary. Three defects did not:

- **A Responses- or Chat-origin image sent to a Claude model produced an invalid
  block.** `normalizeImageBlock` only inferred `source.type` when it was
  *missing*, so a Responses payload's `type: "input_image"` was forwarded
  verbatim as `source.type` — a discriminator Anthropic does not define. The
  provider rejects the block and the whole request fails.
- **A canonical `file` part had no branch in the Chat builder at all.** `image`,
  `document` and `audio` were all handled; `file` — which is how a
  Responses-origin document arrives — was silently dropped on the way to a Chat
  model, with no error and no log.
- **A bare-string image payload, and a `file_id`-only image, degraded to
  "[image: unsupported source]"** on every surface, because the shared
  `resolveImageSource` did not recognize either shape.

All three now route through the one resolver, which accepts every origin shape
(a bare URL/`data:` string, the Chat nested object, the Responses
`image_url`/`file_id`, and Anthropic's `source`) and is the single place a new
shape is taught. A `data:` URL reaching Anthropic is split into its
`{media_type, data}` base64 transport rather than embedded, since Anthropic has
no data-URL field. Where a wire genuinely cannot express a shape — Chat has no
`file_id` form for images and no document-URL field — it degrades to a text
reference naming the id instead of emitting an invalid block, because the
provider rejects the whole request and the caller loses their text with it.

Verified by a cross-protocol matrix over seven origin shapes × three target
wires, asserting the *validity* of the outbound block rather than its presence:
21/21 wire-valid, up from 17/21.

### An image no longer reaches the wire as an object

`image_url` is a **string** on the Responses wire, and the Codex and Responses
builders were forwarding the canonical image part's opaque origin payload
verbatim. That payload is whatever the inbound surface used — Anthropic's
`{type:"image",source:{type:"base64",...}}`, Chat's nested `{image_url:{url}}`, or
a flat `{url}` — so an image originating from any surface other than a
pre-formed Responses block put an **object** where the provider required a URL,
and the provider rejected the whole request with HTTP 400:

```
Invalid type for 'input[114].content[1].image_url': expected an image URL, but got an object instead
```

Measured against the builder: four of six origin shapes failed, and the failure
took the entire request with them — including the text the caller actually asked
about. Three sites are fixed:

- the Codex message image path (`canonicalToCodexResponsesPayload`),
- the Codex `computer_call_output` screenshot (`output.image_url`),
- the Responses `computerOutputForWire` screenshot.

All three now resolve through the shared `resolveImageSource` normalizer that the
Chat and Responses message builders already used — it was simply never wired into
these three — so every origin shape collapses to a URL, a data URL, or a
`file_id`. An image whose source cannot be resolved is dropped rather than sent
as an object, because a rejected request loses the text too; a bare URL string
payload is passed through unchanged. The one place a screenshot's payload could
not be resolved still stringifies, so the wire type is never violated.

### The in-flight gauge no longer counts requests that never finish

`proxy_in_flight` (the live "in flight request" number on the Requests card, and
the Prometheus gauge behind it) only ever went up. The request lifecycle was
registered on the `/v1` gateway plugin, whose `afterResponse` fires only for a
request that **matched a registered route** — while the counter is incremented by
the root `request` hook, which runs for every inbound request. So an unregistered
`/v1/*` path was counted and never released: measured, one `POST /v1/not-a-real-route`
left the gauge permanently one higher, and a 25-request burst left it at 25,
forever. That made the number meaningless for a real workload and handed an
abuser a way to drive it upward with the cheapest possible request.

The lifecycle (`registerTelemetryLifecycle` / `registerRequestCleanup`) now lives
at the root, where the increment does, so the two are symmetric. A root
`afterResponse` still runs after the matched handler returns, so a dispatch route
finalizes exactly as before; it is registered in one place only, so a matched
route cannot finalize twice. Unmatched `/v1/*` requests now release their state,
their deadline timer, their live-controller entry and their in-flight count.

### Only the gateway's own defects count as errors

Six independent predicates answered "is this request an error?" with their own
copy of `status in ('failed', 'truncated')` — the usage summary, the health
window, the usage breakdown, the durable `telemetry_usage_totals` rollup, the
public share page, and the client-IP breakdown. That let a `404` probe against an
unregistered path, a `499` client abort, and a `503` capacity refusal all raise
the reported error rate, and the rollup made the drift permanent: a request
counted there stays counted after its raw row is pruned.

There is now one definition, `src/observability/telemetry-status.ts`, read by
every site that reports an error count. The rule is a principle, not a list of
codes: **a request counts only when the gateway failed at its own job.**
`failed`/`truncated` plus a `5xx` counts, except `503` (capacity — the gateway
correctly refusing work it cannot do). Every `4xx` is the caller's outcome and
does not count, nor does `499` (a client abort). Excluded requests are still
recorded, still rendered in the Requests table, still filterable, and still
openable in the detail drawer — "not an error" means "not counted against the
gateway", never "not logged".

> **Koreksi.** An earlier version of this entry stated the rule as an enumerated
> list — "not `404`, `499` or `503`" — which was the implementation at the time.
> That list was wrong in principle: it missed `401` and `429`, both free for a
> caller to generate and neither reaching a provider, so a bogus API key could
> still raise the reported error rate. The rule is now the class rule above, and
> `401`/`429` (and every other `4xx`) are excluded.

### The error-count rule is one rule, and the two encodings of it agree

The shared predicate landed with a divergence in it. `isGatewayError` treated a
row whose lifecycle status was outside the enum (`NULL`, or a future state) as an
error, while the SQL form `status in ('failed','truncated')` evaluates to NULL —
therefore *not* counted — for exactly those rows. The SQL form writes the durable
`telemetry_usage_totals` rollup and the row form writes the read-side counts, so
the two disagreed on those rows, and a rollup entry cannot be corrected after its
raw row is pruned. Both now derive from the same constants and return the same
verdict for every `(status, httpStatus)` combination; the SQL is rendered from
those constants rather than restating them as literals. An unknown status is not
counted — "we cannot claim this was the gateway's fault" — and is still recorded
and shown.

Two further sites were still carrying their own copy of the old predicate and are
now on the shared rule: `UsageResponse.requestsFailed` (`/system/usage`) and the
provider-account `errors` column, where the "today" arm reads `telemetry_events`
and the "all time" arm reads the rollup — two different predicates for two numbers
displayed side by side.

### The Overview page no longer polls a usage endpoint it never read

`Overview` called `useUsage()` and wired its `refetch`/`isFetching` into the
refresh button and the spinner, but read none of its data — the page renders
`health.error_count`, not usage. Every open Overview tab therefore issued
`GET /console/api/system/usage` twice a minute, validated the response, and threw
it away. The call is removed, along with the now-unreachable chain it was the only
consumer of: `useUsage`, `assertUsage`, the dashboard's `UsageResponse` re-export,
and the `system.usage` / `system.usageByPeriod` query keys. The backend endpoint
`/system/usage` remains and is still covered — only the dead browser consumer is
gone.

### Removed a dead `data-status` attribute

The Requests filter buttons carried `data-status` for a CSS selector list that the
tone refactor replaced with `data-tone`. No stylesheet, test, or script read it.


The filter buttons were a hardcoded three-entry array (`200 OK`, `499`, `503`)
and the status cell hardcoded `"200 OK"` / `"500 ERR"`, so only `200` ever
carried a reason phrase and every other code rendered as a bare number. The
buttons now render whatever the backend actually reports, labelled
`<code> <reason>` (`404 Not Found`, `503 Service Unavailable`,
`499 Client Closed Request`), with the count after a `·`. The phrases come from
one table in `dashboard/src/lib/http-status.ts` — asserted against the platform's
own `STATUS_CODES` — and the colour tone is derived from the code rather than an
enumerated status list, so a status the gateway newly returns renders and styles
correctly without a CSS edit. An unknown code falls back to its bare digits
instead of inventing a phrase.

### The coverage floor is 90%, and the suite runs in parallel

`scripts/ci-check-coverage.ts` now defaults to `90.0` line coverage over
hand-written backend `src/`, and CI passes the same value rather than a lower
one, so a local `bun run check:coverage` gates identically to the pipeline. The
gap was closed with tests, not by lowering the number: protocol codecs, provider
adapters, console route handlers, and store ownership boundaries gained direct
coverage for the branches they actually decide.

`scripts/ops-run-tests.ts` runs `bun test --parallel` by default. That is safe
because the DB-gated suites were made parallel-correct first:

- `test/integration/oauth-refresh-service.test.ts` ran a table-wide
  `delete(providerAccounts)` in `afterEach`, which deleted every other suite's
  fixtures on the shared isolated database. Cleanup is now scoped to the account
  ids this suite created.
- `test/transport/routing/route-catalog.test.ts` created global providers
  (`tenant_id IS NULL`) whose models carried no `source`, so a backup taken by
  any tenant legitimately included them — and the suite then deleted the
  provider in `afterAll`, leaving a payload that could not be restored. Those
  fixtures now carry the reproducible `source: "builtin"` marker.
- `src/observability/logger.ts` enabled the `pino-pretty` transport whenever
  `NODE_ENV=development`. That transport runs in a worker thread which can exit
  mid-run and take the test worker with it. It is pure presentation, so it is
  now enabled only for an interactive TTY.

### A restore no longer reads another tenant's models

`ownedByFilter`'s `authored` arm selected every `models` row whose `source` was
not the build's marker, without checking who owned the provider. A probed model
under *another tenant's* provider therefore travelled into this tenant's backup
— a cross-tenant read of one tenant's catalog — and a restore of that payload
inserted a `models` row whose `provider_id` the restoring tenant did not own,
which is a foreign-key violation. Authorship now requires the provider to be
shared (`tenant_id IS NULL`) or the tenant's own, matching what the ownership
contract already documented.

`mergeResponsesUsage` also declared its parameters as `Record | undefined` while
its own comment documented `"usage": null` frames from some bridges. The type
now says `null`, which is the shape the function already handled.

### The `native` wire family is retired

`native` was never a protocol. It marked a row served by a bespoke adapter —
Cursor (Connect+protobuf) and Devin (gRPC) — that frames its own wire by hand
and has no canonical codec. Sitting in the same enum as `chat`/`responses`/
`messages` made it an operator-selectable choice, and a request on it died
inside the codec with an untyped `unsupported wire family: native` rather than a
typed gateway error.

The fact it carried now lives where it belongs: `bespokeWire` on the provider
declaration in `provider-metadata.ts`, surfaced into the route snapshot as
`capability_profile.bespokeWire`. Two behaviours follow from it, both preserved
exactly — a bespoke route gates rich content on its declared modalities instead
of assuming codec coverage, and it receives generation controls unfiltered
because no codec is involved to re-encode them. The operator vocabulary is now
the three real protocols, and the selector no longer offers a wire that cannot
work.

`0001_retire_native_wire_family.sql` folds existing `native` rows onto `chat`
and rebuilds the enum; it is retry-safe and a no-op once applied.

### A manually added provider can be tested against any protocol

> **Koreksi.** The wire-family gate used to be described here as a safety
> boundary that stopped an operator from driving a provider onto a wire it does
> not serve. That framing was wrong. A manually added provider exists precisely
> so an operator can reach an upstream protocol this gateway carries no bundled
> knowledge of, and the gate made that impossible: dispatch answered
> `capability_unsupported` (`workbuddy supports only wire family "chat", got
> "messages"`) before the request was ever sent, so the upstream never got to
> answer for itself.

Dispatch no longer gates on wire family. `supported_wire_families` is removed
from the adapter config and every provider spec; `supportedWireFamilies` remains
as published metadata (registry paths for built-ins, the BYOK profile for custom
rows) and the Add-Model wire selector now uses it to order the choices rather
than to lock them — every family stays selectable, with the provider's own
families first, and a note explains when the chosen wire is outside the declared
set. The dashboard no longer hides the selector when a provider declares a
single family.

The discovery gate is unchanged for derived sources and deliberately exempts an
explicit pick. A stored row, a bundled catalog row, or a generic `/models` guess
is a cache of the derivation, not an authority, so `constrainWireFamily` still
corrects those to the provider's declared contract. But
`ProbeModelRequest.wireFamily` is the operator naming the wire themselves, so it
now passes through untouched — previously it was silently rewritten to the
provider's first declared family, which is what made the selector look like it
worked while probing a different wire than the one chosen.

### Dashboard styling layers and session-aware console entry

All dashboard apps share `dashboard/src/styles/base.css` for Tailwind, tokens,
resets, and primitives, then load one extension (`console.css`, `landing.css`,
or `share.css`) directly. Settings backup choices use consistent selectable
panels. Landing offers All view, a GitHub link before it, and no auto-scroll;
its Console links enter the session-aware `/console` route instead of forcing
a fresh login.
The public Share HUD retains the current enrollment and key-issuance flow
without a decorative page background or a separate HTML document.

### Tracked baseline is the only current migration

> **Koreksi.** The earlier startup-migration note treated the root `migrations/`
> directory as disposable; it contained hand-run SQL that startup never read.
> That was wrong. The tracked root directory now holds `0000_baseline.sql`, the
> complete schema for a fresh database, alongside the numbered forward
> migrations added since. Backend initialization runs its numbered SQL from this
> directory; the separate
> `db:migrate` command and setup-time migration invocation were removed.
> Future changes add a numbered SQL migration here for existing databases.
>
> **Koreksi.** The sentence above said the directory contains "only
> `0000_baseline.sql`", which was true when written and stopped being true as
> forward migrations landed beside it. The baseline is the only *baseline*; it
> is not the only file.

### Claude Code tool results reach Codex

When a Claude Code Messages session continued through Codex, the Messages
ledger placed each `tool_result` on a canonical user turn, but the Codex
Responses encoder emitted `function_call_output` only from tool-role turns.
The upstream received the `function_call` without its output and rejected the
next turn with HTTP 400. Codex now emits matched output items from either role,
preserving the original `call_id` and tool-result order.

### Pricing falls back to the model's own global rate

A reseller gateway that republishes a model without publishing its own rate was
recorded at `$0.00`, because pricing used the same fail-closed provider lookup as
metadata. That is right for limits — a wrong context window is harmful — but
wrong for cost: a paid model billed as free understates spend and hides it from
the operator. `costFor` now falls back to the rate the catalog records for the
model itself, whichever provider filed it, with the most frequently published
price winning and a tie resolving to the dearer rate so a free-tier row cannot
make a paid model look free. A dated snapshot also reaches the undated rate
(`claude-3-7-sonnet-20250219` → `claude-3-7-sonnet`), since a snapshot bills the
model it snapshots. Metadata stays provider-specific and fail-closed.
This took unpriced models across the bundled providers from 286 to 50; the 50
remaining are ids models.dev does not list at all (`qoder` internal codenames,
`cursor` `default`/`composer-*`, `perplexity-search`), which stay unknown and
count toward the console's `partial` flag.

### An unpriced turn is `null`, not a measured `$0.00`

`estimated_cost` was typed `number`, so "the catalog has no rate for this route"
collapsed into `0` — indistinguishable from a genuinely free turn. The console
already counted completed rows with no cost toward a `partial` flag, but no
writer could ever produce that null, so the flag was dead and every unpriced
route read as a measured zero. `estimated_cost` is now `number | null`, and the
dispatch estimate, the failover commit, Devin's usage builder, and
`repriceUsage` all leave it `null` when unpriced. The telemetry writer persists
NULL instead of `String(null)`, and the analytics summary reports `partial`
again.

### Usage cost now prices the input side

`calculateEstimatedCost` accepted an `inputTokens` field it never read, so the
input rate was applied only through `uncached_input_tokens` — which is
`"unavailable"` whenever the upstream reported no cache breakdown, the common
case. Every cache-less turn therefore priced its output alone: a million prompt
tokens on `gpt-4o` recorded $5 instead of $7.50. The uncached count now falls
back to `inputTokens` when the breakdown is absent, while a real cache
breakdown still bills cached and uncached at their own rates.

### Claude and Gemini models are priced again

The billing catalog resolves pricing through an exact `provider:model` key, and
two bundled providers filed under a different key than their runtime id. `claude`
(display name "Claude Code") declares the same `baseUrl` as `anthropic` —
`https://api.anthropic.com` — and `gemini` declares Google's own
`generativelanguage.googleapis.com`; both are the same upstream as their catalog
key, not look-alikes. Neither was mapped, so the exact lookup missed and the bare
fallback failed closed on disagreement: **15 of 16 Claude models and 5 of 6
Gemini models priced at zero**. Both are now mapped, with the reseller-style
gateways (`codex`, `grok`, `antigravity`, `cb`, `qoder`, `commandcode`,
`inferhub`, `tokenharbor`) still deliberately absent — a shared model id is not
proof of a shared price.

### Responses compaction records a real cost

The native Responses-compact route committed `estimatedUsage(...)` without
repricing it, so every compaction recorded `estimated_cost: 0`. It now runs the
estimate through `repriceUsage` against the routed model, like the other dispatch
paths, and the `TRANSPORT.md` note that claimed it "deliberately keeps the
estimate" is corrected.

### Abuse admission costs one Redis round trip per request

The per-IP abuse check read the ban, incremented the route window, and
incremented the identity-wide escalation counter as three separate Redis calls
(four once a ban fired). They are now one static Lua script over the three keys,
so an admitted request is a single round trip and a banned one still is. The ban
is read first and short-circuits without writing, so a banned identity cannot
extend its own counters. The two counters stay separate — admission per
`(identity, route)` for fairness, escalation per identity so rotating the path
cannot dodge the ban — and the ban marker carries its duration as its own TTL.

### A one-time (lifetime) token budget is no longer refunded on an unreported turn

A provider that omits its usage frame left the decoder normalizing an empty
payload into a record of zeros. That record is not `undefined`, so
`terminal.usage ?? estimatedUsage(...)` never fell through to the conservative
estimate — the turn reconciled to zero and refunded its whole reservation. A key
with a one-time token budget could therefore be replayed indefinitely: the
lifetime counter never grew. Decoders now hand the raw payload to
`usageFromProvider`, which returns `undefined` when nothing was reported (an
absent frame, `usage: {}`, or an all-zero shape — no real request has zero prompt
tokens), so absence stays absence to the dispatch fallback. The Messages and
Codex decoders already behaved this way; chat, responses, cloudflare, qoder,
perplexity, gemini, antigravity, and commandcode now match.

### `retry-after` reports the measured wait, not a fixed value

Three surfaces answered a rate-limit or lockout with a constant. The console
login route returned a hardcoded `3600` for every lockout, so a client whose
lock had seconds left was told to wait a full hour again;
`ConsoleLockoutService.remainingLockSeconds` now reports the real shrinking
remainder. The per-IP abuse middleware returned `3600` for every 429 — a
60-second window included — so the store now measures the remainder (a ban's
marker TTL via `PTTL`, or the age of the oldest attempt in a rate-limited
window) and carries it as `retryAfterMs`. The pool `at_capacity` 429 no longer
asserts a fabricated `1000ms`; it keeps the documented one-second floor every
evidence-free 429 already received.

### A gateway wiring defect reports `internal_error`, not `invalid_request`

Three provider-registry guards (adapter/registration id mismatch, non-normalized
registration id) threw `invalid_request` with a 500 status — a client-error code
paired with a server-error status, which told the caller to fix a request it
could not change. They now throw `internal_error` (500), the honest code for a
misconfiguration the client has no part in. `internal_error` is added to the
stable `GatewayErrorCode` union and the `TRANSPORT.md` table, and it is
deliberately not retryable: a byte-identical retry cannot fix wiring.

### Token-budget counters no longer leak in Redis

`admission:lifetime:*` is the only thing bounding a key's lifetime token total,
and two writes dropped that bound. The reserve script seeded a missing counter
with a plain `SET` and no TTL, and the reconcile script wrote every bucket with a
plain `SET`, which replaces the key and strips the expiry the reserve had just
armed. A counter with no expiry is never reclaimed, so the total leaked for the
life of the deployment; a *rejected* reserve leaked it too, because the seed runs
before the budget check that returns early. The seed now carries its TTL and
reconcile adjusts with `INCRBY`, which preserves it.

### Route and pool inflight slots share one crash-recovery TTL

Routing admission expired its per-account inflight key after a hardcoded 60
seconds, while the network-pool selector derived its own from the upstream
deadline plus the stream stall budget. A stream running longer than a minute
therefore lost its slot mid-flight and a second request could admit against the
freed slot, exceeding the configured ceiling. Both now use
`resolveInflightTtlSeconds()` — 600s at the defaults — so raising either timeout
keeps them in step.

### Telemetry retention prunes in bounded batches

The retention sweep deleted every aged `telemetry_events` row in one statement.
On a long-lived deployment that statement grows without limit, and once it
exceeds the pool's `statement_timeout` it is cancelled and the sweep never
converges, so retention silently stops working. Aged events are now removed in
bounded 5000-row batches that commit independently, mirroring the payload
sweeper, so progress survives a cancel or a restart.

### The flat model catalog reads the catalog once, not per provider

`listFlatModels` called `listModels` for every provider, and each call was two
queries, so the picker's cost grew with the bundled provider count. One grouped
read now serves the whole tenant: a tenant with 50 providers issues 2 queries
instead of 100, and the count is constant as providers are added.

### The cooldown sweep prunes model cooldowns in one statement

`sweepExpiredCooldowns` selected every account holding a cooldown and then
issued one `UPDATE` per row, all inside one transaction. It now recomputes the
pruned object in a single set-based `UPDATE`, so the sweep's cost no longer
grows with the number of throttled accounts and its locks are held for one
statement instead of many.

### The orphan `backup_status` table is gone

`backup_status` existed only in the baseline SQL: no Drizzle definition, no
reader, no writer, and absent from the backup feature's own table lists, so a
fresh install carried a table nothing could touch. It is removed from the
baseline and dropped from existing databases by
`drizzle/migrations/manual/0012_drop_backup_status_table.sql`, with a contract
test asserting the baseline cannot reintroduce it.

### Shared API-key templates enroll non-authenticating child keys

API keys can be personal or share templates. Templates store no authentication
hash or recoverable secret; public enrollment issues one child key per globally
unique canonical trusted client IP and reveals its secret once. Owners can
revoke children and view masked-IP, model, request, error, and token telemetry.
Revoking a template or converting it to personal mode revokes its children and
enrollment links. The landing page, console, and share enrollment now use one
dashboard index while share styling remains isolated.

### Provider accounts expose concurrency limits and usage

Operators can set a per-account in-flight ceiling that overrides tenant/provider
routing defaults, with an empty value inheriting the configured default. Account
rows also show UTC-today and durable lifetime request/token totals. Lifetime
totals are initialized from telemetry still retained at rollout and continue
after raw telemetry retention expires.

### Provider probes use an internal marker instead of a probe User-Agent

Provider dispatch probes carry `Cartethyia-Probe` only in their internal
dispatch context and telemetry. A shared probe-fetch wrapper removes
`User-Agent` before upstream requests, including discovery, BYOK connection
tests, and API-key connectivity checks.

### Codex turn metadata has one serialized form

The request header and `client_metadata` body carry the same turn metadata.
Codex dispatch now builds that JSON once and reuses it at both wire locations;
the outbound request test pins their byte-for-byte equality.

### Backup routes no longer advertise a credential that cannot use them

`BACKUP_SCOPES` listed `providers:write` on the stated grounds that a tenant API
key could script a backup. It cannot: both actions re-authenticate by verifying
the operator's password against their session's user row, and a key carries no
session, so a key reaching the route failed one step later with "password is
incorrect" instead of at the scope check. The list now names only
`dashboard:write`, and tests pin that a `providers:write` key, a
`routing:invoke` key, and an unauthenticated request are each rejected before any
export runs.

### A pool with no cooling providers no longer fails its own overview

The Proxy page reported "Failed to load network pools". The read batches every
cooling provider into one `MGET`, and `MGET` with no keys is a Redis error — but
a healthy pool lists no cooldown members, so the empty call is the *common* case,
not an edge one. Every pool overview therefore failed with `ERR wrong number of
arguments for 'mget' command` whenever nothing was throttled. The empty case now
returns an empty list without the round trip, and the test double rejects a
zero-key `MGET` the way Redis does, so a double can no longer hide this.

### Catalog scopes no longer include `dashboard:write`

The catalog scope lists were `["dashboard:write", "providers:write"]`, which
made `dashboard:write` imply the ability to add an upstream or delete a model —
the exact thing the scope model says it must not, and reachable in practice
because a tenant API key may hold `dashboard:write`. The lists now hold only the
catalog scope, and the console session is granted the catalog scopes by name
(`consoleSessionScopes`) because the dashboard is the operator and must keep
working. A regular console user keeps its read-only ceiling. Covered by tests
over five principals, including that a `dashboard:write`-only key is rejected.

### A restore no longer deletes rows the payload never described

Restoring a payload that named a table and declared it empty emptied that table.
A config-only file carrying `provider_accounts: []` — a router export with no
connections, an export taken before any account existed — ran a table-wide
`DELETE` before inserting nothing, so an operator's accounts disappeared and the
dashboard showed "No accounts connected". The file's silence was being read as an
instruction to delete.

Two things were wrong, and both are fixed. The clear was **not scoped to the
restoring tenant**: `providers` and `models` hold the shared built-in catalog and
`provider_accounts` holds every tenant's accounts, so the delete reached far
outside the tenant that ran it. Ownership is now declared per table
(`ownershipOf`), and a restore clears only rows the restoring tenant owns; a
table with no declared owner throws rather than falling back to clearing it. And
the clear **ran for a table with zero rows in the payload**: an empty array
describes nothing, so it now clears nothing. A non-empty array still replaces the
tenant's rows, which is what "restore my configuration" means.

The regression test replays the exact payload shape against a real database and
asserts the tenant's accounts survive; it fails on the account count (1 → 0) with
the fix removed, reproducing the incident rather than a compile error.

### Backup and restore, and importing a router export

`GET /backup/export` writes the tenant's configuration and telemetry metadata as
plain JSON; `POST /backup/import` restores one, auto-detecting whether the file is
our own backup or a router export. Both re-authenticate the operator's console
password, because an export is every provider credential and API-key hash in the
clear and an import replaces it — a stolen session cookie must not be enough to
walk away with the secrets or overwrite them.

Two sections, and the split is the point: `config` (where traffic goes, with
which credential) and `telemetry` (per-request status, tokens, cost, latency).
`telemetry_payloads` — captured prompt/response bodies — is never exported and
never restorable, so a backup is not a substitute for a database dump. Config is
replaced (for the restoring tenant's rows only, and never for a table that mixes
in other tenants' rows or rows the payload omits); telemetry is merged, never
deleted, so re-importing the same file does not double-count history. Everything
runs in one transaction, and nothing is written until the whole payload
validates against the live schema.

The importer never guesses and never drops silently: a provider id with no
counterpart is skipped with a named reason rather than mapped onto something that
merely looks similar, and everything not imported is reported. Credentials are
re-encrypted with this instance's key.

Restored history is still subject to `CARTETHYIA_TELEMETRY_RETENTION_DAYS`, so
rows older than the window are pruned on the next sweep; retention is a
deployment decision and is left alone, and the report says so rather than letting
a successful-looking restore quietly empty.

### Catalog writes over an API key, on their own scopes

`providers:read`/`providers:write` and `models:read`/`models:write` join the scope
union, so a key can register a BYOK upstream or add a model without a browser
session. They are deliberately separate from `dashboard:write`: a key minted to
read usage, or to change a display setting, must not thereby be able to add an
upstream or delete a model, because those writes change where traffic is sent and
which credentials are used. The console router resolves a bearer key through the
same authorization path `/v1` uses, so the catalog operations have one
implementation and two auth paths.

### Discovery stops inventing limits for providers models.dev files elsewhere

`/v1/models` reported `200000`/`64192` for 64 of the 80 models `opencodeft`
serves. The upstream states no limits at all — its `/zen/v1/models` response
carries only `id, object, created, owned_by` — so every entry fell through to
the offline models.dev snapshot, and that lookup missed: Cartethyia calls the
provider `opencodeft`, while models.dev files those rows under `opencode`. The
exact lookup never matched, the bare fallback correctly refused to answer
(because many providers carry the same id and disagree), and the entry was
published with the fallback floors. A 1,000,000-token model was advertised as
200,000, which is the number a client uses to decide whether its request fits.

`MODELS_DEV_PROVIDER_IDS` now maps the ids that genuinely differ
(`opencodeft`/`opencodezen` → `opencode`, `opencodego` → `opencode-go`,
`ollamacloud` → `ollama-cloud`, `xiaomipg`/`xiaomitp` → their Xiaomi token-plan
rows). The lookup tries the id as given first and the mapped name second, so a
provider the catalog already carries under its own id still wins. Only ids
backed by the deployment's own upstream are mapped: a match resting on shared
model ids was rejected, because the same generic id appears under hundreds of
resellers and a guess would attribute a stranger's limits — the failure the
bare-id disagreement rule exists to prevent.

The snapshot itself was four days stale and had lost rows the catalog now needs,
so `scripts/ci-generate-models-dev-snapshot.ts` re-downloads models.dev and
rewrites it (2.0 MB, 8,126 rows across 223 providers, minified like before).
Precedence is unchanged and now documented: upstream first, then the catalog,
then the floors. models.dev remains authoritative for pricing — an upstream
`/models` response rarely states a price — with limits as a secondary source.

### Alias entries report the limits their target actually has

`/v1/models` described every alias with the same `200000` context and `64192`
output tokens, no matter what it routed to. The metadata lookup only read ids
shaped `provider/model`, so a target that is a *combo* name — the common case,
since an alias usually fronts a pool — was discarded and the entry fell back to
invented defaults. A pool whose members serve 1,048,576 tokens was advertised as
200,000, which is the number a client uses to decide whether its request fits.

The walk now follows the same chain dispatch follows: alias → combo → member,
recursing through members that are themselves aliases or combos, bounded to 16
hops to match the engine's `resolveAlias`. An entry advertises the minimum
across the catalog rows it can reach, and only the modalities every member
shares, because dispatch may pick any of them. The three aliases on the local
deployment now report 1,000,000/384,000 and 1,048,576/131,072 — the values in
the catalog — instead of the shared defaults.

### Discovery shows an alias, not the providers that share its name

A key allowlisted to three aliases also saw four provider rows on `/v1/models`.
The shadow filter in `PublicModelCatalogStore` compares a catalog row against
the allowlisted alias, but it compared the row's full `modelId` only. A provider
that nests a path inside its own model id (`cline-free/deepseek-v4.1-flash`,
`ali/deepseek-v4.1-flash`) has the alias's bare name and a different full id, so
it escaped the filter and was published as a separate, selectable model on a
provider the operator never named. Rows whose `modelId` is already bare were
correctly hidden, which is why the leak looked partial rather than total.

Both sides are now compared by bare name as well as full id, and the same
applies to combos. An explicitly qualified allowlist entry still wins — naming
`workbuddy/glm-5.3-flash` remains an unambiguous grant of that exact row. The
filter is covered by a DB-backed regression test on the real `listPublicModels`
boundary, including the nested-id shape that caused the leak.

### Share pages advertise the origin that serves them

A share page reached through a tunnel told its recipient to call
`http://127.0.0.1:12800`. The Base URL card copied the value the gateway sent,
and `configuredOrigin` preferred `CARTETHYIA_PUBLIC_ORIGIN` — a variable pinned
to the OAuth redirect host, which is a loopback address in a local deployment —
over the origin the page was actually reached by. The `publicOrigin` option that
could have overridden it was never passed at its one construction site, so the
loopback branch always won.

The gateway cannot know that origin: a tunnel, a reverse proxy, and the OAuth
host can each differ from what the request reports. The browser is the only
party that knows for certain, so the share payload no longer carries an origin
at all and the share app derives the Base URL from `window.location.origin` —
the same source the `/v1` hint beside it already used. A regression test pins
the loopback case on both the payload and the rendered page.

### Client-version pins refreshed, and their sources documented

Every CLI/IDE impersonation pin in `operations/client-versions.ts` was re-read from its upstream source
rather than left to age. The stale ones were the pins that decide the `User-Agent` and version headers an
upstream gates on, so a drift there is a request rejected with "please make sure you're using the latest
version" rather than a visible error. `clineClient`'s `minVersion` floor moved with its fallback — the two must
travel together, or discovery can accept a version the provider has already stopped serving.

Two pins outside that table moved as well: the Antigravity client version (its electron-builder manifest now
reports a 2.x line well past the pinned value) and the Devin/Windsurf IDE and extension pair, which ship
together.

The lookups are now recorded in `PROVIDERS.md` — one row per entry, with the URL, the field read, and the
reason two entries cannot be fetched at all (`claudeSdk` lives inside a compiled binary; the Devin/Windsurf
update endpoints are private, so the IDE version comes from the release-notes page the download site links to,
and the extension version from the Marketplace query API). Refreshing a pin is now a fetch instead of a hunt.

### Error taxonomy: one status table, honest attribution, and a named context overflow

The public error codes were measured against three other gateway
implementations and audited against our own source. Six
gaps were found; four of the ideas found there were rejected on their merits
(substring classification, empty codes, contradictory tables, cooling a
credential for an unclassified failure). Two premises in the original analysis
were wrong and are corrected here rather than quietly dropped.

**Correctness — a client could not tell whose fault a failure was**

- An explicit error frame inside a `200 OK` was recorded only as a terminal
  `state: "failed"`, which `terminalFailure` rewrites to `transport_unavailable`
  (502, origin `cartethyia`). Three things were wrong with that. The client was
  told the *stream* failed when the upstream had named its own reason. The
  provider was never cooled down: `shouldCooldownPool` needs an
  `origin: "upstream"` 429, so a rate-limited provider kept being dialed. And
  because `pool-health-machine.ts` treats `transport_unavailable` as a pool
  fault, the **network pool was degraded** — blaming the egress proxy for the
  provider's rate limit. The chat, responses, and codex decoders now classify
  the frame through one shared `stream-error-frames.ts` classifier (the Claude
  and Gemini decoders already raised), so a rate-limit frame becomes
  `quota_exceeded` (429, provider-scoped), an overload frame becomes
  `platform_unavailable`, and a named overflow becomes `context_length_exceeded`.
  A frame that declares a failure with nothing recognizable becomes
  `platform_unavailable` rather than `invalid_request`: blaming the client for
  the provider's problem invited an identical retry. Classification reads
  structured identifiers only, never prose — a substring rule on a word like
  "capacity" fires on any message containing it, including text the client
  itself wrote. Each decoder's catch block now rethrows a `GatewayError`
  unchanged; without that, the classification was rewritten as a malformed-SSE
  failure and the code was lost anyway.
- 28 sites labelled upstream protocol corruption as `invalid_request` (502).
  A malformed SSE event, an empty stream, a body that is not JSON, a Claude
  stream that ends before `message_stop` — all told the client *"your request
  is invalid"*, so a well-behaved client retried a byte-identical request
  against the upstream that was already broken. These are now
  `platform_unavailable` (502) with `origin: "upstream"`. The origin move is
  part of the fix, not decoration: `ingress.ts` prefixes a `cartethyia`-origin
  message with "Cartethyia Error:", which blamed the gateway for the provider's
  bytes — the same defect the HTML-error-page guard already corrected.
- There were **two** status→code tables, not one, and they disagreed. The
  second (`statusToErrorCategory`) mapped every upstream 5xx to
  `proxy_unreachable`, so the generic path used by seven providers reported a
  provider outage as "network proxy was unreachable" (the console's own
  wording). It also mapped 529 to a non-retryable code while the first table
  mapped it to a retryable one. Both callers only ever re-derived a code from
  it, so it is deleted and every caller reads the one table.
- `codex-errors.ts` pinned every non-auth/rate/proxy status — 5xx included — to
  `invalid_request`. A Codex upstream 500 reached the client as "your request
  was invalid" and telemetry recorded a client fault for a provider outage.
- `qoder.ts` kept a private copy of the mapping that sent every 5xx to
  `proxy_unreachable`. Because `pool-health-machine.ts` treats that code as a
  pool fault, a Qoder upstream outage **degraded the network pool** and could
  disable it — punishing the egress proxy for the provider's failure.

**New contract — one code, no synonyms**

- `context_length_exceeded` (413) names a request that exceeded the model's
  context window, which previously arrived as a bare `invalid_request` with no
  way for a client to know it should shorten the prompt. Detection reads the
  structured `error.code` / `error.type` identifiers only
  (`isContextLengthFailure`); prose is never matched, so an upstream that
  reports overflow only in a sentence keeps its generic code. A false "your
  prompt is too long" is worse than a missing one — it tells the client to
  truncate a request that was fine. `providerStatus` preserves the literal
  upstream status when the envelope is normalized to 413.
- `retry-after` is emitted on every response that carries real wait evidence
  (`retryAfterMs`, or `retryAt` converted to seconds), not only on a literal
  429. Several retryable failures are 503 (`admission_unavailable`,
  `proxy_pool_*`), and the client had no way to learn when to return. A 429 with
  no parsed evidence keeps its one-second floor; nothing is invented when there
  is no evidence at all.

**Documentation**

- `TRANSPORT.md` now documents all 29 codes with status, origin, retryability,
  and meaning, replacing a partial list that named 12 and omitted every status.
  `PROVIDERS.md`'s Qoder paragraph was corrected to match the shared table.

### Second cleanup pass: a stranded concurrency slot, a dropped model, and the last duplicates

The previous pass left a backlog. Re-verifying every one of its items against the
current source (rather than trusting the notes) found that most were already
done and several premises were simply wrong, but it also surfaced two real
defects and a set of round-trip regressions.

**Correctness — these were wrong, not merely untidy**

- A crashed request's concurrency slot could never be reclaimed. The Redis
  admission lease key's own TTL was set to exactly the `expires_at` horizon the
  lease hash recorded, so Redis evicted the hash at the same moment the sweeper
  became allowed to read it: `HGET state` returned nil, the sweep skipped every
  lease, and a process that died between reserve and release left its
  concurrency and tenant-concurrency slots held. Because every later
  reservation re-arms the counter's own TTL, a key still in use never recovered
  them. The key TTL now exceeds the reap horizon by a grace window. The
  existing sweeper test could not see this — its fixture kept every hash alive
  forever — so a new contract suite runs both stores against the same
  invariants with a Redis double that models eviction honestly.
- `grok-4.7` was dropped from live model discovery. The discovery allowlist in
  `default-registry.ts` accepted only `grok-4.5`/`grok-4.6` while `GROK_MODELS`
  and the request builder both served `grok-4.7`, so an upstream that advertised
  it had the model filtered away. Both the discovery filter and the
  reasoning-effort check now derive from `GROK_MODELS` instead of restating it,
  which is what let the lists drift apart in the first place.
- The Claude quota 429 cooldown never activated. `claude-quota.ts` compared
  `quotaCooldown.get(key) ?? 0 > now` — an absolute future timestamp against
  `0` — so a rate-limited credential was retried into the limit on every call.

**Performance — round trips removed from hot and periodic paths**

- The admission `purge` (key revocation) issued one `HGET` per lease while
  scanning; it now pipelines one round trip per scan page.
- The pool selector read cooldown entries with one `GET` per member; it now
  issues a single `MGET`.
- The quota refresh sweep resolved each account's cache age with one Redis round
  trip per account; it now batches per lens through the cache's own reader, so
  the key format stays owned by the cache module.
- Model discovery inserted discovered models one row at a time; it now batches.
- `checkAvailable()` ran a `PING` before every admission and IP-abuse check, on
  top of the atomic script that already fails closed. Both probes are gone:
  the store operations surface their own failure and the service maps it to the
  same bounded `admission_unavailable`.

**Schema**

- `telemetry_events (api_key_id, created_at)` had no index, so every render of a
  public share page aggregated the largest table in the schema with a scan.
  Added to `schema.ts` and to the baseline. Existing databases need a forward
  migration; the runner reads only top-level numbered SQL files and never read
  the hand-run path this entry originally named, so a database created before
  this change converges only once that migration exists.

**Single owners and duplicates removed**

- `Counter` and `Gauge` duplicated their sample store, cardinality guard, `inc`
  accumulation, and rendering byte for byte; both now extend one base, with the
  rendered exposition unchanged.
- `openaiCacheControl` is deleted. Its ≤4-breakpoint check was already
  superseded by `validateCacheBreakpoints` at the preflight boundary (a typed
  400 before admission), and its 1024-visible-token minimum was never supplied
  by any production caller, so it enforced nothing. The rule it documented is
  gone with it.
- The last three hand-assembled terminal envelopes (in the Codex and Claude
  Messages decoders) now use `canonicalTerminal()`; the helper omits fields
  rather than emitting `undefined`, so the wire bytes are unchanged.
- Eight copies of the `output_index` coercion became one `readOutputIndex()`.
- Three copies of the source-tree walker became `test/helpers/source-tree.ts`
  (`token-saver.test.ts` keeps its deliberately broader variant), and one
  duplicated SSE `collect` moved to the shared fixture.
- `formatTokens` had two implementations with different signatures; the
  dashboard now owns one numeric version.

**Fixed a structural test defect**

`test/transport/streaming.test.ts` declared a `describe` that contained no tests
at all and wrapped a second `describe` of the same name, so seven tests ran under
a misleading label while `streamOf`/`collect` were each declared twice. Renamed
and hoisted; all ten tests still run.

**Tooling**

- `.claude/` is now gitignored. `git add -A` would otherwise stage entire
  duplicate repository trees from agent worktrees.

### Whole-tree cleanup: single owners, dead paths, six correctness fixes

A read-only audit of every `src/` layer and the dashboard produced 88 findings; a
second pass refuted three and corrected six before any code moved. The result is
one owner per concept, plus the correctness bugs the duplication had been hiding.

**Correctness — these were wrong, not merely untidy**

- In-memory admission budgets never rolled over. `InMemoryAdmissionCounterStore`
  (the `REDIS_MODE=single_instance_local` production mode) keyed its daily and
  monthly counters by api key alone, with no date bucket and no reset, so a key
  that exhausted its daily budget on day one was rejected every day after,
  forever. The Redis store avoided this by putting the bucket in the key; the
  in-memory store now does the same and records the bucket keys on the
  reservation — mirroring how the Redis lease hash stores them — so a request
  spanning midnight settles the bucket it actually charged.
- The Redis-less mode could not boot at all. `main.ts` threw when `redis` was
  undefined, while `readiness.ts` treats `single_instance_local` as "Redis not
  configured". `ProductionAppDeps.consoleApi` is now optional and the console
  mounts only when a Redis client exists, so that mode serves `/v1/*`, `/health`
  and `/metrics` with no console surface.
- First-boot setup skipped its advisory lock. A `typeof` probe fell through and
  ran the tenant, administrator and gateway-key creation unserialized when the
  handle could not take the lock. It now fails closed.
- Two ad-hoc health writes bypassed the health machine in
  `providers/discovery/probing-service.ts`. Both wrote `status: "degraded"` with
  `cooldownUntil: null`, clobbering the cooldown the classifier had just computed
  and parking the account in a state nothing recovers from. The second fired on a
  regex over the model's own answer text, so any probe whose sample contained
  "202" degraded the account.
- A registry failure was reported as "no adapter registered": `void error` threw
  away the cause and turned a real failure into a configuration-shaped message.
  The typed error now propagates.
- `scripts/build-icons.ts` broke a clean-checkout `bun run typecheck`
  (`TS2307: Cannot find module 'sharp'` — an undeclared dependency, an input
  directory that no longer exists, and committed outputs). Removed, with two
  other unreferenced scripts.

**Cold start**

- Boot blocked on two live network fetches before `getDb()`, holding the listener
  for up to the 4 s fetch timeout on a blackholed network while the pinned
  fallback was already serving correctly. Discovery is now fire-and-forget after
  the listener. `RUNTIME.md` documents the real boot order.
- The boot seed ran 72 sequential statements; each seeder is now one upsert.
  Verified against a real database that an operator's custom compatibility key
  still survives a re-seed.

**Security**

- The session cookie was marked `Secure` whenever `NODE_ENV=production`, so a
  plain-HTTP self-host looped the login page with no error. It is now keyed on
  `CARTETHYIA_PUBLIC_ORIGIN`; the per-request upgrade for TLS and trusted proxies
  is unchanged.
- `retry-after` reports the real remaining lock instead of a hardcoded 3600, and
  `bun run doctor --reset-lockout <user> <ip>|--all` is the operator escape hatch
  that did not exist.
- `/auth/refresh` had no caller anywhere — the dashboard referenced it only in an
  exemption list — yet carried two live CSRF and mutation-throttle exemptions.
  The route, `refreshSession`, `store.refresh` and both exemptions are gone.
- CLI-tool configs no longer require pasting a raw secret. The console already
  stores a recoverable AES-256-GCM copy; `console/cli-tools/secret-source.ts`
  resolves it server-side from a key id, tenant-scoped, failing loudly
  (`api_key_unresolvable`) for a key with no recoverable copy instead of emitting
  a blank token. `POST /cli-tools/:toolId/apply` reports which delivery paths ran
  (`file` / `remote` / `both` / `none`), so a guide tool with no injectable config
  no longer claims a file write.

**One owner per concept**

- One record guard. `object` (41 uses) and `isRecord` (169) were byte-identical;
  `isRecord` now lives in `protocol/primitives` and 30 files migrated. That also
  removes a cross-layer cycle — `protocol` had been importing the guard from
  `transport/surface`, which imports from `protocol`.
- One terminal envelope. Eight hand-assembled copies became `canonicalTerminal()`,
  typed against a named `CanonicalTerminalEvent`, which removed five redundant
  casts with it.
- One terminal→error mapping. The streaming and non-streaming dispatch paths had
  drifting wording for the same conditions; `terminalFailure()` owns it now.
- One completion context. `completionContext()` replaces three copies of the same
  twelve-field literal, so a field added for one path cannot miss the other.
- One console error hook. 95 handlers wrapped their body in the same
  `try { … } catch { errorResponse(…) }`, 22 of them with the same message in one
  file. A group-level `error(consoleErrorHandler(msg))` produces the identical
  envelope, including `ValidationError` → 422.
- One tenant guard: eleven identical six-line access blocks in `account-quota.ts`
  became one line each, with the scope still explicit at every call site.
- One formatter set. Four `formatBytes` copies disagreed on the unit threshold,
  the decimal count and the placeholder, so the same byte count read as "0 MB" on
  Overview, "1536B" in Studio and "—" in Usage. `dashboard/src/lib/format.ts` owns
  bytes, duration, uptime and number.
- One wave scheduler (`runGrowingWaves()`), one provider-account invalidation
  helper, one clipboard hook, one modal focus contract (the Drawer re-implemented
  what `useModalFocus` already owned), one `ledgerKey`, one `isUniqueViolation` at
  the persistence boundary, one `REASON_META` table (three of the four originals
  were rebuilt per rejection), one `completeRequiredSchema`, one
  `stripEndpointBasePath`, and one `jsonResponse`/`streamOf`/`collect` for tests.

**Performance**

- `CompletionStreamEncoder` kept every canonical event and rescanned the array per
  text delta — O(n²) over a long completion — while retaining the whole response.
  It tracks three scalars.
- `liveProviderUpstreamHosts` returned a hand-rolled Map facade that allocated a
  fresh array per lookup on the dispatch path. It is a live closure over the
  registry's own map.
- The Usage page re-read the same preferences row per request on the list, detail
  and breakdown paths; it goes through the revision-cached reader.
- The Usage analytics queries no longer poll in a background tab, so a dashboard
  left open does not hit the gateway forever.

**Removed as dead**

`preContentEvents`/`attemptEventStart` (write-only), the `AsyncIterable` encode
overload and `encodeResponsesStream` (zero callers), the `canContainToolResult`
re-export shim, `reconstruct()`, `assertBounded`, `stateStore.delete()`,
`attemptDailyCheckin` + `resetDailyCheckinLedger` (four tests migrated to the
growth pass), the `ci-fixtures` test island (705 lines), `TtlCache.has`,
`isSecretKeyName`'s options object, `getCount` from the IP-abuse store contract
and its Redis implementation, `CLAUDE_OAUTH_*` and `CODEBUDDY_INTL_*` aliases,
`upstreamIdForIntl`, `StatusBadge` (which rendered CSS-less classes),
`isQuotaStale` and its mirror constant, a forwarding `isValidDatabaseUrl` shim,
stale `.dockerignore` entries, and two byte-identical test blocks.

**Deliberately not applied**

- `exchangeCodeVia` is live (`exchangeCode` → the console OAuth callback);
  deleting it would have broken OAuth login. The first audit called it dead.
- Allowlisting the ingress header record would be fail-open — the record reaches
  surface detection and every parser, so a new header would become invisible.

The one exception is now resolved in the other direction: `openaiCacheControl`
was kept in that round as "the only implementation" of a 1024-visible-token
minimum, but no production caller ever supplied a token count, so the rule
enforced nothing while its ≤4-breakpoint check was already superseded by
`validateCacheBreakpoints`. It is deleted: the function, its two payload types,
both call-site spreads, its tests, and the `TRANSPORT.md` claim. The ≤4 limit
keeps its single owner at the preflight boundary.

Two further removals were reverted after verification: the `typeof db.transaction`
probe in `account-health-service.ts` is load-bearing for a partially-implemented
test double, and `InMemoryIpAbuseStore.getCount` is used by tests as
introspection. Both were restored with comments explaining why, rather than
removed for symmetry.

**Configuration**

`CARTETHYIA_KIMI_QUOTA_BASE_URL` replaces the undocumented `KIMI_CODE_BASE_URL`
read and is declared in `CONFIG_SPEC`, so it is covered by the drift check.


### Proxy pool status
- Consolidated the tool-result placement rule that had been re-derived (and gotten wrong) in eight places. "A tool
  answer may live in a `tool` turn **or** a `user` turn" is a fact about the canonical model, so `canContainToolResult`,
  `toolResultParts` and `toolCallParts` now live beside `CanonicalMessage` and every consumer uses them: the buddy drop
  policy, the orphan scan, the interleaved-batch repack, the Codex orphan repair, and the Chat, Messages, CommandCode,
  Qoder and Devin encoders. A `role === "tool"`-only check missed every Messages-origin history, which caused three
  separate upstream 400s: `tool_call_sequence_broken`, "tool calls and tool results do not match", and the
  thinking-mode reasoning replay — the last because the buddy policy stripped a *complete* round's `tool_calls` while
  leaving its result behind, so the replayed reasoning turn no longer had a call to attach to. A shared contract test
  asserts the rule across all consumers.
- The thinking-mode 400 ("the reasoning content from the previous turn must be passed back in thinking mode") is fully
  closed, across three shapes the Chat encoder got wrong. An assistant turn carrying `tool_calls` dropped
  `reasoning_content` — exactly the turn a thinking model emits it on. The field was gated on non-empty text, so a
  `display: "omitted"` thinking block (empty text plus a signature) lost it. And a reasoning-only assistant turn was
  dropped entirely. The field is now emitted whenever an assistant turn carries a reasoning part, regardless of text
  length. It stays assistant-only: leftover reasoning on a user turn folds into the preceding tool message as before.
  Separately, `backfillDeepSeekReasoningContent` wrote an **empty** `reasoning_content` onto assistant turns with no
  trace, which the upstream reads as thinking-mode-with-the-reasoning-stripped; it now only writes the field when a real
  reasoning trace exists.
- A provider that states its reset as an **absolute instant** now sets the cooldown correctly. WorkBuddy/CodeBuddy
  `6004` answers a 429 with "your usage will reset at 2026-09-24 02:12:51 UTC+8", but `parseProviderResetDuration`
  only understood relative durations ("in 3 hours"), so the account fell back to the 15-minute default — it
  re-entered rotation and failed every request inside the provider's own reset window. Absolute timestamps are now
  parsed (including a bare `UTC±H` offset), and the provider's stated reset always wins over the fallback.
- Fixed three upstream-failure shapes that surfaced as unusable client errors:
  - A `toolResult` orphan living in a **`user`** turn (every Anthropic Messages tool flow re-homes results there)
    survived the orphan scan, which only inspected `role: "tool"`; `chat.ts` then emitted it as an unpaired
    `role:"tool"` message and the upstream rejected the whole history with "tool calls and tool results do not
    match". The scan now uses the shared `canContainToolResult()` rule.
  - The buddy-family drop policy (`dropIncompleteToolRounds`) ran *after* the generic repair, which had already
    synthesized a `<missing tool output>` result for the unanswered call — making every partial batch look complete
    and silently disabling the policy, so `assistant[c1 c2] + tool[c1]` still dispatched. Dropping now runs first.
  - A non-SSE, non-JSON upstream body (plain text, garbage, or an HTML page on a 2xx) threw a bare `SyntaxError`
    from `res.json()`, which no classifier recognizes: telemetry recorded `unknown_error` and the client got a 500
    "the upstream failure could not be classified". It is now a typed 502 `transport_unavailable` carrying the
    upstream's own message, and a JSON error envelope on a 2xx is surfaced instead of decoding as an empty success.
    HTML error pages are also attributed to `upstream` instead of blaming the gateway.
- Proxy HTTP 402/407 responses now report `Proxy reachable`, disable the affected pool from
  routing, and appear in Health & Activity without misclassifying the error as a provider failure.
- Upstream disable policy is now explicit: only real credential evidence disables an account.
  Deterministic content-policy rejections (`11140`) and hosted-tool failures
  (`web_search`/`x_search`/`web_fetch`) never do, a 402 quota response cools down instead of
  disabling, and a 407 is `network`-origin so it can never mutate an upstream account.
- The buddy family (`cb`/`cbcn`/`workbuddy`) is the one policy exception: its `11140` block keeps
  failing every subsequent invocation, so the account is parked in a 24h `policy_blocked` cooldown
  (never `disabled`) to stop routing from selecting it.
- xAI Grok Build free-tier exhaustion (`subscription:free-usage-exhausted`, "included free usage",
  "rolling 24-hour window") is a 24h `quota_exhausted` cooldown instead of the generic 1h fallback —
  it no longer parks the account as `degraded` and can no longer re-enter rotation inside the
  provider's own reset window.
- Account and proxy-pool health delays are operator-tunable through `CARTETHYIA_ACCOUNT_*_COOLDOWN_MS`
  and `CARTETHYIA_POOL_COOLDOWN_MS`; upstream `Retry-After`/reset evidence still wins over every
  fallback.

### Breaking cleanup contracts

- Removed environment knobs that were never operator policy: `CARTETHYIA_SERVER_REUSEPORT`
  (always on), `CARTETHYIA_ELYSIA_PRECOMPILE` (derived from `NODE_ENV`),
  `CARTETHYIA_PROXY_KEEPALIVE_TIMEOUT` (fixed 60 s), `CARTETHYIA_IP_ABUSE_MAX_KEYS`
  and `CARTETHYIA_IP_ABUSE_CAPACITY_PER_KEY` (fixed store bounds), and the
  `CARTETHYIA_ANTIGRAVITY_{VERSION,CL,OS,ARCH}` client fingerprints (pinned
  constants; the version still tracks the upstream manifest).
- `CARTETHYIA_MODEL_CATALOG_CACHE_MAX_ENTRIES` and
  `CARTETHYIA_GC_ON_MEMORY_PRESSURE` became constructor parameters instead of
  environment variables; they were test seams rather than deployment settings.
- `src/config.ts` now declares every knob it reads in one `CONFIG_SPEC` table,
  and `test/config-env-drift.test.ts` derives the documented variable set from
  it. The drift check previously scanned only `process.env.X` dot access, so
  bracket reads (`process.env["X"]`) escaped it entirely; both forms are now
  collected, and the one remaining indirect reader (`REDIS_MODE`) is declared
  explicitly.
- Removed the four always-null `telemetry_payloads` body columns
  (`response_body`, `client_response_body`, `provider_request_body`,
  `provider_response_body`) from `schema.ts` and the baseline. No writer ever
  filled them: the capture path stores `{ _payload_ref }` in `request_body` and
  the bodies live in the frame file that reference names, so the readers
  overwrote all four from the frame. Existing databases converge with the
  hand-run idempotent DDL in
  `drizzle/migrations/manual/0005_drop_telemetry_payload_body_columns.sql`.
- Removed the eleven per-provider CLI client-version env overrides
  (`CARTETHYIA_{QODER,OPENCODE,COMMANDCODE,GROK,CODEX,CODEBUDDY,KIMI_CLI,CLINE_CLIENT,CLINE_SDK,WORKBUDDY_CLIENT,WORKBUDDY_CLI}_VERSION`).
  They existed to freeze a version offline or force one the registry had not
  published; neither is operator policy, and a stale pin silently defeated the
  `minVersion` guard that protects providers gating on a specific artifact.
  `createClientVersionResolver` now takes no `envVar` and resolves
  discovered → pinned fallback, with `reset()` as the test seam.
- Quota cache writes use the v2 envelope; reads tolerate the legacy bare form
  only during the N release, with the legacy branch and SCAN invalidation
  scheduled for removal in N+1.
- Provider routing persists `rotateCount` — the number of requests one account
  serves before round robin advances (clamped 1..1000); exact model lookup no longer
  guesses from suffixes or bare ids and returns the qualified model contract.
- Studio persists one `toolRounds` representation; `toolCalls` is derived only
  for display.
- Missing active pools are an explicit 503 (`pool_unavailable`) rather than a
  silent fallback to the first pool.
- Removed the `contentStrip` runtime preference and its `stripContentTypes()`
  module. It was stored, validated, and returned but had no dispatch consumer —
  and as a route-blind pre-strip it would have preempted capability routing.
  Modality support is already handled, in order, by candidate filtering, then
  model fusion (`fusion:*`, then same-provider capable models), and only then by
  the preparer's degrade ladder, which substitutes a `[image]`-style text
  placeholder and logs `degradedCapabilities`. One path, not two.
- `buildCapabilityProfile()` grants `reasoning`, `reasoningEncryptedContent`,
  `tools`, and `parallelToolCalls` unconditionally. A `false` in
  `models.reasoning` or `models.tool_call` — whether a discovered row recorded
  it for lack of metadata or a builtin/manual row set it explicitly — no longer
  strips the request. The upstream decides whether it can serve them. Content
  modalities still fall open for every non-`native` wire, and `web_search`
  still follows the row.

### Routing & CLI mapping

- Added API-key-scoped CLI model mapping via the `routing:cli_mapping` scope.
  Keys without the scope retain ordinary model/alias routing and are never
  remapped by CLI source-to-target rows.
- Network pools gained a per-tenant round-robin selection strategy
  (`GET`/`PATCH /network/pools/strategy`, `pool_routing_settings` table):
  `round_robin` strides the per-tenant cursor by `rotateCount` positions per
  admission (mirroring the account strategy's 1..1000 clamp), with full/cooldown
  pools failing over to the next offset. `least_loaded` remains the default,
  and the Proxy page exposes the toggle.
- Claude Code family selectors (`sonnet`, `claude-sonnet-4-5`,
  `claude-sonnet-5`, and related variants) now resolve through the same CLI
  mapping slot without defining fake native provider models.
- Unified provider identity and routing across exactly 40 bundled providers via
  `RAW_BUNDLED_PROVIDER_METADATA` and declarative capability matrices.
- Preserved CLI aliases through the in-memory route snapshot and exposed the
  post-mapping `routedModel` beside the client-requested model in Console Log.
- Credential decryption failures now surface as account/pool authentication
  failures with actionable re-save guidance instead of generic unknown or
  transport errors.

### Architecture & composability

- Reorganized `src/providers/` by domain ownership: provider implementations reside under `integrations/`, shared infrastructure is partitioned into `authentication/`, `quota/`, `discovery/`, and `operations/`, and foundational registry contracts stay at the root.
- Clean root module relocations: moved single-child nested controllers directly to their domain root (`src/transport/dispatch/proxy-request.ts`, `src/providers/discovery/probing-service.ts`) and eliminated redundant directories.
- Clean feature cutoff: completely excised the legacy Filter Sanitize feature cluster end-to-end (removed runtime text scrubbers, dashboard routes, query hooks, database tables, and baseline schema artifacts) with zero backward-compatibility facades.
- Dead-code sweep with no compatibility aliases: removed the unreachable canonical `citation` content variant and its consumer branches, the dead `extension_fields` provider opt-in with its field-promotion mechanism, 39 unused persistence row-type aliases, and the unused generation-control passthrough fields, client-version refresh wrappers, quota target listers, upstream status mapper, and provider URL/User-Agent constants left behind by earlier refactors.
- Removed the remaining declare-thread-discard fields: `OpenAICompatibleAdapterConfig.model_discovery_endpoint` and the `ApiKeyProviderSpec.discovery` option that only fed it, `BundledProviderCatalog.endpointsByProvider`, `ProviderDispatchContext.network_binding` (with `buildUpstreamDispatchContext`'s now-unread `binding`/`candidate` inputs), `TransportPipeline.stages`, `SURFACE_DESCRIPTORS[].pathPrefixes` (an array-of-one whose inner `surface` restated the descriptor's own), `KimiModelBootstrap.thinkingMode`, `QoderModeProfile.cosyVersion`, `ClaudeCredentialPolicy.header_name`, `GuideStep.copyable`, `StudioSessionSummary.mediaCount`, and the dashboard's `ProxyPoolSummary.{disabled,configuredMaxConcurrency}`. `responseParts` no longer extracts a `reasoningSignature` no caller read, and the three one-line surface usage wrappers now call the `providers/usage.ts` builders directly.
- Removed the remaining restated-vocabulary tables: `REJECTED_HEADERS` (a drifted second copy of the security layer's `BASE_PROTECTED_HEADERS`, now read through `isProtectedHeader`), `LOG_LEVELS` (the `CONSOLE_LOG_LEVELS` tuple is the single source and `ConsoleLogLevel` derives from it), the settings `RESPONSES_*`/`MESSAGES_*`/`REDIS_MODES` arrays that restated their own union types, `mapReasoningEffortToWireTier`'s unreachable identity table, and the re-exported `GROK_VERSION`/`CODEBUDDY_TRANSPORT_VERSION`/`CODEBUDDY_OAUTH_VERSION` aliases (every consumer now reads the `FALLBACK_*` constants).
- `GatewayShellDeps` (the route-only constructor in `src/app.ts`) now declares only the knobs route-only mode reads. The six transport/console options it accepted but silently ignored — `db`, `resolvePeerAddress`, `trustedProxyBoundary`, `maxBodyBytes`, `requestDeadlineMs`, `verifiedHttps` — are gone, so passing one is a compile error instead of a no-op. The route-only constructor itself stays: `bun run build:aot` and no-database boot depend on it.
- Protocol dependency inversion: error mappers, tool prefixing, and OAuth token ceilings reside in `src/protocol/`, keeping transport codecs decoupled from provider internals.
- Deduplicated shared logic that had been copied per provider and per surface. The CodeBuddy family (`cb`, `cbcn`, `workbuddy`) now shares one `src/providers/integrations/buddy-chat-shared.ts` for payload normalization (mandatory `stream`, conditional `reasoning_summary`, agent-field stripping) and consecutive-`user`-turn coalescing; each provider keeps its own identity headers and catalog table. The Messages surface reads `stringValue`/`finiteNumber` from `protocol/primitives` like every sibling surface instead of redefining them, and `provider-registry.ts` re-exports `BundledProviderId` from `provider-metadata.ts` instead of declaring a second copy.
- Collapsed pure forwarding aliases into their canonical implementations (`sanitizeSchemaForAnthropic`, `freezeSnapshot`, `REASONING_EFFORT_VALUES`, the `PROVIDER_CUSTOM_HEADER_*`/`PROVIDER_PROTECTED_HEADERS` header constants, `CLAUDE_CODE_COMPATIBILITY_VERSION`) and removed a duplicated `OptionalIntConfigEntry` declaration in `src/config.ts`.
- Extracted the buddy-family Tencent billing-meter parser into `src/providers/integrations/buddy-quota-shared.ts`. `codebuddy-quota.ts` and `workbuddy-quota.ts` had carried the same refill/bonus split, cadence labelling, and bonus numbering twice; each now keeps only its endpoint, identity headers, and display name. The shared module's behavior is covered by `test/providers/integrations/buddy-quota-shared.test.ts`.
- Extracted the buddy-family auth token envelope into `src/providers/integrations/buddy-oauth-shared.ts`, removing the duplicated `data.{accessToken,refreshToken,tokenType,expiresIn}` accessor from `codebuddy-oauth.ts` and `workbuddy-oauth.ts`. Their header sets and response-code handling stay per provider — those have genuinely diverged.
- Finished that extraction: the buddy-family device login is one flow again. `buddy-oauth-shared.ts` now owns the state POST, the `11217` token poll, the refresh POST, the identity header set, and the JWT account label behind one `BuddyOAuthClient` parameterized over a `BuddyOAuthVariant`, so `codebuddy-oauth.ts` and `workbuddy-oauth.ts` hold only their variant — endpoints, domain, platform, user agent, and envelope-code reading. This supersedes the note above that header sets and response-code handling must stay per provider; the one real divergence is preserved and pinned by `test/providers/integrations/buddy-oauth-shared.test.ts`: CodeBuddy reads the envelope code strictly, WorkBuddy through `Number()`.
- Unified the responses-native model-id predicate: `isInferhubResponsesModel` and the discovery-local `isResponsesNativeModelId` were the same rule stated twice, so both now read `isResponsesNativeModelId` from `src/providers/model-definition.ts`.
- Extended `buddy-chat-shared.ts` with `applyBuddySystemPrompt`, the message envelope every buddy variant with a fixed leading prompt applies (drop caller `system`/`developer` turns, install the variant's prompt, rebuild bare string user content as a typed text block, coalesce consecutive user turns). `codebuddy.ts` and `workbuddy.ts` had carried it verbatim; each now passes only its own prompt constant. CodeBuddy CN keeps its own path — it neutralizes caller system text rather than replacing it — and shares only `coalesceConsecutiveUserMessages`.
- Moved the two test-only modules that lived under `src/` to `test/helpers/` (`provider-dispatch.ts` from `src/providers/integrations/test-helpers.ts`, `cli-injector.ts` from `src/console/cli-tools/injectors/test-helpers.ts`), migrating all four importing suites. `src/` now contains production code only, and the coverage gate no longer measures test scaffolding as production lines.
- Moved the shared message-text extractions into `src/transport/canonical-model.ts`: `firstUserText` (Antigravity session seed, [CC] billing suffix) and `joinTextParts` (Cursor, Devin, and CommandCode single-string wire fields) each replace a per-provider copy, so the captured shape is defined once.
- Extracted the provider/account operations layer into `src/console/providers/catalog/provider-operations.ts` (`createProviderCatalogOperations` + `ProviderCatalogConfig`), matching the existing `model-operations.ts`. `routes.ts` now holds only the Elysia body schemas and `createProviderCatalogRoutes` (823 → 386 lines).
- Moved the native Codex Responses-compact handler into `src/transport/dispatch/responses-compact.ts`. `proxy-request.ts` keeps only the canonical dispatch path and no longer imports the compact route's preparer, model predicate, or adapter.
- `ProviderProbingService` builds its provider wire context through one `wireContextFrom` helper and reads the provider row through one `loadProviderWireRow` helper, replacing three inline context literals and two duplicate selects. Static-endpoint resolution now goes through the exported `staticEndpointForWire` instead of a private second copy, and the unreachable static-definition merge in `persistDiscoveredModels` is gone.
- The API-key model allow/deny rule has a single implementation: `modelRejectionReason` in `src/security/api-key-auth.ts` returns `ModelRejectionReason | null`, and `isModelAllowed` is now its boolean projection. `admit()` no longer runs a second, independently written copy of the same rule.
- Split `dashboard/src/routes/ProviderDetail.tsx` into four props-only modules under `dashboard/src/routes/provider-detail/` (`RoutingStrategyCard`, `Accounts`, `OAuthDialogs`, `Models`), taking the route file from 2621 to 486 lines with no behavior change.
- Moved Studio's client tool layer into `dashboard/src/routes/model-lab/tools.ts` and its key-persistence unit into `dashboard/src/lib/studio-session-storage.ts`, so the tool-execution tests no longer pull in the whole route module.
- Removed the never-read Gemini thought-signature capture from `protocol/response/gemini.ts` (`responseParts` no longer returns `reasoningSignature`, per call or per response — none of its four consumers read it, and the outbound `thoughtSignature` emit in `protocol/request/gemini.ts` is untouched). The same pass collapsed the three one-line surface usage wrappers (`outputUsage` in `chat/encode.ts`, `wireUsage` in `messages/encode.ts`, `usageToWire` in `responses/encode.ts`) onto the `providers/usage.ts` builders they renamed, so each surface now calls the canonical usage-to-wire home directly.
- Deleted four single-caller indirections that carried no policy. `devinModel` in `integrations/devin/catalog.ts` became a plain `defineModel({...})` literal, the idiom the other catalogs already use. `encodeCursor`/`encodeEventCursor` in `console/domains/{audit,stats}/store.ts` went away with their `encodeCursor as encodeGenericCursor` import aliases, the `{createdAt, id}` projection now written at the call site — which also dropped two non-null assertions. `getToolDef` in `console/cli-tools/contracts.ts` went away with it: its one caller's job is membership, so `CliToolService.isValidTool` is now `Object.hasOwn(TOOL_REGISTRY, toolId)`. That is a fix, not a simplification — the old `TOOL_REGISTRY[id as ToolId] ?? null` walked the prototype chain and reported `true` for `"toString"`, `"constructor"`, and `"__proto__"`, on a gate that `saveMappings` reads `TOOL_REGISTRY[toolId]` right behind; `test/console/cli-tools/cli-backend.test.ts` pins it. `createPerformanceOperations` in `console/domains/performance/routes.ts` was a factory with one caller and no test, unlike every sibling domain's operations layer, so its two statements moved into the route handler.
- `console/settings/contracts.ts` no longer re-exports `RedisMode`. The type belongs to `persistence/readiness.ts`, and the re-export's only consumer was the dashboard's type-mirror block in `dashboard/src/lib/contracts.ts`, which now imports it from the canonical module.
- Collapsed the hand-restated literal unions that fed Elysia body schemas into projections of the canonical runtime tuples. `WIRE_FAMILIES` (`transport/canonical-model.ts`), `REASONING_EFFORTS`, `TRANSPORT_KINDS` (`network/pool/agent.ts`), `CREDENTIAL_KINDS`/`ACCOUNT_STATUSES` (`console/providers/catalog/contracts.ts`), `POOL_KINDS`/`POOL_STATUSES` (`console/routing/pools/contracts.ts`), `SHARE_LINK_KINDS` (`persistence/schema.ts`), and the probe's deliberately narrower `PROBE_REASONING_EFFORTS` (`providers/discovery/discovery-types.ts`) are now the single declarations; the TypeScript unions derive from them and a new `literalUnion` helper (`console/shared/elysia-schema.ts`) builds each `t.Literal` union from the same tuple. `t.UnionEnum` was rejected as the helper: it stamps a `default` of the first member, which would make an absent body field validate as that member instead of staying absent. Every rewritten schema was diffed against its pre-change literal list and emitted JSON — all twelve byte-identical. The routing and combo schemas now read `ROUTING_STRATEGIES` and `modelComboStrategy.enumValues` directly, so a new strategy cannot land in the tuple and be missing from the HTTP boundary.
- Structural copies in the console now derive from their source. `UpdateProviderRoutingRequest` is `Partial<ProviderRoutingSetting>` (it had restated the six fields, drifting from the runtime type and the body schema), `UpdateRuntimeSettingsRequest` is `ConsoleSettingsPreferences`, and `StudioSessionRow` is `typeof studioSessions.$inferSelect` — which let `DrizzleStudioSessionStore` drop its nine-field `map()` and return rows directly. `CONSOLE.md`'s "five coordinated edits" note for a new runtime preference is now three, because the request type is the persisted bag.
- Merged the remaining provider-family duplication. The buddy static catalogs share one `buddy-catalog-shared.ts` (the seven-field `BuddyRawEntry` tuple and `makeBuddyModel`), so `makeCodebuddyModel` and `makeWorkBuddyModel` are gone; identity headers deliberately stay per provider. `cursor`, `devin`, `kimi`, and `muse` each exported a class *and* a factory *and* a singleton for one adapter, with tests split between the two seams — the class is now module-private and the factory is the one construction path, matching the other sixteen adapters. The Gemini-family SSE line policy is one `decodeGeminiStreamEvent` in `protocol/response/gemini.ts`, shared by Gemini and Antigravity; the two real divergences stay at the call site, since `[DONE]` means *skip* to one and *stop* to the other. `codexJwtAccountId` reads its claims through the shared `decodeJwtPayload` instead of a local `atob(…replace(/-/g,"+")…)`: the two agreed on every ASCII payload, but `atob` decodes to a Latin-1 string, so a payload containing multi-byte UTF-8 came back mojibake. `provider-version-cache.ts` and `model-discovery-cache.ts` had each hand-rolled the same `Map<number, TtlCache<T>>` + `cacheFor(ttlMs)` memo; `TtlCacheFamily<T>` in `runtime/ttl-cache.ts` now owns it.
- `providers/discovery/probe-wire.ts` no longer carries its own `DISCOVERY_CONFIG_BY_PROVIDER` endpoint table — it was a byte-identical second copy of the registry's `endpointPathsByWireFamily`, and it had already drifted. `discoveryPathsFor` reads the registry, so endpoint paths are declared once. That measurement surfaced three real defects, all fixed and pinned by `test/providers/endpoint-map-parity.test.ts`: `ollamacloud` advertised `native` and `messages` paths that its adapter spec rejects with `capability_unsupported`, and `opencodeft`/`opencodezen` advertised a `messages` path with no catalog row and no support in `supported_wire_families`.
- Fixed a silent stream-truncation bug in the Qoder adapter. Its pre-stream deadline was released only in `finally`, so the timer stayed armed across the response body; every other streaming adapter releases it as soon as headers arrive, because from there the gateway's stall/first-chunk watchdog owns the body. The symptom was silent rather than loud — `decodeSseEvents` cancels its reader on abort, so the read resolves as *done*, the loop exits, and `qoderBodyToCanonicalEvents` then synthesized a `state: "complete"` terminal for a body it never finished reading. A healthy slow stream came back as an empty successful response. `test/providers/integrations/qoder.test.ts` reproduces it and fails without the fix.
- The dashboard's session mirror is derived, not hand-written, and finally guarded. The backend `SessionStatusResponse` is now a discriminated union on `status` (the route already emitted every authenticated field together, so the flat optional bag let the mirror omit `username` and mark `display_name`, `is_first_boot`, and `session_expires_at` required without a compile error). `dashboard/src/lib/contracts.ts` aliases `SessionResponse` to it and pins `SessionUser`'s field set in `dashboard/src/session-parity.test.ts`; the two dashboard fixtures missing `username` were corrected. Two further unguarded dashboard provider-id copies — `ProviderIcon.tsx`'s `iconAssets` and `Providers.tsx`'s `FREE_*`/`FOUNDING_IDS` sets — are covered by `dashboard/src/provider-lists-parity.test.ts`. That guard immediately caught a real drift: `workbuddy` had no icon entry, so every WorkBuddy row rendered initials instead of the logo.

### Provider ecosystem & protocol fidelity

- **Codex and Claude model SKUs now expose the current provider catalog.** Codex gains
  `gpt-6-sol`, `gpt-6-luna`, and `gpt-daybreak-blue-latest`, and its `gpt-6-astra`/`gpt-5.5`
  context windows are corrected to the 272k the ChatGPT Codex backend actually serves (the 5.6
  generation keeps 1M). Claude gains `claude-mythos-5`, `claude-mythos-5-1`, and `claude-opus-5-5`
  on both the Claude Code and API-key surfaces plus the discovery fallback, with
  `claude-sonnet-4-6` output and `claude-opus-4-5`/`claude-sonnet-4-5` limits aligned to the
  anthropic catalog. Reasoning-effort ladders follow the reference per model — budget-era Claude
  drops `max`, the 4.6 pair stops at `high`, new-gen Claude and the OpenAI 5.6/6/daybreak rows take
  `max` without `minimal`, and `gpt-5.5` takes neither — enforced at the Messages codec as well as
  the chat/Responses codecs. The Claude fingerprint is now a view over `VERSION_SOURCES`: the CLI
  fallback moves to `2.1.280` (current `@anthropic-ai/claude-code`) and the SDK version to
  `0.112.1`, the release-bundled value the Claude Code release ships into the OAuth refresh User-Agent, replacing
  npm's standalone-SDK latest, which never matched what Claude Code ships. The Codex adapter also
  warms its version cache through the adapter's own fetch instead of `globalThis.fetch`.
- **A reasoning effort a model cannot serve no longer kills the request.** `mimo-v2.6` answers
  `minimal`, `xhigh`, and `max` with a bare `500 {"type":"error","error":{"message":"Internal server
  error"}}` that names no parameter — a client asking for `xhigh` simply saw the request die, with
  nothing to act on. Verified live against OpenCode's `/zen/v1` on 2026-09-22: `low`/`medium`/`high`
  and an omitted field answer `200`, while that model's siblings on the very same endpoint
  (`mimo-v2.5-free`, `nemotron-3-ultra-free`, `big-pickle`) accept the full ladder — so the narrowing
  is a property of the model, not the route, and the resolver now applies it there. Every level the
  clamp can return is accepted by all hosts of the id, so the worst case for a host that would also
  take `xhigh` is one tier below what was asked instead of a failed request.
- Proxy pools now record network/tunnel failures as health events and enter `degraded`/`cooldown`,
  leaving new route snapshots until a successful pooled request, operator recovery, or expiry sweep.
  The Proxy page shows recovery and health history, and its existing SSE stream now carries pool
  status/error transitions alongside live inflight usage. Provider-scoped upstream 429 cooldowns
  remain per-provider and do not sideline an otherwise healthy proxy.
- **OAuth failures now say what to do.** A token exchange that threw a `GatewayError` authored by one
  of our own integrations showed only "token exchange failed — check the console log for details", so
  an actionable reason — for example a provider integration reporting that a required local resource is
  unavailable — was visible nowhere but the server log. `GatewayError.origin` already marks which
  boundary authored a message, and its contract calls a non-upstream error safe to expose, so a
  `cartethyia`-origin message is now shown as-is. Upstream bodies, network failures, and arbitrary
  throws keep the generic wording — an upstream response can echo credentials.
- Prompt-cache identity is now surface-independent: `resolvePromptCacheKey` reads the caller's
  explicit cache key from any wire (chat `extension:prompt_cache_key`, Responses
  `extension:responses.prompt_cache_key`, Messages `extension:metadata_user_id`) before falling
  back to the inbound session id, so switching surfaces mid-conversation no longer misses the
  upstream cache. Client IP stays out of the key — it is telemetry, not cache identity.
- Cline `api_key` accounts probe `/models` for connectivity instead of the OAuth-only
  `users/me` surface: keys carry no OAuth envelope and upstream exposes no quota endpoint for
  them, so a 401 from `users/me` would be an unactionable credential verdict. The OAuth path is
  unchanged.
- Tool-history repair now covers all three shapes an OpenAI-compatible upstream rejects with `tool_call_sequence_broken` (WorkBuddy/CodeBuddy code `11148`), not just one. `repairRequestToolCalls()` previously synthesized a `<missing tool output>` result for a `toolCall` with no answer — but left a **`toolResult` whose `toolCall` is absent** and left results **split by an interleaved turn** (Codex's `image_resize_notice` lands between two parallel results) untouched, and both are rejected the same way. It now drops orphan results, fills missing ones, and repacks interleaved batches so results are contiguous. This matters because a broken history stays broken: the client replays it on every later turn, so one bad round kills the whole conversation. Verified end to end — the orphan result reached the wire before the fix and does not after.
- Upstream error envelopes whose code is a **number** with the specific string nested in `extError` (the WorkBuddy/CodeBuddy shape) lost both their code and their message: `mapUpstreamHttpError` read only a nested string `code`, and `extractUpstreamMessage` never looked at the top-level `msg`. A 400 that explained itself exactly — "tool calls and tool results do not match" — reached the operator as an empty message with no provider code. Both are now extracted, preferring the most specific string available.

- The base-catalog lookup now resolves context/output limits and pricing **per provider**. A bare model id is not unique in the models.dev snapshot: `claude-sonnet-4-6` is recorded under 32 providers, and 428 bare keys disagree about `context` (503 on `output`, 551 on pricing). The lookup kept the first row it saw, so the winner was whichever provider sorted first — `302ai` — and a Cartethyia model could report a reseller's limits and price. `resolve(providerId, modelId)` still prefers an exact `provider:model` hit; the bare fallback now answers only when every row for that id agrees, and returns `undefined` otherwise so the caller keeps its own declared values. Discovery callers pass their `providerId`, so limits come from the row for the provider actually serving the model. Two existing tests were asserting the old arbitrary winner (`cb:hy4-preview`, `cb:deepseek-v4.1-flash` — `cb` has no row in the catalog at all) and were corrected to assert the new, honest behaviour. Also removed `refreshWorkBuddyClientVersion`, which had no caller.

- **Codex Responses**:
  - Enforced `fc_` prefix compliance on tool call items in Responses payloads, resolving upstream validation rejections.
  - Resolved duplicate reasoning summary emissions by deduplicating delta streaming chunks against terminal `output_item.done` summaries while preserving encrypted continuation state.
  - Attached persistent `prompt_cache_key` mapped to the active session identifier (`effectiveSessionId`) on every turn, matching official `codex-rs` caching behavior.
- **Qoder (Modern Cutover)**:
  - Completely decommissioned legacy COSY v0.1.43 profiles and switched exclusively to `MODERN_PROFILE` pointing to `https://api2.qoder.sh`.
  - Added dynamic version resolution via `createClientVersionResolver` targeting npm `@qoder-ai/qodercli` with automated TTL caching and modern `1.0.22` fallback.
  - Injected modern business headers (`cosy-business-product: "cli"`, `cosy-business-type: "agent"`, `cosy-scene: "assistant"`, `x-model-key`, `x-model-source`) and enabled top-level system prompt mirroring into `chat_prompt` and context.
- **Custom (BYOK) Providers & CLI Identity**:
  - Added official CLI request header emulation for custom OpenAI-compatible (Codex CLI User-Agent & originator) and Anthropic-compatible ([CC] CLI User-Agent & Stainless headers) endpoints.
  - Supported optional `cli_identity` toggle in `CompatibilityProfile` and exposed it via dashboard modal controls.
  - Fixed custom provider model discovery in the dashboard so custom endpoints never hide the "Fetch models" action, while cleanly hiding it for builtins lacking discovery implementations.
  - Model discovery no longer overrides the provider's own wire contract. The generic `/models` fetcher carries no wire information, so it guessed a family from the model id alone — `chat` for everything, `responses` for `gpt-5`/`gpt-6`/`o3`/`o4`-style ids — and `applyDiscoveredWire` let that guess win. A Messages-only custom provider therefore persisted every discovered model as a `chat` row, and each probe died with `capability_unsupported`: `htf supports only wire family "messages", got "chat"`. The same class hit chat-only OpenAI-compatible providers, whose `gpt-5.x` ids were routed to a `responses` wire the adapter rejects. A guess is now admitted only when the provider's derived `supportedWireFamilies` contains it, the cross-wire `discoveryPaths?.chat` endpoint fallback is gone, and a sync prunes the superseded `discovered` rows for the ids it resolved — a corrected wire family lands on a new `(model, endpoint)` row, so the stale pair would otherwise survive as a dead route. `ProviderResponse.supportedWireFamilies` exposes the derived set, and the dashboard's Add-Model wire selector is constrained to it instead of re-deriving the rule.
- **CodeBuddy & WorkBuddy**:
  - Replaced per-request random UUID generation for `x-conversation-id` with inbound session preservation (`x-conversation-id`, `x-session-id`, `x-session-affinity`, `x-opencode-session`), preserving upstream conversation continuity and prompt cache reuse.
- **Grok CLI, Muse, Devin, Cursor, Antigravity, and Claude Code ([CC])**:
  - Maintained provider-native wire adaptations, protobuf serialization, and token/quota tracking with high prompt-cache hit rates across production workloads.

- Restored the MiMo flash row to the bundled OpenCode catalog and made a broken alias diagnosable. `opencodeft/mimo-v2.6-flash-free` is live on the shared `/zen/v1` base, but the bundled catalog had stopped declaring it, and `seedBundledModels` deletes every `builtin` row the catalog no longer declares — so the next boot pruned it and both tenant aliases that address it by name (`mimo-2.6-flash`, and the `fallback-mimo2.6` combo member behind `cb/deepseek-v4.1-flash` and `workbuddy/deepseek-v4.1-flash`) began answering `model_not_found`, which reads like a typo in the client's own request. The row is back with its authoritative models.dev metadata (200k context, 32k output, free, text/image/document/audio input, reasoning), and `model_not_found` now carries the post-alias/combo target in both its message and `details.resolved_models`, so the missing target is visible instead of hidden behind the alias name. A catalog test pins the row and a routing test pins the diagnostic.

- OpenCode tier limits and pricing now resolve from the committed models.dev snapshot instead of hardcoded numbers. Every `defineModel` row in the three OpenCode catalogs carried explicit `ctx`/`out`, which silently overrode `modelsDevCatalog.resolve()`, and fourteen of them disagreed with the snapshot this repository already ships: `mimo-v2.5-free` claimed 512k/64k against 200k/32k, `nemotron-3-ultra-free` 128k/32k against 1M/128k, `deepseek-v4-flash` 128k/32k against 1M/384k, and `big-pickle` an output limit double the real one. The overstated direction is the dangerous one — the gateway admits a request the upstream then rejects — while the understated rows silently capped what the model could serve. Rows the snapshot covers now pass `providerId` and declare no limits, so the snapshot is the single source; the three rows newer than it keep explicit limits, and the MiMo row pins `free` so its cost resolves to zero instead of an unknown fallback. A catalog test now fails on any row whose limits disagree with the snapshot, verified by reintroducing the old `big-pickle` output limit.

### Dashboard & observability
- Usage request telemetry now persists the client-facing HTTP status as metadata. The Requests
  panel has clickable 200/499/503 filters with period-wide counts; 499 cancellations are a
  separate sub-count, not an error, while failed and truncated requests remain errors. Breakdown
  now sits left of Traffic. Payload-body capture defaults off (metadata remains stored), and
  metadata retention defaults to 30 days via `CARTETHYIA_TELEMETRY_RETENTION_DAYS`. Previously
  the Usage page offered `7d`/`30d`/`all` while telemetry was pruned after 3 days, so long-window
  totals were silently capped and could shrink as older rows were pruned.

- **Quota Management can now redeem Codex and Claude saved rate-limit resets, and every
  attempt is logged as account health activity.** Both providers keep a small pool of
  "reset credits" that lift a spent window before its natural reset, and both are reachable
  from the account's own credential: Codex through
  `GET/POST /wham/rate-limit-reset-credits[/consume]` (the consume body carries a
  `redeem_request_id` idempotency key, so a retry cannot double-spend), Claude through
  `GET /api/oauth/usage?cedar_ember=1&skip_spend=1` — falling back to the Juniper
  `at_wall=1` session reset — plus `POST /api/organizations/:orgId/reset_rate_limits` with a
  `cedar_ember` grant (`{ program, grant_id, request_id }`) or `{ program: "juniper_tide" }`.
  The card reads the account's live inventory from a dedicated `GET /accounts/:id/resets`
  rather than mirroring a count onto the quota payload, because Claude's usage body leaves the
  `cedar_ember` block `null` until the probe asks for it — a mirrored count would silently read
  zero. The Zap action opens a per-account table listing every credit with its **status, title,
  granted-at, and expiry**, each with its own **Use** button (the backend still auto-selects the
  soonest-expiring credit when none is named, since credits are perishable and expiry order
  maximizes the bank's value). The provider set is one shared predicate
  (`supportsAccountReset`) so the button and the route agree, and both provider User-Agents come
  from the existing authorities — `getCodexVersion()` (`codex_cli_rs/<version>`) and
  `CLAUDE_CODE_USER_AGENT` (`claude-cli/<version> (external, cli)`) — so the reset calls never
  carry a hardcoded version that drifts from what dispatch sends. A successful redemption
  also repairs the account in place: `consecutiveFailures` resets to 0, `cooldownUntil` clears,
  and `status` returns to `active`, so the account rejoins dispatch rotation immediately
  instead of waiting out a cooldown that no longer reflects reality. Success and failure both
  write a `health_events` row (reason `Rate limit reset consumed …` or
  `Rate limit reset failed: [code] …`), so the outcome lands in the account's existing Health &
  Error Log modal rather than a separate surface. `listAccountResetCredits` and
  `consumeAccountResetCredit` live in `src/providers/operations/account-reset-service.ts`.
- Dashboard polish pass: mobile pull-to-refresh on scrollable routes, SSE-driven live views
  (in-flight, pools, logs) that stay fresh without a manual reload, provider toasts on mutations,
  custom-provider model wire types constrained to the families the backend resolves for that
  provider, the API-format
  selector hidden for Anthropic-compatible providers, Usage breakdown rows rendered without a
  fail column, and Studio's `web_search` tool removed (web-fetch only).
- A client-cancelled request no longer reports as an unexplained gateway failure. Telemetry labelled every non-`GatewayError` abort `unknown_error` with origin `cartethyia`, so a request the client simply hung up on (TTFB 9.15 s, no content delta ever, disconnect at ~119 s) rendered in Usage as `499 · "the upstream failure could not be classified"` — blaming the gateway for an ordinary cancel. `classifyTerminalCategory()` now reads the abort signal behind the failure: a `TimeoutError` deadline reason becomes `deadline_exceeded`, a `GatewayError` reason (stall watchdog) keeps its code, any other aborted signal becomes `transport_closed` ("request was cancelled by client"), and only a failure with no abort behind it stays `unknown_error`. The streaming and attempt-loop paths both use it, pinned by five regression tests. Separately, the operator-facing effect of model aliases is now documented (`TRANSPORT.md` planning, `CONSOLE.md` routing): `requested_model` keeps the client-facing name while the provider columns show the resolved target, so a row like `claude-opus-5` served by `opencodeft` is an alias or CLI mapping working as configured.

- Added a **Client IP** breakdown to the Usage page. The backend gained a `client_ip` dimension that groups telemetry by stored address and masks on read through the same fail-closed gate as the request list (`privacyMode !== "full"`); because masking can collapse two hosts into one display name, rows sharing a masked name are re-aggregated so the operator never sees two indistinguishable rows or understated totals. The dimension list is one runtime tuple (`USAGE_DIMENSIONS`) read by the route table, the operations validator, and the dashboard union — the four hand-written `by-<dimension>` routes became one parametric `/system/usage/by-:dimension`, so adding a dimension can no longer reach one layer and miss another.
- Each breakdown row now reports hits, successes, and failures, with the card subtitle totalling them across the group. Previously a row showed only a request count and the failure count was computed but never surfaced.
- Fixed the Usage breakdown tab not switching. The page keeps its view state in the URL and re-renders on its own every 10s (four queries carry `refetchInterval`), so a handler that built its `URLSearchParams` from the `searchParams` of an earlier render could write that stale snapshot back and revert a sibling parameter — a click set `dim` and a concurrent update from an older closure restored the previous value. Parameter updates now go through React Router's functional form via a tested `withParam` helper, so only the intended key changes.

- **Usage & Metrics**:
  - Aligned "Cached tokens" metrics to aggregate total input tokens covered by cache hits (`inputTokens` where `cachedInputTokens > 0`), ensuring consistent cache efficiency visibility across summary cards and breakdowns.
  - Corrected request table display to format cache as `{cached} / {input}` tokens.
  - Removed deprecated error summary cards in favor of focused capacity and throughput metrics.
  - Upgraded Requests table with 50-entry initial capacity, auto-paging dynamic scroll loading (+50 per page up to 500), and transient highlight animations for newly completed requests.
  - Added privacy masking toggle ("Mask" / "Mysterious") replacing provider labels and truncating model slugs while retaining full tooltips on hover.
  - Refined in-flight request indicators and status pills to use clean, accessible typography without distraction.
- **Branding & Layout**:
  - Replaced the placeholder "C" icon in the dashboard sidebar with the official Cartethyia branding asset (`favicon_love.webp` with fallback and Customization overrides).
  - Expanded request detail drawer on mobile viewports (`max-width: 640px`) to a full-screen sheet, eliminating awkward top spacing.

### Security, database & migrations

- Telemetry now records **which layer** failed, beside the error code. `errorCategory` alone could not separate the gateway's own failures from an upstream's: `invalid_request` is written both when the caller's body is malformed and when the provider rejects a well-formed body, so an operator triaging a spike could not tell whether to look at the router or at the provider. `telemetry_events.error_origin` (`cartethyia` | `upstream` | `network`) is written from the `GatewayError`'s own origin at every dispatch and ingress failure site, and the Usage drawer prefixes the layer onto the message. Existing databases converge with the hand-run idempotent DDL in `drizzle/migrations/manual/0006_add_telemetry_error_origin.sql`; rows written before it read as unknown.
- Every non-`active` account classification now carries a `retryAt`. `sweepExpiredCooldowns` selects on `cooldownUntil IS NOT NULL`, so the `degraded` classifications — 5xx, timeout, and unclassified failures — which set `retryAt: null` were **never swept back**: the account stayed unroutable until an operator restored it by hand. A new 1-minute budget covers the unclassified case.
- The console now shows per-model backoffs. A throttle with a `modelId` cools the (account, model) pair through `modelCooldowns` rather than the account, so the account stays usable for every other model — but that map was never sent to the console, so the table read `Active` for an account whose requests for a throttled model were all being routed away. `ProviderAccountResponse.modelCooldowns` carries the still-live deadlines (expired ones dropped) and the account badge reports them.
- Added the thirteen `GatewayErrorCode` values that had no dashboard label, so they render a sentence instead of a mechanical underscore-to-space of the raw code.

- Single consolidated database baseline migration (`drizzle/migrations/0000_baseline.sql`) verified against strict integrity contracts.
- Dropped deprecated `filter_rules` table and columns cleanly from PostgreSQL persistence and schema definitions.
- Dropped the unused `network_pools.degraded_since` column from `schema.ts` and the baseline; existing databases converge with the hand-run idempotent DDL in `drizzle/migrations/manual/0004_drop_degraded_since_column.sql`.
- Strict CSP, frame ancestry protection, and HMAC-backed API credential validation on all ingress routes.

### Test infrastructure & documentation

- `test/helpers/db-gate.ts` now routes as well as gates. It previously only
  decided *whether* DB suites ran (on `CARTETHYIA_TEST_DATABASE_URL`) while
  `getDb()` resolved `DATABASE_URL`, so a developer whose two URLs pointed at
  different databases ran the suites against their working database and left
  test fixtures there. Setting the isolated URL now rewrites `DATABASE_URL`
  before any pool is opened; CI was unaffected because it already set both.
- `test/console/quota/account-quota.test.ts` registered its `afterEach` /
  `afterAll` cleanup inside the first of its two `dbDescribe` blocks while
  both appended to the same module-scope id arrays, so the second block's
  global accounts were never deleted and accumulated a few rows per run. The
  hooks moved to file scope.
- One layer doc per top-level `src/` folder, covering its whole subtree; the
  twenty per-subfolder docs were merged into their parents and deleted. Each
  doc is named for its layer in caps (`src/console/CONSOLE.md`,
  `src/providers/PROVIDERS.md`, `src/transport/TRANSPORT.md`,
  `src/network/NETWORK.md`) so no two share a basename — only the repo-root
  `README.md` and `dashboard/README.md` keep the `README.md` name. The
  architecture map, contributor guide, agent contract, and develop skill now
  describe the one-doc-per-folder rule.
