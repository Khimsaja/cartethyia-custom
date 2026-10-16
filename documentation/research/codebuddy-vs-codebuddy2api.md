# CodeBuddy: our implementation vs `codebuddy2api`

Reference: `Public/codebuddy2api` (Python/FastAPI; `converter.py` 232 KB + 50
modules under `app/`).
Ours: `src/providers/integrations/buddy/**`, especially `codebuddy/`.

Method: five parallel read-only investigators, one per area. Claims were
re-checked by hand against both trees; unverifiable ones are marked.

**Headline: same shape as the WorkBuddy diff, and one real bug.** The reference is
a *single-tenant gateway* — one shared API key, no tenants, no share keys, no
pools — and it is **strict** where we are **repair-first**. We are far ahead on
multi-tenancy, auth, and observability. The gaps are concentrated in
**upstream credit endpoints**, **model governance**, and **per-(backend, model)
unsupported backoff**. One finding is a genuine defect in our code, not a
missing feature.

---

## A. In the reference, missing in ours (ranked)

### A1. 🔴 BUG: the CN effort ladder is dead code
`buddyPrePayloadCommon(payload, request, realm: "intl" | "cn" = "intl")` — verified:
**every call site passes two arguments** (`codebuddy/cn-provider.ts:85`,
`codebuddy/provider.ts:75`, `workbuddy/provider.ts:125`; `buddy-media.ts:162`
passes one). So `BUDDY_CN_EFFORTS` never applies.

Consequences, both real:
- `deepseek-v4.1-flash` on CN is clamped against the intl table
  (`["high"]`) instead of its CN ladder (`["low","high","max"]`).
- `glm-5.1`, `glm-5.3-flash`, `deepseek-v4-flash`, `deepseek-v4-pro` are
  "unknown model" on the intl table → passthrough, never clamped.

Also: `buddyModelOutputLimit` reads only `BUDDY_SHARED_RAW`, so CN-only ids
(`deepseek-v4-flash`, `deepseek-v4-pro`, `uto`, `space-bunny`, `kimi-k3-1`) have
no output limit and the raised-effort floor never applies.

This is cheap to fix and is the only item here that is *wrong* rather than
*absent*.

### A2. `get-user-request-usage` — real credit deductions
`POST {billingHost}/billing/meter/get-user-request-usage` (days 1–30, paginated
200, up to 30 pages) returns per-day, per-model actual deductions
(`requestTime`, `model`, `credit`). Drives the reference's real usage view.

**We have no upstream usage-detail read at all** — verified: no
`request-usage`/`by_day` anywhere in `src/`. Instead we synthesize
`POST {base}/v2/report` growth events (2 rounds × 4). The reference has no
`/v2/report` call — that one is ours alone.

### A3. Model governance: four layers, we have ~1.5
1. **`ModelBlocks`** — per-(backend, model) confirmed-unsupported backoff:
   6 h → doubling per hit → 24 h cap, keyed per-endpoint **and per-account for
   intl** (so one account's rejection doesn't poison the backend). Triggered by
   **`11102`** or `service info not found` / `model … not (found|supported)`.
   Cleared on success. When every backend is blocked → 404 with retry time.
   **We have no `11102` detection and no block table** (verified: no `11102` or
   `model_block` in `src/`).
2. **Per-model 429 cooldown** keyed `(credential, routed_model)`, 600 s →
   `Retry-After` honored → 86 400 s cap, persisted, bounded 64 rows/account.
   We have `model_cooldowns` JSONB, but **no per-hit escalation** and
   **no clearing on success** (only full reset or the expiry sweep).
3. **Per-model routing policy** — a first-class rule object
   (`public_id`, `upstream_id`, region pin, profile pin, credential allowlist,
   enable/disable, `keep_original`). We have aliases/combos but nothing
   capability- or credential-scoped.
4. **Catalog guards** — off-catalog id → 404/503; **non-tool-call models are
   never routed or listed**. We have no such gate: `buildCapabilityProfile`
   hardcodes `tools: true, reasoning: true` (`route-catalog.ts:140-148`), so a
   `toolCall: false` row is deliberately never enforced.

