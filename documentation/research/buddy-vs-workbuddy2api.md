# Buddy family: our implementation vs `workbuddy2api`

Reference: `Public/workbuddy2api` (Go, standalone WorkBuddy/CodeBuddy gateway, 210
files under `internal/`).
Ours: `src/providers/integrations/buddy/**` plus the providers that consume it.

Method: five parallel read-only investigators, one per area. Every claim below was
re-checked by hand against both trees; the ones I could not confirm are marked
*unverified*.

**Headline: the gap is not where you'd expect.** In *media generation* we are
ahead — the reference has **no** image or video surface at all. The real gaps are
in **upstream growth/credit endpoints**, **account-pool economics**, **error-code
handling**, and a handful of **catalog ids**.

---

## A. In the reference, missing in ours (port candidates, ranked)

### A1. Growth / credit endpoints — 15 upstream calls we never make
All verified absent from `src/` (no `activity/growth`, `claim-gift`,
`claim-compensation`, `makeup`, `lottery`, `billing/ide/trial`).

**Growth domain** (`/activity/growth/*`):
`GET /streak` (streak days, redemption tiers, makeup-card balance) ·
`GET /heatmap` (per-day score; `0` = missed day) ·
`POST /makeup-cards/use` (restore streak) ·
`POST /redeem` (`7d`/`14d`/`28d` → credits, energy, cards, chances; 409 = already
claimed) · `GET /lottery/chances` · `POST /lottery/draw` ·
`GET /buddy/travel/status` · `POST /buddy/travel/depart` ·
`POST /buddy/travel/claim` · `GET /buddy/info` · `POST /buddy/first` (**+300
credits** for adopting the cat) · `POST /buddy/agreement`.

**Billing domain**: `POST /billing/meter/claim-gift` (newcomer gift) ·
`POST /billing/meter/claim-compensation` · `POST /billing/ide/trial` (global
only; `14051` = already claimed, treated as success).

These are "free credits for scheduled work" — the reference's headline value
proposition. We have only check-in + activity report.

### A2. Account-isolated `prompt_cache_key`
Reference `upstream/cache_key.go` injects
`wb2a-<uid8>-<sha256(uid|conv)[:16]>` into **every** outbound body when the client
supplied none, and calls the uid segment a *hard isolation factor* (documented
~17× cost reduction).

Ours only forwards a client-supplied key (`protocol/request/chat.ts:405`,
`session-resolution.ts:69`). **Consequence: the same session id on two pooled
accounts produces the same cache key** — cross-account prefix-cache reuse.
Verified: no `wb2a-` prefix anywhere in `src/`.

### A3. Upstream error codes we do not recognize
Verified absent from `src/`: `11135` (invalid image), `11102` (model blocked),
`12153` (session dead), `14017` (account fault), `11133` (model param invalid),
`11101` (bad params), and any WAF-envelope heuristic (`403` without a business
envelope).

The reference treats several of these as **request-scoped**: no account penalty,
no rotation — because they are deterministic for that body. Notably:
- `11148` (tool call / result mismatch) → request-scoped; ours has no
  classification, so a `11148` that slips past our pre-flight repairs falls into
  the generic 400 path and **burns an account cooldown**.
- `11128` (content blocked) → reference does an in-request **degraded-prompt
  retry** on first hit and only 400s on the second; ours cools the account
  (`account-health-service.ts:445-460`). Also the reference rewrites the literal
  string `11128` → `11-128` in the outbound body, because upstream blocks any
  request that mentions its own code. We have neither.

No `gateway_hint` concept in our responses at all.

### A4. Cost ledger / free-tier-first selection
Reference keeps a per-`(account, model)` cost EMA (from `usage.credit`),
persisted, feeding tier 0 (measured free) / 1 (unknown) / 2 (paid) selection, plus
conditional exploration so new accounts aren't starved.

Ours: none. Verified — no `costPer1k`/`modelCost` anywhere. We also do **not
parse upstream `usage.credit`** at all, which is the input the whole feature needs.
This is the single largest *architectural* difference in pool behavior.

### A5. Quota parsing: we never read the `*Remain` fields
Reference prefers `CycleCapacity{Remain,Used,Size}`, clamps `remain` to
`[0,size]`, and reconciles when `CycleUsed > used` (`client.go:1666`).
Ours reads only the `*Precise` used/size pairs (`billingNum`) and derives
`remain = limit - used` downstream, so **dirty `Used > Size` data is not clamped**.
Verified: no `Remain` field read in `buddy-quota-shared.ts`.

### A6. Model ids missing from our catalog
Verified absent from `src/providers/integrations/buddy/`:
`hy4-preview-x`, `hy3-preview`, `hy3-x`, `deep-model`.

Present **only** in the CN table, missing from the shared/intl list:
`deepseek-v4-flash`, `deepseek-v4-pro` (both appear in `buddy-chat-shared.ts`
effort tables but not the intl catalog).

Conflicting context/output numbers (reference vs ours):
`hy3` → 192000/64000 vs our intl 1_000_000/64_000;
`kimi-k2.8-preview` → 1048576/output-omitted vs our 256000/65536.

### A7. Effort ladders narrower, and never attached to the catalog row
Reference: ~21 CN + ~21 global rows, each with a `defaultEffort`, and the remote
model list is authoritative when present. Ours: 9 CN + 5 intl hardcoded rows in
`buddy-chat-shared.ts`, **no default column, no discovery-fed bucket**. Missing
coverage includes `glm-5.3-flash`, `kimi-k3`/`kimi-k2.7`/`kimi-k2.6`,
`fast-model`/`balanced-model`/`primary-model`, `gpt-5.6-*`.

