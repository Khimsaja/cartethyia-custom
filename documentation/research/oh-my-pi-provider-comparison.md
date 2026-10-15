# oh-my-pi vs Cartethyia — provider comparison

- Date: 2026-10-15.
- Donor (oh-my-pi): `D:\MyGitRepository\Projects\HoneyC\ProxyRouter-Project\Public\oh-my-pi` @ `c2cb79e4c227aa4b22c4ccb933ff72fd88bceba4`.
- Ours (Cartethyia): repo root @ `4a8444f2576e8bc67a034f52df87dad8395f14ba`.
- Scope: 4 providers (Factory, Antigravity, Claude Code, Codex).

> **The donor checkout is on disk at the path above** — one directory level above
> this repo, under `ProxyRouter-Project/Public/oh-my-pi`. Read it before marking
> any item "blocked on undocumented behavior": several items in this file were
> recorded as blocked when the answer was available there all along. Donor paths
> cited below are relative to that checkout.
- **Correction to the task brief: our Codex side is NOT a Rust CLI.** Investigation found `src/providers/integrations/codex/` and `src/protocol/*codex*` are TypeScript speaking the Codex Responses wire directly. The Codex section below treats it as a TS dispatch boundary. No rewrite is proposed anywhere.

Donor paths below are under `packages/ai/src/` unless `packages/catalog/src/` is named. Ours are under `src/`.

## Factory

### Request shape

Donor multiplexes four wires per model (`factory-droid.ts:36-40`). Ours implements three. No `google-generate` wire.

| Slot | Donor (agent) | Ours (router) |
|---|---|---|
| Endpoints | `POST {host}/api/llm/o/v1/chat/completions`, `POST {host}/api/llm/o/v1/responses`, `POST {host}/api/llm/a/v1/messages`, `POST {host}/api/llm/g/v1/generate` (`factory-droid.ts:36-40`, `wire/factory-droid.ts:75-86`, `gemini.ts:28,369`) | Same first three (`factory.ts:60`, `factory-models.ts:22-26`). No gemini path. |
| Host | Per-account residency: EU host when OAuth identity region is eu, else global (`factory-droid.ts:137-141`, `wire/factory-droid.ts:70-72`) | Per-account residency from stored `auth_state.region` (`factory.ts:87-90`). Same behavior. |
| Method | POST on all wires | POST on all legs. |
| Headers, always | `User-Agent: factory-cli/0.237.0` (`factory-droid.ts:269`, `wire/factory-droid.ts:13`); `X-Client-Version: 0.237.0`, `X-Factory-Client: cli`, `X-Factory-Org-Id: <org>` (`factory-droid.ts:270`, `wire/factory-droid.ts:92-98`); `x-api-provider: <upstream>` (`factory-droid.ts:271`); `x-provider-routing-source: session_lock\|configured_order\|registry_default` (`factory-droid.ts:272,586-593`); `x-session-id`, `x-assistant-message-id` (v4 UUIDs) (`factory-droid.ts:273-274,550-554`); `Authorization: Bearer <workos token>` | `X-Client-Version: 1.0.0`, `X-Factory-Client: cli`, `X-Factory-Org-Id: <org>`, `user-agent: factory-cli/1.0.0` (`factory.ts:71-78`); `Authorization: Bearer` via adapter. No `x-api-provider`, no routing-source, no session ids. Version `1.0.0` vs `0.237.0` — literal delta. |
| Headers, conditional | `Accept: application/json` + `OpenAI-Platform` org hint on completions/responses (`factory-droid.ts:276-279`); X-Stainless fingerprint (Lang js, Runtime node, pinned `v26.3.0`, arch/OS, Retry-Count 0) on all but gemini (`factory-droid.ts:280-287`); `X-Stainless-Timeout: 600` + `x-api-key: placeholder` on anthropic-messages (`factory-droid.ts:288-293`) | `anthropic-version: 2023-06-01`, `content-type: application/json` on messages leg (`claude-messages.ts:135-137`); `stream_options.include_usage` on OpenAI legs (`compatible-adapter.ts:168-169,211-229`). No Stainless set, no placeholder key, no org hint. |
| Auth model | Harness-resolved WorkOS token per call; empty is config error (`factory-droid.ts:537-546`). Org id from unverified JWT `external_org_id` (`factory-droid.ts:330-342`). API keys are control-plane only, 403 here (`factory-droid.ts:46`). | Stored envelope `{accessToken, orgId}`, failing closed (`factory.ts:100-115`); org captured at login from JWT (`factory-oauth.ts:98-134`). |
| Body, completions | Shared encoder + `temperature: 1` default (`factory-droid.ts:498,70-74`) + route-dialect reasoning fields (`effort` / `forced-on` / `opt-in` / `none`, `factory-droid.ts:306-327`) | Canonical chat payload. No forced temperature, no reasoning dialects. |
| Body, responses | Tools forced `strict: false`; conditional `prompt_cache_key`, `prompt_cache_retention: 24h`, `parallel_tool_calls`, `service_tier`, `text.verbosity`, `safety_identifier` (`factory-droid.ts:454-489`). `tool_choice: auto` default. No temperature. | Canonical responses payload. None of the above. |
| Body, messages | Thinking ladder + budgets, `thinkingDisplay: omitted` on explicit hide, `fine-grained-tool-streaming` beta, refusal `fallbacks` + `fallback-credit-2026-06-01` beta (`factory-droid.ts:399-452`) | Canonical messages payload. None of the above. |
| Body, gemini | Native `generateContent`: `{model, contents, systemInstruction?, generationConfig{temperature 1, topP .95, topK 64, thinkingConfig}, tools?}` (`gemini.ts:330-353`). Tool names sanitized to `[a-zA-Z0-9_-]`, 64-char + sha8 (`gemini.ts:48-52`). Replay provenance: only Google-origin signed thinking survives (`gemini.ts:129-151`). | Not implemented. Gemini ids route onto chat (guard unconfirmed). |
| Streaming | SSE all wires. Idle + first-event timeouts with local abort (`gemini.ts:320-327,361-367`). | SSE passthrough (`compatible-adapter.ts:345`). No factory-specific first-event/idle budget. |
| System identity | `You are Droid, an AI software engineering agent built by Factory.` prepended (`factory-droid.ts:60,563-566`, `droid-identity.md:1`) | Not sent. |
| UA pin source | `FACTORY_DROID_CLIENT_VERSION = "0.237.0"` (`wire/factory-droid.ts:13`); runtime pinned to CLI's Node `v26.3.0` (`factory-droid.ts:63-67`) | `FACTORY_DROID_CLIENT_VERSION = "1.0.0"` hardcoded (`factory.ts:69`). Comment says inventing a number claims untested compat. |

