# OpenCode free tier (`opencodeft`)

The gate on the free tier is unusual: it inspects **membership of the `tools`
array**, not a header and not a body field. Reproduced 2026-10-16 against
`deepseek-v4.1-flash-free`; see
[`documentation/research/opencode-free-cut-and-fingerprint-2026-10-16.md`](../../../documentation/research/opencode-free-cut-and-fingerprint-2026-10-16.md).

The wire must carry the OpenCode **agent-tool fingerprint set**:

```
edit, glob, grep, read, shell, skill, subagent, webfetch, websearch, write, execute
```

That is `FREE_AGENT_TOOL_NAMES` in
`src/providers/integrations/opencode/provider.ts`. Eleven names.

Absent them, a free-model request is refused:

```json
{"type":"error","error":{"type":"FreeTierError",
 "message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}}
```

HTTP **403**, `errorKind: authentication_failed`.

## What it does NOT read

All three ruled out by replay A/B on the same captured body — do not "fix" any
of them:

| Suspect | Verdict |
|---|---|
| `Authorization` (no header on the real capture; `Bearer public` optional) | Irrelevant. Adding it still 403s. |
| `accept: text/event-stream` | Irrelevant. |
| `x-opencode-client: desktop` + `user-agent: opencode/latest/2.0.30/cli` mismatch | Harmless — a non-free model answers 200 with it. |

## The trap: a clamp that keeps "used" tools drops the fingerprint

`ensureFreeAgentRequest` backfills missing fingerprint names, but
`clampOpenCodeTools` (cap `OPENCODE_MAX_TOOLS = 128`) runs on the payload and
keeps only tools referenced by the conversation. A client that arrives with its
own large catalog and references none of them gets **every fingerprint tool
trimmed away** — the backfill happened upstream of the clamp, so the wire ends
up with zero fingerprint tools and the dispatch 403s.

So the failure is not "the adapter forgot to add the fingerprint" — it added
them and then threw them away. Fixed 2026-10-16 by treating
`FREE_AGENT_TOOL_NAMES` as protected alongside called tools in the clamp.

**Any future trim/dedupe/filter over `payload.tools` must preserve that set.**
Regression test: `test/providers/opencode-tool-limit.test.ts`.

## Replaying it

The real session record is a Request Detail export whose
`payloads.providerRequest` is `{method, url, headers, body}` — replay that
verbatim, then A/B only the `tools` array:

| Arm | Result |
|---|---|
| 128 Claude Code tools, verbatim headers | 403 |
| + `authorization` | 403 |
| + `accept` | 403 |
| + auth + accept | 403 |
| fingerprint 11 only | **200** |
| 128 foreign tools + fingerprint 11 (139) | **200** |

The 11 fingerprint tools are accepted **alongside** the client's own tools — the
gate is a membership test, not an exact-match test.

Use `bun -e` with `fetch`, not `curl -o <file>`: on Windows the latter
intermittently returns exit 43 / HTTP 000 (schannel renegotiation) and looks
like an unreachable host.

## Wire and model facts

- Free models here are **chat-only**: `responses` returns 400
  `ModelProtocolUnsupported`. `wireFamily` for free ids is `chat`.
- Live ids: `GET https://opencode.ai/zen/v1/models`. Context/output limits:
  `https://models.dev/api.json` (`opencode` provider) — do not guess these.
- Known-good real-client capture:
  `documentation/archive/opencode-freetier-exact-request-2.0.26.json`.