### A4. Model ids (CN side) we don't serve
Reference `DEFAULT_MODELS` (CN legacy fallback) carries, and we don't:
`hy4-preview-x`, `hy3-x`, `deepseek-v3-2-volc`, `glm-5.0`, `glm-5.0-turbo`,
`glm-4.7`, `glm-4.6`, `glm-4.6v`, `minimax-m2.7`, `minimax-m2.5`,
`kimi-k2-thinking`, `hunyuan-chat`, `default`.

Also: the reference rewrites `auto` → `default-model` for intl profiles
consistently (eligibility, cooldowns, block keys, catalog). **We treat `auto`
and `default-model` as two independent rows** — no aliasing.

Caveat: the reference has **no static international roster at all** (it is
account/discovery-driven), so "missing there" mostly means "no fallback value" —
confirm against a live account, not the table.

### A5. Per-model attributes we lack
From the reference's `sanitize_model`: `maxAllowedSize`, `disabledMultimodal`,
**`onlyReasoning`** and **`canDisableThinking`** (we carry a single `reasoning`
boolean), `supportsExtra`, `isDefault`, `contextWindow.supportedLengths`,
`relatedModels`, `vendor`/`description`/`tags`/`iconUrl`, and a **per-model
credit multiplier** (we have USD `cost` only).

### A6. Strictness we don't enforce
- **Unsupported effort** → reference returns **400 `unsupported_reasoning_effort`**;
  we silently substitute the highest supported level ≤ requested (and raise
  `max_tokens` to compensate). Asking `xhigh` on `deepseek-v4.1-flash` silently
  yields `high`.
- **Output limit** → reference 400s when `max_tokens` exceeds the declared
  `maxOutputTokens`; we never enforce it.
- **Thinking budget** → reference requires `budget_tokens >= 1024` with
  `type=enabled`, rejects a bare budget, and validates `display`.
- **Tool pairing** → reference *rejects* mismatches (400); we repair them.
  Reference validates streamed calls (`_tool_calls_healthy`: unique non-empty ids,
  non-empty names, `arguments` parses to a dict); we track but don't validate.

### A7. Non-chat upstream endpoints we never call
Daily-chat/activity via console + ACP (`workbuddy.ai` only):
`POST /console/as/conversations/`, `GET …/{id}/session`, `GET …/{id}`, then
ACP JSON-RPC (`initialize`, `session/load`, `session/prompt`) reading
`usage_update.cost.amount`.

Buddy onboarding (`workbuddy.cn`): `GET /activity/growth/buddy/{info,list}`,
`GET /v2/activity/growth/tasks`, `GET|POST /activity/growth/buddy/agreement`,
`POST /activity/growth/buddy/first`.

Travel: `GET …/travel/{status,config}`, `POST …/travel/claim`.

Plus `GET {billingHost}/console/accounts` (enterprise fallback) and
`GET {profileHost}/v3/config` (official catalog).

### A8. Persistence we lack
Reference `control_store`: `buddy_bootstrap`, `travel_writes`, `buddy_consents`,
`buddy_tasks`, `daily_chats` (phase machine, `usage_before/after`, `acp_usage`),
`model_blocks`, `credits`, `trial`, `catalog`, `usage`, `gateway_secrets`,
plus a **revisioned global config document** with optimistic concurrency.

`audit_store`: per-request `attempts` ledger, `ingest` dedup, epoch/generation,
and **`stats_hourly` / `stats_daily` / `stats_totals` rollup tables** — we
compute rollups on read and keep only `telemetryUsageTotals`.

Also absent: sticky session bindings (our schema comment says sticky routing is
gone) and any **audit storage health / retention / archive** surface.

### A9. Log redaction on the write path
Reference `safe_logging.py` scrubs `authorization`, tokens, cookies,
`Bearer/Basic`, JWTs (`eyJ…`), provider token prefixes (`cb-`, `sk-`, `AIza`,
`AKIA`, `ghp_`, `xoxb-`), inline base64 image data URLs — before writing.

Ours: `maskClientIp` is **presentation only** (storage keeps raw), and
`redaction.ts` documents that the payload redactor was deliberately removed.
**No write-path secret scanning.**

### A10. Smaller items
- **No image-count policy** — reference caps at 16 with
  `[Image omitted by request image limit.]`; we only *count* images for telemetry.