LEGAL-RISK FLAG: donor impersonates the first-party CLI (`factory-cli/<version>` UA, `X-Factory-Client: cli`, pinned X-Stainless fingerprint, `x-api-key: placeholder` dummy). Legal read before copying.

### Behavioral deltas

- Auth: donor relies on harness-refreshed WorkOS token per call. Ours owns device-code flow + refresh grant + JWT-exp expiry (`factory-oauth.ts:137-238,90-96`). Donor has no login code here.
- Upstream selection: donor pins `x-api-provider` from rotation, narrowed by region and session lock (`factory-droid.ts:93-103,146-150,586-593`). Ours sends no selector. Factory chooses.
- Rate limits: neither reads quota headers in these files. Donor enforces regional context/max-token caps pre-request (`factory-droid.ts:151-161`). Ours uses static catalog ctx/out (`factory-models.ts:30-42`).
- Response: donor maps region rejections to friendly error (`factory-droid.ts:344-350`), maps finish reasons (`gemini.ts:90-106`), fails truncated streams as retryable (`gemini.ts:460-473`). Ours uses shared error mapping only.
- Multi-model: donor resolves wire + rotation + regional limits per model from registry (`factory-droid.ts:191-226,547-549`). Ours uses static transcribed catalog, Gemini ids absent (`factory-models.ts:4-13`).

### Missing (prioritized)

1. Gemini `google-generate` wire (`gemini.ts:292-296`, `wire/factory-droid.ts:83-84`). Gemini models cannot route at all. L.
2. `x-api-provider` selector + rotation/region narrowing (`factory-droid.ts:93-103,146-150`). All traffic takes Factory default routing. M.
3. `x-provider-routing-source` + session UUIDs (`factory-droid.ts:259-296,550-554`). Upstream attribution/stickiness signals. S.
4. X-Stainless fingerprint + `x-api-key: placeholder` (`factory-droid.ts:280-293`). Proxy may gate on SDK identity. LEGAL-RISK FLAG. S.
5. Completions `temperature: 1` + reasoning dialects (`factory-droid.ts:70-74,306-327`). Forced-on/opt-in models get wrong fields. M.
6. Responses `extraBody` (cache key/retention, `safety_identifier`, verbosity, non-strict tools) (`factory-droid.ts:454-489`). Caching/attribution/tool-shape gaps. M.
7. Messages thinking ladder + refusal fallbacks + streaming beta (`factory-droid.ts:399-452`). Reasoning models lose budgets/fallbacks. M.
8. Region-unavailable error mapping (`factory-droid.ts:344-350`). Opaque errors otherwise. S.
9. Client version `0.237.0` parity (`wire/factory-droid.ts:13`). Stale `1.0.0` risks proxy mismatches. LEGAL-RISK (UA impersonation). S.
10. Droid system prefix (`factory-droid.ts:60`). Gating unconfirmed; likely skip for a router. S.

### Have that they don't

- Full OAuth device-code login + WorkOS refresh ownership (`factory-oauth.ts:137-238`).
- Persisted credential envelope with codec (`factory.ts:100-115`).
- Residency from stored `auth_state` (`factory.ts:87-90`).
- Static transcribed catalog with explicit ctx/out (`factory-models.ts:45-105`).
- Gateway SSE translation, shared error mapping, account health/cooldown/pool machinery.

## Antigravity

Donor design note `google-antigravity-forced-tool.md` is a 1-line stub at this commit. Live forced-tool policy is code-only.

### Request shape

| Slot | Donor (agent turn, streaming) | Ours (router, streaming) |
|---|---|---|
| Endpoint | `{endpoint}/v1internal:streamGenerateContent?alt=sse`, POST (`google-gemini-cli.ts:944`). Endpoints tried in order: prod `https://daily-cloudcode-pa.googleapis.com`, sandbox `...sandbox.googleapis.com` (`google-gemini-cli.ts:317-319`). | `{baseUrl}/v1internal:streamGenerateContent?alt=sse`, POST (`antigravity.ts:213`). Base from provider metadata (`provider-metadata.ts:80-87`). |
| Headers | `Authorization: Bearer`, `Content-Type: application/json`, `Accept: text/event-stream`, `User-Agent: <antigravity/hub UA>` (`google-gemini-cli.ts:594-600`). Conditional `anthropic-beta: interleaved-thinking-2025-05-14` for Claude reasoning routes (`:601-603`). Caller header overrides spread last (`:604`). | `content-type`, `accept`, `authorization: Bearer`, `user-agent` (`antigravity.ts:264-269`). No beta header. No caller-header spread. |
| Query | `alt=sse` only. | `alt=sse` only. |
| Body top level | `project` (always), `requestId` (`agent/<agentId>/<ts>/<trajectoryId>/<step>`), `request`, `model`, `userAgent: "antigravity"`, `requestType: "agent"` (`google-gemini-cli.ts:1388-1395`) | Same keys, but `project` only when resolved (`antigravity.ts:872-882`). |
| Body nested `request` | `contents`, `systemInstruction` (with `role: "user"`, donor-only quirk), `tools`, `toolConfig`, `generationConfig`, `labels`, `sessionId` (`:1309-1320,:1374-1387`) | Shared `buildGeminiPayload` + `labels`, `sessionId`, system-instruction injection, `googleSearch` tool, `toolConfig` (`antigravity.ts:786-870`) |
| Always-sent labels | `last_step_index`, `trajectory_id`, `used_claude`, `used_claude_conservative` (`:1247-1254`) | Same four (`antigravity.ts:814-820`). |
| Conditional | `last_execution_id`, `model_enum`, `generationConfig` (non-empty), `systemInstruction` (present only) | `last_execution_id`, `model_enum` (`antigravity.ts:814-823`) |
| Streaming | SSE over POST (`:944,:1018`). | SSE via shared `decodeSseEvents` (`antigravity.ts:374-377`). |
| Auth | OAuth Bearer from JSON bundle; refresh is AuthStorage's job, provider refuses expired tokens (`:367-399,:518-532`) | Google OAuth credential kind enforced, Bearer token (`antigravity.ts:193-209`) |
| UA pin | `antigravity/hub/<version> (aidev_client; os_type=<os>; arch=<arch>; cl=<cl>)`; env-overridable os/arch/cl (`wire/gemini-headers.ts:47-49,111-120`) | Same shape but os/arch/cl hardcoded `darwin`/`arm64` (`antigravity-protocol.ts:29-45`, `client-versions.ts:168-177`) |

Literal deltas: donor `project` mandatory; ours omits on lookup failure. Donor `used_claude` honors per-model `antigravityUsageLabel`; ours hardcodes `id.includes("claude")`. Ours adds `googleSearch` injection + `ANTIGRAVITY_SYSTEM_INSTRUCTION` (donor has neither). Donor `generationConfig` carries temperature/topP/topK/presencePenalty/thinking; ours carries `maxOutputTokens` + thinking budget only. Ours has a non-stream `GENERATE_PATH`; donor streams only.

