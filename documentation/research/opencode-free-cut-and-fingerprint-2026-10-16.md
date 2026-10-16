# OpenCode Free — cut stream and fingerprint mismatch, 2026-10-16

Two open items found while debugging the deployed instance's request
`854999ef-210e-4ed5-83d4-75967d23dfcc`. Neither has a code change yet; this is
the evidence needed to resume.

## The request

| | |
|---|---|
| Provider | `opencodeft` (free tier) |
| Model | `deepseek-v4.1-flash-free` (client asked for `bansos/deepseek-v4.1-flash (max)`) |
| Client | `codex_cli_rs/0.160.0 (Mac OS 27.0.1; arm64)`, `/v1/chat/completions`, stream |
| Egress | via the configured proxy pool |
| ttfb | 3 150 ms |
| Total | 25 225 ms |
| Recorded | `failed` / `transport_unavailable` / 502 / `upstream` |

The upstream streamed ~96 KB of `reasoning_content` and then **closed without a
`finish_reason` and without `[DONE]`** — mid-sentence, on the delta
`" We control the"`. The client received 394 frames. That masking is fixed
(`92986a1e`): the truncated terminal now carries `stop_reason: "error"`, so the
last chunk says `finish_reason: "error"` instead of the `stop` fallback.

## Open item 1 — where the cut comes from

Not one of our timeouts. Defaults and their minimums:

| Setting | Default | Minimum |
|---|---|---|
| `CARTETHYIA_UPSTREAM_TIMEOUT_MS` | 120 000 | 5 000 |
| `CARTETHYIA_STREAM_STALL_TIMEOUT_MS` | 360 000 | 60 000 |
| `CARTETHYIA_STREAM_FIRST_CHUNK_TIMEOUT_MS` | 200 000 | 30 000 |

The only one that could sit near 25 s is the upstream timeout, and it would
need an explicit override below its own default. The stall bound cannot be
25 s at all — its minimum is 60 s.

To settle it:

1. The deployed values of the three settings in the deployment environment. If
   `CARTETHYIA_UPSTREAM_TIMEOUT_MS` is ~25 000, the cut is ours and the fix is
   the value, not the classification.
2. The proxy's log around 25 s into the request — a proxy-side idle or read cap
   would show as a connection close there.

If neither shows a 25 s bound, the cut is the provider's and item 2 is the
likely reason.

## Open item 2 — the OpenCode fingerprint mismatch

The outbound headers carried a client marker that disagrees with its own
user agent:

```text
x-opencode-client: desktop
user-agent: opencode/latest/2.0.30/cli
```

Every other fingerprint header agreed with itself (`x-opencode-session`,
`x-opencode-session-id`, `x-session-affinity`, `x-session-id`,
`x-opencode-project: global`).

The same mismatch appears in the earlier capture
`opencode-claudecode.json`, which failed outright with a 403:
`FreeTierError: OpenCode's free tier can only be used from within OpenCode`.

Hypothesis to test: the free tier validates that its client fingerprint is
self-consistent, and a `desktop` marker with a `cli` user agent is what makes
it refuse — immediately in the earlier capture, and by cutting the stream here.
Worth an A/B: send the same request with `x-opencode-client` set to `cli` and
with the user agent left alone, and compare the outcome. A third arm with both
consistent is the control.

## Prior art in the repo

`test/providers/opencode-fingerprint.test.ts` and
`test/providers/opencode-endpoint.test.ts` pin the current fingerprint
behaviour; read them before changing any header.