Also: `ModelDefinition` supports `reasoningEfforts` and other integrations use it
(grok, kiro, opencode) — **buddy never sets it**, so nothing downstream can see
the ladder.

### A8. Task run ledger + same-day retry
Reference `internal/taskledger`: per-task-kind last run (started/finished/elapsed,
OK/Already/Fail/Skipped, trigger = schedule/retry/manual, `AllFailed`), persisted
atomically, plus same-day retry planning that counts at *schedule* time.

Ours: `SweepResult` per pass only, nothing persisted, no `Already` concept, no
`AllFailed`, no same-day retry. The nearest thing is the once-per-day check-in
marker (`daily_checkin_ledger`), which is idempotency for one side-effect, not a
run ledger.

### A9. Admin routes we don't expose
`POST /admin/accounts/{uid}/{disable,enable,revive,refresh}` and
`POST /admin/tasks/{name}/run` (manual task trigger, async 202, 409 if already
running). We have only `/admin/drain`. Verified absent.

### A10. Smaller items
- **`realm` is never actually passed as `"cn"`** — `buddyPrePayloadCommon(payload,
  request, realm)` defaults to `"intl"` and no caller passes `"cn"`, so CN requests
  are clamped against the *intl* ladder. `x-buddy-realm` is set but never read.
  (Fails safe today, but CN-only ladders are dead code.)
- **Proactive refresh skips non-active accounts** — `loadDueOAuthAccounts` filters
  `status = "active"` (`oauth-refresh-service.ts:449`), so `cooldown`/`disabled`
  accounts get no proactive refresh; the reference keepalives everything except
  `disabled`.
- **No device-token file fallback** — reference reads `/app/data/device_token`
  (5-min cache, >1 KB ignored); we read only `auth_state.deviceToken`.
- **No conversation header family** — reference sends
  `X-Conversation-Request-ID`, `X-Root-Request-ID`, `X-Trace-ID`, `X-B3-*`,
  `X-Conversation-Message-ID`. We send only `x-conversation-id` + `x-request-id`.
- **No outbound fingerprint scrubber** on the buddy path (reference
  `sanitizeMessages` covers content, `reasoning_content`, and tool-call arguments).
- **No non-chat model filter** in discovery (reference drops `nes-`/`completion-`/
  `codewise-` prefixes, `maxOutput ≤ 256`, and `text-to-image` tags).

---

## B. Roughly equivalent (both sides)

`max_completion_tokens` → `max_tokens` translation · `developer` → `system` role
mapping · `image_url` string → object · orphan tool call/result repack +
cleanup · `stream_options.include_usage` · DeepSeek `thinking.type=enabled`
injection · effort downgrade algorithm (highest supported ≤ requested, else
lowest) · per-`(account, model)` cooldown with success *not* clearing it ·
daily check-in with idempotency · `reasoning_content` handling in SSE.

---

## C. In ours, absent in the reference (we are ahead)

This bucket is bigger than expected — worth knowing before porting anything.

- **Image and video generation.** The reference has **zero** generation surfaces
  and actively *filters* `text-to-image` models out of its model list. We route
  `imageGeneration`/`videoGeneration` as first-class service kinds.
- **Hosted web-search rewrite** (`web_search` → ordinary function tool). No
  `web_search` anywhere in the reference.
- **Tool name sanitization + 64-char cap + collision suffixing**; reference has
  none.
- **Static-token detection** with JWT `exp` classification, boot reconciliation
  (`reconcileStaticTokenAccounts`), and mark-on-refresh-failure. The reference has
  no static-token concept at all.
- **Cross-process OAuth refresh leasing** with fenced CAS + single-flight; the
  reference has no leasing (single process).
- **Drop nameless tool calls** (upstream `11133`) and **drop empty-content
  messages** (upstream `11151`) — both our own discoveries, not ported.
- **`tool_choice: "none"` keeps the tools array** — ours deliberately, with a
  comment that deleting them makes DeepSeek emit unparseable DSML; the reference
  deletes tools.
- **Enterprise usage endpoint** `get-enterprise-user-usage`; not in reference.
- **Consecutive-role merging** (ours merges, reference explicitly refuses to).
- **max_tokens floor when effort is raised** (`clampedEffortOutputFloor`).

---

## Two caveats before acting

1. **The reference is pure-dynamic for its model list.** Its static tables are
   *fallbacks* for context/effort, not a roster. "Missing from the reference"
   does **not** mean the model isn't served — it means no fallback value exists.
   Model-id gaps (A6) should be confirmed against a live account, not the tables.
2. **Our video path is documented as unverified.** `buddy-media.ts` header says
   the polling route is "an implementation inference, not an observed contract",
   and `documentation/features/buddy-media-generation.md` records video returning
   404 in attempted checks. The reference can't help here — it has no video.

## Suggested port order

1. **A2** `prompt_cache_key` isolation — small, real correctness/cost issue.
2. **A3** `11148`/`11128`/`11135`/`11102`/`12153` classification — stops burning
   account cooldowns on request-scoped failures.
3. **A5** quota `*Remain` clamping — small, data-correctness.
4. **A1** growth endpoints — largest value, but a new scheduler surface; do it as
   its own task, behind a flag (consistent with the sweep cutoff work).
5. **A6/A7** catalog + effort ladders — confirm against a live account first.
6. **A4** cost ledger — needs A5-style `usage.credit` parsing as a prerequisite.