LEGAL-RISK FLAG: both sides impersonate the `antigravity/hub` desktop client, including `darwin`/`arm64`. LEGAL-RISK FLAG: ours ships a third-party OAuth client secret, base64-obscured (`antigravity-oauth.ts:25-32`).

### Behavioral deltas

- Auth: donor never refreshes inline. Ours owns PKCE + refresh + project-cache warm at login (`antigravity-oauth.ts:94-149,131-135`).
- Rate limits: donor retries per endpoint (`MAX_RETRIES = 3`, 1s exponential, 5-min 429 budget) with pre-stream failover (`:321-329,:944-954,:1089-1102`). Ours does one bounded sandbox retry on 429/5xx (`antigravity.ts:761-776`).
- Quota: donor quota-read path not found in regions read (unconfirmed). Ours reads `retrieveUserQuotaSummary` + `fetchAvailableModels` with per-model/session/daily/weekly windows (`antigravity-quota.ts:258-326`).
- Forced-tool: donor drops caller `toolConfig` on Gemini routes (backend ignores ANY/NONE), restates forced choice by appending directive as trailing user message, defaults `VALIDATED`, forces VALIDATED for Claude when catalog sets it (`:1342-1370`). Directive text unconfirmed. Ours forces Claude `VALIDATED` unconditionally, no restatement (`antigravity.ts:867-869`).
- Tool schema: donor rewrites `parametersJsonSchema` to `parameters` (`:1196-1213`). Ours relies on shared builder; equivalence unconfirmed.
- Images: donor pre-clamps oversized images for image-contract hosts (`:577-585`). Ours has no clamp in dispatch (shared builder unconfirmed).
- Response: donor strips planning leakage, retains thought signatures, accepts thought-only STOP, errors on missing finish reason (`:882-921,:1033-1073`). Ours maps missing finish to `failed`, emits reasoning summaries, no leak filter (`antigravity.ts:437-457`).
- Empty-stream: donor replays identical request (`MAX_EMPTY_STREAM_RETRIES`) + pre-start failover (`:984-1042`, `register-builtins.ts:90-97`). Ours has no empty-body replay.
- Session: donor keeps ONE global session state (`:298-314,:1187-1194`). Ours keys per (conversation, model) with TTL + sibling reset (`antigravity.ts:653-727`).
- Model gating: donor gates new models on discovered client version + sticks to last-good endpoint (`:591-593,:1076-1081`). Ours gates on monitor version, no stickiness.

### Missing (prioritized)

1. Forced-choice restatement for Gemini routes (`google-gemini-cli.ts:1346-1352`). `tool_choice=required` silently degrades to text otherwise. S (directive text unconfirmed).
2. Empty-stream replay + pre-start endpoint failover (`:984-1042,:1089-1102`). 200-with-zero-SSE fails routable requests. M.
3. Last-good-endpoint stickiness (`:556-571,:1076-1081`). Avoids re-probing dead endpoint per turn. S.
4. `anthropic-beta: interleaved-thinking-2025-05-14` passthrough (`:601-603`). Claude-via-Antigravity thinking may gate on it. S.
5. Per-model `antigravityUsageLabel` for `used_claude` (`:1252`). Mislabeled telemetry skews quota accounting. S.
6. `parametersJsonSchema` to `parameters` normalization (`:1196-1213`). Tools dropped/rejected otherwise. S (shared-builder coverage unconfirmed).
7. Pre-send image clamp (`:577-585`). Oversized images poison later turns. M.
8. Planning-leak strip + thought-only STOP acceptance (`:903-921,:1033-1037`). Complete reasoning-only response surfaces as error otherwise. M (agent-facing; lower router value).
9. Provider-owned first-event watchdog, 300s default (`:324,:941-957`). Distinguishes cold start from dead stream before failover. M.
10. Env-overridable UA os/arch/cl (`wire/gemini-headers.ts:116-119`). Stops claiming darwin/arm64 everywhere. S.

### Have that they don't

- Non-streaming `generateContent` path (`antigravity.ts:55,293-353`).
- Image-gen op with IMAGE modality envelope (`antigravity.ts:500-620`).
- Web-search op via `googleSearch` + grounding normalization (`antigravity.ts:467-498`).
- Live catalog from `fetchAvailableModels` with effort-variant collapsing (`antigravity-protocol.ts:202-243`).
- Quota reads merging `retrieveUserQuotaSummary` + per-model windows (`antigravity-quota.ts:258-326`).
- Free-tier onboarding (`onboardUser` LRO) + tier-aware `loadCodeAssist` retry (`antigravity-protocol.ts:462-581`).
- Per-(conversation, model) session store with TTL + sibling reset (`antigravity.ts:669-727`).
- Control-plane probe UA-stripping (`antigravity.ts:235-240`).
- Skip-thought-signature bypass for Gemini 3+ (`antigravity-protocol.ts:266-288`).
- Per-wire-id `maxOutputTokens` table incl. Claude 64k cap (`antigravity-protocol.ts:63-82`).

## Claude Code

### Request shape

Both sides: `POST {baseURL}/v1/messages`. Donor forces `stream: true` always (`anthropic.ts:5549`). Ours forwards caller stream flag (confirm intended).