- **No global concurrency cap** — reference has `max_concurrent` 64 → 503 +
  `retry-after: 3`; we have per-key/per-tenant/per-provider but no process-wide cap.
- **Inbound body limit 1 MiB vs their 64 MiB** (ours is stricter — deliberate,
  but worth knowing if a client sends a large tool round).
- **No routing preview endpoint** (`/admin/models/preview` returns accepted vs
  excluded credentials with a reason per credential).
- **No `reset-cooldown` surface** for per-model 429 cooldowns.
- **We don't persist the account `uid`** — reference fetches `/login/account` and
  refuses to save without it; we derive uid from the JWT `sub` at use time
  (`buddy-oauth-shared.ts:109-113`) and persist only a cosmetic `accountEmail`.

---

## B. Roughly equivalent

Core inference routes (`/v1/models`, `/v1/chat/completions`, `/v1/responses`,
`/v1/messages`, `/v1/messages/count_tokens`) · daily check-in + status endpoints ·
enterprise quota read · OAuth device flow (ours recognizes pending code `11217`,
theirs just sees "no token yet") · `X-Refresh-Token` +
`X-Auth-Refresh-Source: plugin` · per-(account, model) cooldown ·
Anthropic `image` → `image_url` conversion · `developer` → `system`.

---

## C. In ours, absent in the reference (we are ahead — big bucket)

- **Multi-tenancy**: tenants, hashed-password console users, sessions, lockouts.
  The reference is **one shared API key**, no user store.
- **API keys**: personal + share, parent/child, per-key RPM/daily/monthly/
  lifetime budgets, model whitelist/blacklist, prefix, client-router denylist,
  share links + popup image. Reference: one key, no share concept.
- **Network pools** (HTTP/HTTPS/SOCKS5, health check, speed test, relay),
  **routing aliases/combos/reorder/clone**, **CLI tool injection**, **backup
  export/import**.
- **Prometheus `/metrics`** — the reference exposes **no** metrics endpoint.
- **`/health/ready`** (dependency + migration + drain-aware 503) and
  **`POST /admin/drain`**.
- **Abuse handling**: per-(identity, route) sliding window + escalation → ban,
  invalid-model strike ban, console mutation throttle. Reference has none on the
  inference path.
- **WebSocket egress** with SSRF-validated dial — no WebSocket path found in the
  reference.
- **Extra inference surfaces**: `/v1/responses/compact`, `/v1/systemone`,
  `/v1/search`, `/v1/images/generations`, `/v1/videos/generations`,
  `/v1/completions`. The reference exposes only the 4 core routes.
- **Static-token detection** + boot reconciliation, and **cross-process OAuth
  refresh leasing** (fenced CAS + single-flight). Reference has neither.
- **Structured cancellation**: `AbortSignal` bridging, 499 for client disconnect,
  drain emits a terminal frame, in-flight backstop sweep.
- **`/v2/report`** activity reporting (ours) vs their ACP-driven daily chat.

---

## Two caveats before acting

1. **The reference has no static international roster.** Its `DEFAULT_MODELS` is
   a *domestic legacy fallback* only. Everything else comes from account catalogs.
   So A4 must be confirmed against a live account; absence from their table mostly
   means "no fallback value", not "not served".
2. **Philosophy differs deliberately, not accidentally.** They reject
   (400 on bad tool pairing, unsupported effort, over-limit output); we repair and
   degrade. For a gateway serving many clients that is arguably the right call —
   but it means "port their strictness" is a product decision, not a bug fix.

## Suggested order

1. **A1** — wire `realm` through, and give CN-only ids an output limit. Real bug,
   cheap.
2. **A3.1** — `11102` / `service info not found` → per-(backend, model) backoff.
   Stops repeated dialing of a model the backend doesn't serve.
3. **A2** — `get-user-request-usage`. Real credit numbers instead of synthetic
   events; also a prerequisite for any cost-aware work.
4. **A9** — write-path secret scrubbing for telemetry/logs.
5. **A4/A5** — model ids and attributes: confirm against a live account first.
6. **A6** — decide deliberately whether to adopt any strictness; do not port by
   reflex.