| Field | Donor | Ours | Delta |
|---|---|---|---|
| `Authorization` | OAuth `Bearer`, caller value dropped+logged (`anthropic.ts:482-500,:406`). Official API key via `X-Api-Key` (`:519-527`). Non-official branches kept for custom endpoints (`:501-517`). | OAuth/scoped `Bearer`; api_key kind `X-Api-Key` (`claude-credentials.ts:208-214`). Credential from control plane, never caller headers. | Parity on OAuth. Donor non-official branches may matter for custom endpoints. |
| `User-Agent` | `claude-cli/{ver} (external, cli)` (`claude-code-fingerprint.ts:35-37`). Default `2.1.280` (`:15`), env override wins (`:30-32`). | Inbound UA passthrough, else `claude-cli/{cli_version} (external, cli)` (`claude-credentials.ts:194`). Fallback `2.1.296` (`client-versions.ts:305-311`). | Same shape. Versions differ. Ours honors inbound UA; donor only `claude-cli*` inbound. |
| `x-app` | `cli` every branch (`anthropic.ts:396-403,:495`) | `cli` on OAuth (`claude-credentials.ts:211`). Non-OAuth path unconfirmed. |
| `anthropic-version` | `2023-06-01` always. | Same. Parity. |
| `anthropic-dangerous-direct-browser-access` | `true` always. | Same. Parity. |
| `anthropic-beta` (OAuth) | Full agent profile always: `claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07` + `effort-2025-11-24` with thinking + `fallback-credit-2026-06-01` every request (`anthropic.ts:258-266,:386-387,:423-427`) | Split profile: utility set without tools/thinking, agent set with; `effort` with thinking only, `fallback-credit` on agent requests only (`claude-credentials.ts:90-126`) | Real delta. Donor always sends agent profile at header layer. Observable on wire. |
| `X-Claude-Code-Session-Id` | Only when caller provides it (`anthropic.ts:489`) | Only with real identity, never synthesized (`claude-credentials.ts:180-197`). Parity in spirit. |
| `X-Stainless-*` | Arch, Lang js, OS, Package `0.112.1`, **Retry-Count `0`**, Runtime node `v26.3.0`, Timeout 600 (`anthropic.ts:819-828`) | Same minus **Retry-Count**. SDK `0.128.0`. (`claude-credentials.ts:198-204`). One-line gap. |
| `Accept` | OAuth `application/json` even when streaming; non-OAuth `text/event-stream` when stream (`anthropic.ts:428`) | Same split (`claude-credentials.ts:189-190`). Parity. |
| `Accept-Encoding`/`Connection`/`Content-Type` | `gzip, deflate, br, zstd` / `keep-alive` / `application/json`. | Same. Parity. |
| `anthropic-usage-limit: slow` | Conditional on lane state machine (`anthropic.ts:2762-2769`, `anthropic-slow-mode.ts:21-24`) | Absent. No slow lane. |
| `anthropic-user-profile-id` | Per-request override (`anthropic.ts:2768`) | Not sent. Beta added when profile present (`claude.ts:223-225`). Missing header. |
| TLS | Bun TLS pin: `rejectUnauthorized`, `serverName`, `DEFAULT_CIPHERS` for provider anthropic (`anthropic.ts:1337-1363,:1179`); own 10-min pre-response timeout, fetch timeout disabled (`anthropic.ts:4124-4129`, `anthropic-client.ts:33`) | Deadline lifecycle. No pinned cipher suite found. Cipher reach unconfirmed. |
| Body always | `model, messages, max_tokens, stream: true` (`anthropic-wire.ts:327-360`). Order: model, messages, system, tools, metadata, max_tokens, thinking, context_management/compaction, output_config, stream (`anthropic.ts:5529-5530`). | `model, messages, max_tokens, stream` via canonical payload; system billing+instruction prepended for OAuth (`claude.ts:234-285`). |
| Body conditional | `system` (OAuth billing+identity, `:4037-4054`); `tools: []` even tool-less on OAuth (`:5284-5286`); `metadata.user_id` JSON envelope (`:5288-5298`); `thinking`; `context_management {edits:[{type:"clear_thinking_20251015",keep:"all"}]}` (`:5424-5431`); `compaction {type:"summarize"}` (`:5540-5545`); `output_config {effort,task_budget}` (`:5491-5502`); `fallbacks` (`:5547`); `temperature/top_p/top_k` when allowed (`:5554-5564`); `stop_sequences` max 4 (`:5565-5576`); `speed:"fast"` (`:5578-5580`); `tool_choice`; `anthropic_beta` (Vertex only, `:5516-5527`) | System billing+instruction; metadata envelope; thinking via canonical; temperature quirks (`claude.ts:234-236`). No compaction, fallbacks, speed, output_config.effort, `tools: []`. |
| Version pin source | Offline consts + env override + adopt-from-rejection (`claude-code-fingerprint.ts:15-32,59-67`) | Pinned fallbacks + live npm resolver (`client-versions.ts:305-316`, `claude-fingerprint.ts:14-22`). Complementary: ours live-refreshes, donor adopts on rejection. |

LEGAL-RISK FLAG: CLI UA impersonation on both sides. LEGAL-RISK FLAG: TLS cipher pinning is fingerprint mimicry (unconfirmed it reaches wire on ours). LEGAL-RISK FLAG: CCH billing attestation + device-id mimicry on both sides (see below).

### Behavioral deltas

- Auth: donor branches headers/body on token shape (`anthropic.ts:406,:5249`); retries once with server-named version after `claude_code_version_too_old` (`claude-code-fingerprint.ts:59-67`, `anthropic.ts:3486-3510`). Ours has live npm versions but no adopt-on-rejection retry (unconfirmed). Donor refresh path not read (unconfirmed).
- Quota: donor parses inline response headers (`anthropic-ratelimit-unified-slow-*`, unified/5h/7d resets, grace utilization, overage flags) per request (`anthropic-slow-mode.ts:172-232`) + per-family buckets incl. `seven_day_opus` (`usage/claude.ts:68-73,:732-764`). Ours polls `GET /api/oauth/usage`, 5-min cache + 3-min 429 cooldown (`claude-quota.ts:101-143,:150-163`). Inline headers are fresher for routing.
- Transforms: donor OAuth-only system injection (`:4037-4054`); `tools: []` tool-less (`:5284-5286`); sampling strip on Opus 4.7+/Fable/Mythos 5 (`:5552-5564`); never advertises `context-1m-2025-08-07` (`:370-374`); cache-beta strip on refusal; `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` kill switch (`:2241-2243,:2255-2266`). Ours matches injection + sampling strip via `applyParamQuirks`. Kill-switch equivalent unconfirmed.
- Slow mode: donor lane opt-in, lane-state reads, 429 `slot_busy`/529 retry on server interval, first-party OAuth only (`anthropic-slow-mode.ts:1-17,:96-118`; `anthropic.ts:2762-2769,:2862-2864,:3735-3745`). Ours: nothing. Biggest subscription-fleet gap.
- Vision: donor clamps pre-send (8000px/10MB base64 at 0.9 headroom, >20 images to 2000px, 16M-pixel budget, 4-way fan-out, memoized, PNG/JPEG re-encode) (`anthropic-images.ts:23-28,:60-70,:226-244`). Ours: media-type allowlist only (`protocol/request/messages.ts:38-52`). No resize.
- Response: donor validates SSE envelope, throws error frames, skips ping (`anthropic.ts:1385-1472`); refusal `stop_details.fallback_credit_token` freezes body for 5-min redemption replay (`:244-248,:1633-1641,:3295-3306`); `usage.iterations[].type == "fallback_message"` is served-by-fallback signal (`anthropic-wire.ts:1829-1838`); `fallback` blocks replayed at position (`anthropic.ts:1618-1619`); thinking prefix-binding errors retry with stripped thinking (`:3511-3527`); unsigned-thinking demote learned per session (`:5234-5241`). Ours: `parseClaudeSseStream` + `mapClaudeHttpError` (`send-claude-messages.ts:45-80`). Fallback-credit, iteration billing, prefix-binding retry absent.
- Identity: device id SHA256 over install-id (+account), domains `omp-claude-device-id-v1/v2` (`anthropic-identity.ts:51-67`); cloaking `user_<64hex>_account_<uuid>_session_<uuid>` (`:5-11`); envelope `{device_id, session_id, account_uuid}` (`:91-98`); CCH xxHash64 seed `0x4d659218e32a3268` low 20 bits over `cch=00000` anchored at `system[0]` (`anthropic.ts:877-914`); billing `cc_version={ver}.{sha256("59cf53e54c78"+chars+ver)[0:3]}` from 5th/8th/21st chars of first user text, `cc_entrypoint=cli` (`:865-875`). Ours: same CCH construction pure-TS (`claude-cch.ts:90-148`); device domain `cartethyia-claude-device-id-v1` (`claude.ts:84-104`). Parity.
- Tool prefix: donor prefixes custom tools `_` on OAuth except builtins (`anthropic-identity.ts:117-136,468-480`). Ours: `CLAUDE_TOOL_PREFIX` equivalent cited, exact application unconfirmed.
- Multi-model: donor `fallbacks` chain (≤3 models, per-attempt max_tokens/thinking/output_config/speed) + `server-side-fallback-2026-06-01` beta + `fallback` blocks + rebased iteration billing (`anthropic-wire.ts:297-308`; `anthropic.ts:1868-1901`). User Profiles REST + per-request profile header (`anthropic-user-profiles.ts:122-194`; `anthropic.ts:2768`). Opus-only gating not found in files read (unconfirmed). Ours: no fallbacks chain, no profiles REST; quota parses opus/sonnet weekly buckets (`claude-quota.ts:27-32`).
- Compaction: donor on-demand `compaction: {type:"summarize"}` + signed-block replay + threshold edit via `context_management`, endpoint-gated (`anthropic-compaction.ts:35-64`; `anthropic-wire.ts:171-186,:340-347`). Ours: no compaction param seen (canonical carriage unconfirmed). Agent-flavored; router likely only needs replay passthrough.

### Missing (prioritized)

1. `X-Stainless-Retry-Count: 0` on OAuth requests (`anthropic.ts:819-828`). One-line fingerprint parity; absence is observable. S.
2. Slow-lane support (`anthropic-usage-limit: slow` + slow-header parse + per-lane retry) (`anthropic-slow-mode.ts:21-24,:172-232`; `anthropic.ts:2762-2769,:3735-3745`). Routes around exhausted subscriptions instead of failing them. M.
3. Fallback-credit redemption: freeze refused body, replay with `fallback_credit_token` inside 5 min (`anthropic.ts:1633-1641,:244-248,:3295-3306`). Free retry on refusals; without it refusal is terminal. M.
4. Adopt server-named CLI version on `claude_code_version_too_old`, retry once (`claude-code-fingerprint.ts:59-67`; `anthropic.ts:3486-3510`). Stale pin costs one rejection instead of hard outage. S.
5. Pre-send image clamp (8000px/10MB, >20 images to 2000px) (`anthropic-images.ts:23-28,:226-244`). Oversized blocks poison retries and fallbacks. M.
6. Server-side `fallbacks` chain + `fallback` block replay + iteration billing (`anthropic-wire.ts:297-308,:1829-1838`; `anthropic.ts:1868-1901`). Classifier-blocked primaries need the documented retry path and correct served-model accounting. M.
7. `anthropic-user-profile-id` header + User Profiles REST client (`anthropic.ts:2768`; `anthropic-user-profiles.ts:122-194`). Profile-scoped credentials unaddressable without it. M.
8. On-demand compaction request + signed-block replay passthrough (`anthropic-compaction.ts:35-64`; `anthropic-wire.ts:340-347`). Long sessions need the summarize path; replay blocks must survive untouched. L (canonical carriage unconfirmed).
9. Thinking `block_binding` + prefix-mismatch strip-and-retry (`anthropic.ts:5376-5387,:3511-3527`; `anthropic-wire.ts:252-263`). Preserved-thinking replay fails closed otherwise. M. Agent-flavored.
10. `output_config.effort` / `task_budget` / `between_tools` passthrough (`anthropic-wire.ts:267-295,:340-347`). Newer models reject `disabled` and gate quality on effort. M.
11. Never send `context-1m-2025-08-07` on subscription credentials (`anthropic.ts:370-374`). Anthropic hard-429s it without long-context credit. S.
12. Cap `stop_sequences` at 4 with warning (`anthropic.ts:5565-5576`). Cheap 400 avoidance. S.
13. `tools: []` on tool-less OAuth requests (`anthropic.ts:5284-5286`). Matches captured client shape; impact unconfirmed. S (unconfirmed).
14. Retry budget (2 tries; 408/409/429/5xx + `x-should-retry`; `retry-after-ms` first; 60s cap; 10-min timeout) (`anthropic-client.ts:33-39,:102-135,:252-302`). Aligns router retries with upstream. S (deadline-layer parity unconfirmed).

### Have that they don't

- Per-beta capability negotiation with drop-vs-reject policy (`claude-betas.ts:40-65`).
- Request compatibility assessment gate with downgrade reporting (`claude-compatibility.ts`).
- Quota service with hashed-key TTL cache, 429 cooldown, curated fallback discovery (`claude-quota.ts:101-163`; `claude-oauth.ts:190-228`).
- Pool machinery: account health, leases, rotation, reset services (`providers/operations/`, `providers/quota/`).
- Pure-TS CCH attestation, no native hash dependency (`claude-cch.ts:90-121`).
- OAuth login details: public client id, loopback `localhost:54545`, `code#state` fragment, bootstrap label fallback (`claude-oauth.ts:8-22,:124-152`).
- Spend/extra-usage dollar windows alongside percent windows (`claude-quota.ts:58-77`).
- Live version discovery from npm with pinned fallbacks (`client-versions.ts:305-316`).

Donor complexity that is agent-only, not router work: thinking-history preservation and prefix binding, compaction summarization content, image pixel pushing, session/cloaking identity lifecycle, fallback-credit continuation echo, per-turn control records, Copilot/Vertex/Foundry/Umans route branches.

## Codex

Reminder: our Codex side is TypeScript speaking the Codex Responses wire directly (`src/providers/integrations/codex/`, `src/protocol/*codex*`). No Rust CLI exists. Items below are additions around that dispatch boundary, not a rewrite.

### Request shape

Donor (TS agent; `openai-codex-responses.ts` + `openai-codex/request-transformer.ts`; constants in `packages/catalog/src/wire/codex.ts`):

- Method/URL: `POST {baseUrl}/codex/responses`. Base defaults to `https://chatgpt.com/backend-api` (`wire/codex.ts:5`). URL built at `openai-codex-responses.ts:1460-1461`, resolver at `:4990-4996`.
- Auth: `Authorization: Bearer <ChatGPT-OAuth access token>`; `chatgpt-account-id` from JWT claim `https://api.openai.com/auth` (`openai-codex-responses.ts:4886-4887`, `wire/codex.ts:95-106`).
- Headers: `OpenAI-Beta: responses=experimental` (or `responses_websockets=2026-02-06` on WS, `:4906-4912`); `originator: omp` (`:4913`, `wire/codex.ts:71`); `version: 0.159.0` pinned (`wire/codex.ts:34`, sent at `:4914`); generic pi `User-Agent` (`:4915`); session affinity `conversation_id`/`session_id`/`x-client-request-id` (`:4916-4927`); thread/window/turn-metadata/installation compat headers (`:4928-4936`); sticky `x-codex-turn-state` / `x-models-etag` (`:4937-4946`); `x-openai-internal-codex-responses-lite: true` on Lite only (`:4947-4951`); `x-codex-routing-hint: model=<slug>[;tier=<tier>]` on every OAuth request (`:4890-4894`, `wire/codex.ts:87-89`); residency from JWT claims (`:4900`); `x-oai-attestation` only when JIT provider supplies one (`:4901-4905`); SSE path sets `accept: text/event-stream`, `content-type: application/json` (`:4952-4958`).
- Body (`transformRequestBody`, `request-transformer.ts:415-555`): `model`, `input[]`, `store: false` (`:421`), `stream: true` (`:422`), `prompt_cache_key` (`openai-codex-responses.ts:1586`), `instructions` (system folded top level, `:1610`), `tools` + normalized `tool_choice`, `reasoning.{effort,summary,context,mode}`, `text.{verbosity,format}`, `include: ["reasoning.encrypted_content", ...]`, `service_tier`, `client_metadata` envelope, optional `stream_options.reasoning_summary_delivery`, optional `access_programs.cyber`. Sampling controls and output caps never sent (`request-transformer.ts:75-78,:551-552`, `openai-codex-responses.ts:1589-1596`).
- Streaming: SSE via `readSseJson`, or WebSocket-first (`wss://` conversion at `:3895-3903`) with SSE replay fallback (`:1671-1694`).

Ours (TS dispatch boundary; `codex.ts` + `codex-headers.ts`, body in `src/protocol/request/codex.ts`):

- Method/URL: `POST https://chatgpt.com/backend-api/codex/responses` (`codex.ts:651`), or `.../responses/compact` for compaction (`codex.ts:451`).
- Auth: `authorization: Bearer <decoded credential secret>`, OAuth-family kinds enforced (`codex.ts:233-245,:163-177`).
- Headers: `user-agent: codex_cli_rs/<version> (Mac OS 27.0.1; arm64) Apple_Terminal/455` (`cli-platform.ts:81-83`); `originator: codex_cli_rs`, `version: <npm-discovered @openai/codex version>` (`codex-headers.ts:42-43`, `client-versions.ts:225-228`); `OpenAI-Beta: responses=experimental` (`codex-headers.ts:53`); account/residency/attestation/session/thread/window/turn/parent-turn/conversation/installation/turn-metadata/beta-features/subagent/lite-marker/turn-state/models-etag/routing-hint headers (`codex-headers.ts:48-107`); `client_metadata` + `prompt_cache_key = session id` stamped on payload (`codex.ts:784-785`).
- Body (`src/protocol/request/codex.ts:390-546`): `model`, `input[]`, `stream: true`, `store: false`, system folded to `instructions`, function/custom/computer tool items, `reasoning.{effort,summary,context,mode:pro}`, Lite forces `context: all_turns`, `include += reasoning.encrypted_content`, `text.{verbosity,format}`, opt-in `stream_options`, no sampling controls.
- Streaming: SSE-only; sniffs first frame when content-type missing, falls back to non-stream JSON parse (`codex.ts:801-871`).

Literal deltas: donor `originator: omp`; ours `originator: codex_cli_rs`. Donor deletes install/thread/window/turn-metadata headers without compat metadata; ours always emits what it has. Donor Lite from explicit flag or `PI_CODEX_RESPONSES_LITE` env (`request-transformer.ts:101-107`); ours from adapter config only (`codex.ts:285`). Donor threads `prompt_cache_retention` (`request-transformer.ts:85`); ours sends only the key (backend support unconfirmed). Donor defaults reasoning summary-on (`summary: auto` unless null, `:166-175`); ours sends summary only when canonical intent carries one, defaulting `auto` with effort present (`src/protocol/request/codex.ts:459-473`). Both sides never forward sampling controls. Donor Lite reshapes tools into `additional_tools` developer item and folds instructions into input (`request-transformer.ts:350-413`); ours applies only the `reasoning.context = all_turns` override — full-shape parity unconfirmed (`applyCodexResponsesLiteShape` exists at `src/protocol/request/codex.ts:544-546`).

LEGAL-RISK FLAG: donor sends `originator: omp` (`wire/codex.ts:71`) — product-identity claim for a different product. LEGAL-RISK FLAG: ours builds `codex_cli_rs/<version> (Mac OS 27.0.1; arm64) Apple_Terminal/455` byte-identical to the real client with the stated goal of being "indistinguishable from the real client" (`cli-platform.ts:73-83`), fixed macOS platform regardless of host (`cli-platform.ts:1-17`). Review before changing either.

### Behavioral deltas

- Auth: donor reads bearer from env, derives account id per request (`openai-codex-responses.ts:1453-1458`); rotation/refresh outside provider file. Ours owns full lifecycle: browser PKCE + device-code OAuth with Codex client id `app_EMoamEEZ73f0CkXaXp7hrann` (`codex-oauth.ts:24-39,:155-272`), strict account-identity validation on exchange (`:86-93`), OAuth-family gating per dispatch (`codex.ts:163-177`).
- Rate limits: donor parses `x-codex-primary/secondary-used-percent/window-minutes/reset-at` + `usage_limit_reached`/`rate_limit_exceeded` into friendly messages (`response-handler.ts:40-96`), 5-min 429 retry budget (`openai-codex-responses.ts:310-311`). Ours parses same six headers + codes, adds `retry-after` handling and upstream request ids (`codex-errors.ts:31-174`), and polls `backend-api/wham/usage` into primary/secondary windows (`codex-quota.ts:17-68`). Donor has no wham/usage poll.
- Compaction/attestation: donor compacts WebSocket-first V2 with isolated per-compaction session state and turn/phase machine (`openai-codex-responses.ts:1475-1522,:1731+`, `openai-codex-compaction.ts:4-18`); attestation is JIT host callback, only for ChatGPT-OAuth account ids (`openai-codex-attestation.ts:1-19`). Ours compacts over HTTPS POST to `/responses/compact` with `requestKind: "compaction"` envelope (`codex.ts:406-467`); attestation is static adapter-config string (`codex.ts:188`, `codex-headers.ts:54-55`).
- Response: donor accumulates usage incl. cache tokens and tier cost multipliers, forwards ChatGPT moderation metadata to UI observer, guards whitespace-only tool-call-argument loops (256 events / 16 KiB / 2 retries), retries/refreshes on retryable event codes (`openai-codex-responses.ts:292-319,:1352-1399,:2509-2512`). Ours maps stop reasons, surfaces in-200 error frames, guards same whitespace loop, converts non-stream JSON (`src/protocol/response/codex.ts:18-44,:665-751`). Moderation observer and tier-multiplied cost are donor-only.
- Identity: donor derives account id + residency from JWT per request, attests JIT (`:1458,:4900-4905`). Ours decodes same claims from stored credential (`codex-identity.ts:37-67`); attestation is injected config, not JIT.
- Multi-model: donor gates Daybreak cyber `access_programs` per (account, model) with drop-on-rejection replay (`access-programs.ts:32-63`), gates `all_turns` context and reasoning summary by model compat (`request-transformer.ts:504-520`), version-gates availability against pinned client version (`wire/codex.ts:24-34`). Ours gates `all_turns` similarly and pins `-image` variants to chat carriers; no access-program or version-gated logic.

Donor complexity that is agent-only: mid-turn `response.steer` pump (`live-steering.ts:59-150`); stable-effort `configuration_update` items (`openai-codex-responses.ts:1630-1658`); moderation UI observer (`:195-201`); per-turn metadata sessions, chained/appended baselines, debug dumps (`:1501-1541`); isolated compaction transport cells.

### Missing (prioritized)

1. WebSocket-first transport with SSE fallback around dispatch (`openai-codex-responses.ts:1671-1694`, `openai-codex-transport.ts:5-18`, `:3895-3903`). Lower first-token latency + second path when SSE stalls; half-open guards (`:252-286`) are router-relevant. L. Steering itself is agent-only, excluded.
2. 429 retry budget honoring server delays at routing layer (`openai-codex-responses.ts:310-311`, `response-handler.ts:67-80`). Converts transient quota/overload to latency. M. Pairs with existing `retryAfterMs`. Our current 429 posture unconfirmed.
3. Daybreak `access_programs.cyber` field + drop-on-rejection replay (`access-programs.ts:32-63`, called at `:1459`). Eligible accounts get fewer refusals; ineligible hard-fail without replay. S.
4. `prompt_cache_retention` passthrough (e.g. `24h`) alongside session cache key (`request-transformer.ts:84-85`). Longer prefix-cache retention on sticky sessions. S. Backend support unconfirmed.
5. Version-gated model availability: hide SKUs stamped client version does not unlock (`wire/codex.ts:24-34`). Prevents routing to models that 404 at discovery. M.
6. Full Responses-Lite body shape (tools to `additional_tools`, instructions into input) when Lite set (`request-transformer.ts:350-413`). Lite-only models reject full shape. S. Verify `applyCodexResponsesLiteShape` coverage first (unconfirmed).
7. ChatGPT moderation metadata passthrough as diagnostic event (`openai-codex-responses.ts:195-201,:2509-2512`). First-party safety-signal parity for downstream consumers. S.

### Have that they don't

- OAuth-family credential contract enforced per dispatch (`codex.ts:163-177`); donor trusts ambient env keys.
- `wham/usage` quota polling with primary/secondary windows (`codex-quota.ts:48-68`).
- Structured gateway errors with `retryAfterMs`, `rate_limits`, upstream request id, plan-aware messages (`codex-errors.ts:140-174`).
- Bounded session-state LRU + TTL for sticky routing headers (`codex.ts:296-334`).
- SSE sniffing for backends omitting content-type, plus non-stream JSON path (`codex.ts:801-871`).
- Image-gen carrier routing and websearch-via-dispatch (`codex.ts:468-619`).
- Live client-version discovery from npm vs pinned constant (`client-versions.ts:225-228` vs `wire/codex.ts:34`).
- Static, auditable attestation/residency/subagent header surface in one builder (`codex-headers.ts:37-109`).

## Cross-cutting observations

Patterns repeating across donor providers, candidates for shared helpers on our side:

- Fingerprint/identity builder. All four donor providers pin a first-party UA + SDK fingerprint set (Factory `factory-droid.ts:259-296`; Antigravity `wire/gemini-headers.ts:47-49`; Claude `claude-code-fingerprint.ts:15-37`; Codex `wire/codex.ts:24-71`). Ours reimplements per provider with drift (versions, missing Retry-Count, hardcoded darwin/arm64). One shared client-identity module with per-provider profiles would stop the drift. LEGAL-RISK FLAG: centralizing impersonation also centralizes the legal surface — get the read first.
- Adopt-on-rejection versioning. Donor Claude retries once with the server-named version after `claude_code_version_too_old` (`claude-code-fingerprint.ts:59-67`). Donor Codex pins `0.159.0` and gates SKUs on it (`wire/codex.ts:24-34`). Ours live-resolves from npm but never adopts server corrections. A shared "version rejected, adopt and retry once" helper fits all providers.
- Empty-stream / eventless-stream recovery. Antigravity donor replays identical requests on 200-with-zero-SSE (`google-gemini-cli.ts:984-1042`). Codex donor falls back SSE-to-replay (`openai-codex-responses.ts:1671-1694`). Factory donor fails truncated streams as retryable (`gemini.ts:460-473`). Ours fails once everywhere. A shared empty-stream replay policy belongs in the transport layer, not per provider.
- Pre-send image clamp. Donor Claude (`anthropic-images.ts:23-28`) and donor Antigravity (`google-gemini-cli.ts:577-585`) both clamp before send. Ours has only an allowlist (`protocol/request/messages.ts:38-52`). One shared clamp helper serves all image-capable providers.
- Per-model usage labels. Donor Antigravity honors `antigravityUsageLabel` per model (`google-gemini-cli.ts:1252`). Donor Claude tracks `seven_day_opus` buckets (`usage/claude.ts:732-764`). Ours hardcodes label derivations per provider. Shared per-(provider, model) usage-label table would fix telemetry skew.
- Inline quota headers vs polling. Donor Claude reads per-response rate-limit headers (`anthropic-slow-mode.ts:172-232`); donor Codex reads six `x-codex-*` headers (`response-handler.ts:40-96`). Ours polls `wham/usage` and `/api/oauth/usage` on timers. Inline headers are fresher for routing; keep polling as fallback, add header parsing as primary signal.
- Server-provided retry delays. Donor Claude honors `retry-after-ms` with 60s cap (`anthropic-client.ts:252-302`). Donor Codex runs a 5-min 429 budget (`openai-codex-responses.ts:310-311`). Donor Antigravity caps 429 retry at 5 min (`google-gemini-cli.ts:321-329`). Ours has `retryAfterMs` plumbed in errors but no uniform budget. One shared retry-budget helper.
- Session stickiness signals. Factory donor sends session UUIDs + routing-source (`factory-droid.ts:259-296`). Codex donor sends conversation/session/turn-state headers (`openai-codex-responses.ts:4916-4946`). Antigravity donor keeps one global session; ours keys per (conversation, model). A shared sticky-session envelope (ids + last-good-endpoint) would cover all three.
- Kill switches. Donor Claude has `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` (`anthropic.ts:2241-2243`). Donor Codex gates on `PI_CODEX_RESPONSES_LITE` env (`request-transformer.ts:101-107`). Donor Antigravity env-overrides UA parts (`wire/gemini-headers.ts:116-119`). Ours hardcodes most of these. Shared env-override convention for identity and beta surface.

Donor-ahead vs donor-complicated: donor is clearly ahead on wire fidelity (fingerprints, retry budgets, replay paths, fallback chains) — that is all portable. Donor complexity that is NOT portable: agent-turn machinery (steering pumps, stable-effort updates, moderation UI observers, thinking-history preservation, compaction summarization content, per-turn control records, debug dumps, chained baselines). None of that transfers to a router.

## Prioritization summary

Ranked by impact first, effort second. Effort S/M/L. Legal-risk items need a legal read before any work.

| Rank | Item | Provider | Effort | Impact | Status |
|---|---|---|---|---|---|
| 1 | Slow-lane support (`anthropic-usage-limit: slow` + parse + retry) | Claude | M | High — serves exhausted subscriptions instead of failing them | Done — §1 parse, §3 registry, §4 routing, §5 capacity wait all wired. Default wait lowered from the donor's 20s to 2s for gateway deadlines |
| 2 | Fallback-credit redemption (freeze + 5-min replay) | Claude | M | High — free retry on refusals | Done — token is **top-level** `body.fallback_credit_token` (donor `anthropic.ts:1640`), NOT in `stop_details`; 400 naming the token drops it and retries |
| 3 | Daybreak `access_programs.cyber` + drop-on-rejection replay | Codex | S | High — fewer refusals for eligible accounts | Done — gated behind `provider_options`, eligibility signal unconfirmed |
| 4 | Empty-stream replay + pre-start failover | Antigravity | M | High — 200-with-zero-SSE fails routable requests today | Done — helper + wired into the Antigravity stream leg |
| 5 | Gemini `google-generate` wire | Factory | L | High — Gemini models cannot route at all | Done — `gemini` added to WIRE_FAMILIES; routes to `/api/llm/g/v1/generate` with `x-api-provider: google`. Shipped as forward migration 0002 (both backends) |
| 6 | 429 retry budget honoring server delays | Codex | M | High — transient quota becomes latency, not errors | Done — waits the server delay, bounded by budget + deadline, leases released during the wait |
| 7 | Server-side `fallbacks` chain + iteration billing | Claude | M | High — classifier-blocked primaries need the retry path | Done — chain via `provider_options` (per-attempt field names UNCONFIRMED), served-by-fallback signal surfaced |
| 8 | `x-api-provider` selector + rotation/region narrowing | Factory | M | Med — all traffic takes Factory default routing today | Done — 14 upstreams validated (donor `wire/factory-droid.ts:30-45`); region-unavailable mapped; `x-provider-routing-source` added |
| 9 | Forced-choice restatement for Gemini routes | Antigravity | S | Med — `tool_choice=required` silently degrades otherwise (directive text unconfirmed) | Done — directive is an explicit seam; text itself still UNCONFIRMED |
| 10 | Pre-send image clamp (shared helper) | Claude + Antigravity | M | Med — oversized blocks poison retries and later turns | Done — one shared module, wired into both the Claude and Gemini inline paths |
| 11 | Version-gated model availability | Codex | M | Med — prevents routing to 404 SKUs | Done — discovery now sends `client_version`; our pin unchanged (bumping it is a separate decision) |
| 12 | Adopt server-named version on rejection, retry once (shared helper) | Claude (+ all) | S | Med — stale pin costs one rejection, not an outage | Done |
| 13 | `X-Stainless-Retry-Count: 0` | Claude | S | Low — one-line fingerprint parity | Done |
| 14 | `anthropic-user-profile-id` + Profiles REST | Claude | M | Low — only matters for profile-scoped credentials | Done — REST client built; **also fixed a wrong beta** (bare `user-profiles` → `user-profiles-2026-09-04`) |
| 15 | `prompt_cache_retention` passthrough | Codex | S | Low — cheaper sticky sessions (backend support unconfirmed) | Done |

### Notes on the done items with open assumptions

- **#6 Codex 429 budget.** Honors the server-stated delay inside one attempt,
  bounded by a 5-min total budget, a 60s per-wait cap, and the request deadline
  (reserving the 15s `MIN_RETRY_BUDGET_MS` floor). Three caveats worth knowing
  before trusting it:
  1. **Whether Codex actually sends `retry-after` on a 429 is UNCONFIRMED** — no
     local capture shows it. A bare 429 falls back to one short (50ms) backoff
     rather than looping, so if the header never appears in practice this item
     delivers little.
  2. The 5-min budget and 60s cap are donor-derived, not measured.
  3. **Intentional latency trade:** the delay is honored even when the upstream's
     window is long, so a genuinely exhausted quota now costs up to 5 minutes of
     latency before erroring. That *is* the item's goal ("transient quota becomes
     latency"), but it is user-visible and depends on the deadline clamp to be
     safe. The loop also sits inside one attempt, so the attempt loop's
     `maxAttempts` does not see it.

### Notes on the blocked / open items

- **Legal-risk items are excluded** from this table's statuses: Factory X-Stainless fingerprint +
  `x-api-key: placeholder` (Factory #4) and Factory client version `0.237.0` UA impersonation
  (Factory #9) both need a legal read before any work.

### Lesson recorded the hard way

Items #2, #5, #8, #11 and #14 were each marked "blocked on undocumented wire behavior" during this
session. Every one of them was answerable from the donor checkout named in this file's own header,
one directory above the repo. `find` over `node_modules` and the home directory found nothing
because nobody looked at the path that was already written down.

Two consequences worth keeping in mind:

- **"Undocumented in our repo" is not "unknown."** Read the donor before writing `blocked`.
- **A guess that compiles can still be wrong on the wire.** #2 was guessed as
  `stop_details.fallback_credit_token` and it is actually a top-level `body.fallback_credit_token`.
  Had that guess been wired, every refusal retry would have 400'd. The same failure mode is why
  the `user-profiles` beta shipped undated for a while: `ensureAnthropicBeta` accepts any string,
  so an unpublished beta value passes every local check and is simply ignored upstream.