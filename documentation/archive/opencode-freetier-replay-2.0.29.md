# OpenCode free-tier replay — 2.0.29

> [!WARNING]
> **No 200 OK was reached.** This documents the *method* and the *evidence*,
> not a working bypass. Every replay attempt returned `403 FreeTierError`.
> Read "What did not work" before changing `fingerprint.ts`.

**Status:** evidence gathered, free-tier gate not defeated.
**Date:** 2026-10-14. **Artifacts:** macOS DMG + Linux RPM, OpenCode **2.0.29**.

## Question

`opencodeft/muse-spark-1.3-contributor-free` fails via the Responses wire with:

```
403 FreeTierError — OpenCode's free tier can only be used from within OpenCode.
```

Goal: find what the real client sends and what upstream now expects, so
Cartethyia's fingerprint can be made 1:1.

## Artifacts and provenance

| Artifact | SHA-256 / name | Notes |
| --- | --- | --- |
| `opencode-desktop-mac-arm64.dmg` | `edd274ba…b6c9e8` | 263,188,968 B; UDIF (`koly` v4), Apple_HFS |
| `opencode-desktop-linux-x86_64.rpm` | `opencode-2.0.29-1` | 194,084,941 B; xz-compressed cpio |

Both differ from the previously inspected 2.0.28 DMG (`1ABBC91E…`), so the
earlier notes (`opencode-cache-replay-2.0.28.md`) no longer describe this build.

## Method — macOS DMG (UDIF → HFS+ → ASAR)

None of `7z`, `hdiutil`, `dmg2img`, or `p7zip` were available. Done in Python.

1. **Pin the artifact.** `sha256sum` + `file`. `file` misleadingly reports
   "zlib compressed data"; the UDIF trailer sits in the **last 512 bytes**.
2. **Parse the UDIF trailer** (`koly`). Read `xmlOffset`/`xmlLength` at trailer
   offset `0xD8`/`0xE0`. Here: `xmlOffset=263142360`, `xmlLength=46096`.
   Note: `sectorCount` at `0x214` is garbage in this file — do not trust it.
3. **Parse the plist** with `plistlib`. Its `resource-fork.blkx` array lists
   partitions; the payload is `disk image (Apple_HFS : 4)`.
4. **Parse the `mish` chunk table.** Each BLKX entry is 40 bytes:
   `type:4, comment:4, sectorStart:8, sectorCount:8, compOffset:8, compLength:8`
   (unpack `>IIQQQQ`, **not** `>IIIIQQ` — that is 32 bytes and silently fails).
   Chunk entries begin at offset **204** in the base64-decoded `mish` blob.
   Type `0x80000005` = zlib, `1` = raw copy, `2`/`0` = zero fill.
5. **Decompress to a raw HFS+ image** (672,321,536 B). Verify with the `H+`
   magic at offset 1024.
6. **Find the ASAR.** Scan for `{"files":` preceded by a 16-byte header whose
   first `uint32` is `4`; or search `app.asar` in the HFS catalog. Found at
   image offset **5853184**. Layout:
   `[uint32 4][headerSize][headerSize2][jsonLen][header JSON][data]`.
   Data starts at `base + 16 + jsonLen`.
7. **Walk the file index** (`files` → `files` → …) and extract by
   `offset`/`size` from the data region.

First-party code lives in `/out/main/` (main process) and
`/out/renderer/assets/` (UI). 8,300 files; 2,556 outside `node_modules`.

## Method — Linux RPM (xz → cpio)

Faster than the DMG when the ELF/ASAR hunt stalls.

1. Magic `\xed\xab\xee\xdb`; name `opencode-2.0.29-1` in the lead.
2. Payload is xz-compressed; decompress from the first xz stream
   (offset **23093**) with `lzma.LZMADecompressor` — `zstd` frames at
   121811793 are **not** the payload and error with "Data corruption".
3. The resulting cpio image holds one ELF (runtime) and the ASAR at
   **295091460**, same layout as macOS.

## What was found (static)

### Request headers actually built

From the CLI string cluster (macOS binary, ~255497148) and the Linux bundles:

```
x-opencode-session-id
x-opencode-parent-session-id
x-session-affinity
X-Session-Id
x-parent-session-id
User-Agent
x-opencode-project
x-opencode-session
x-opencode-client
promptCacheKey
webSocket (handshake / send / receive)
```

Two id formats matter:

- `^ses_[0-9a-f]{64}$` — the **internal** CLI session literal.
- `^tool_[0-9a-f]{12}$` — tool ids.

### `x-opencode-request` is gone from the builder

Not present in the 2.0.29 header cluster. (Cartethyia's adapter still sends it
because our own `fingerprint.ts` emits it — it is not evidence about upstream.)

### `x-opencode-ticket` is NOT an upstream header

25 occurrences in the macOS image, 11 in the Linux binary. Every context is
the **local PTY server**, never `opencode.ai/zen/v1`:

```
/api/pty/:ptyID/connect
/api/pty/:ptyID/connect-token
/api/experimental/persistent-pty/:ptyID/connect-token
headers: {"x-opencode-ticket": e["x-opencode-ticket"]}
binaryType: "arraybuffer", input_protocol, openSocket, connectToken
```

Do not add it to the dispatch fingerprint.

### The desktop app never calls `/zen/v1`

Scanning every bundle and both binaries: all `opencode.ai` URLs are theme,
docs, update, `oauth/client.json`, `console`, `config.json`, `v2/openapi.json`,
and `models.opencode.ai/api.json`. **Zero** `/zen/…` request paths in the
desktop shell. Free-tier traffic is issued by the bundled **server/engine**,
not by the app — which is why a desktop-only capture can never answer this.

## Cross-check: `opencode2api`

`https://github.com/jasonxu114514/opencode2api` (Go) was inspected for its
builder. Relevant, verified facts from its source:

- `internal/gateway/upstream.go:808-820` sets `x-opencode-client: cli`,
  `x-opencode-session`, `x-session-affinity`, `X-Session-Id`,
  `x-opencode-request`, `x-opencode-project`, and (for non-Anthropic)
  `Authorization: Bearer <key>`.
- `internal/identity/request.go` documents the **canonical session**:
  `ses_` + 12 lowercase hex + 14 base62, where the hex is the inverted 48-bit
  `~(ts_ms<<12 | counter)`. Its comment states the Zen free tier rejects other
  shapes **since 2026-09-16**, and accepts counters **1–63**
  (low 12 bits `0xFC0`–`0xFFF`; counter 1 ends `ffe`).
- `anonymousCoreTools = ["bash","edit","glob","grep","read"]`.
- Anonymous lane uses `anonymousZenKey = "public"` (`Bearer public`) and needs
  no real credential. **This value is inert** — see below.
- Its `UserAgent()` is `opencode/1.18.31 (<os> <arch>; <goversion>)`.

## What was tried (all 403 unless noted)

Live probes, UA `opencode/latest/2.0.29/cli`, `stream: true` throughout,
endpoint `POST https://opencode.ai/zen/v1/responses`.

| Probe | Result |
| --- | --- |
| `GET /zen/v1/models` | **200** — 85 models; 9 end in `-free`; `muse-spark-1.3-contributor-free` listed |
| Paid `muse-spark-1.3` (no `-free`) | **401** `AuthError: Missing API key` |
| Free `ling-3.0-flash-free` (chat wire) | **400** `Model is unavailable` |
| **All 9 `-free` models**, responses wire | **403** `FreeTierError` |
| No opencode headers at all | **403** |
| `x-opencode-client: desktop` / `cli` | **403** |
| Session 26-char (ours) vs 64-hex (CLI literal) | **403** both |
| Session descending counters 1 / 2 / 63 / 64 (`…fffe/fffd/ffc0/ffbf`) | **403** all |
| `msg_` request id, ascending and descending | **403** both |
| `+ x-opencode-request`, `+ x-opencode-project`, `+ x-opencode-directory` | **403** |
| `+ x-opencode-ticket` (16 hex / 32 hex / `tkt_`) | **403** |
| `+ Authorization: Bearer public` | **403** — inert, ignore |
| UA `2.0.26` / `2.0.28` / `2.0.29` / `opencode/1.18.31` | **403** all |
| ± tools (2, 4, and the 5 core tools) | **403** |
| ± `store:false`, `instructions`, `tool_choice:auto`, `parallel_tool_calls`, `reasoning`, `max_output_tokens`, `prompt_cache_key`, `stream_options` | **403** |
| Chat wire with tools vs Responses wire | **403** both |
| **Byte-identical replay of a real failed request** (from `telemetry-22107cf3…json`) | **403** |
| Same request stripped to bare `{model,input,stream}` | **403** |

The gate answers `FreeTierError` for the whole `-free` class while the paid
route answers `401 Missing API key`, so the endpoint is live and discriminating:
it is not a block on our address alone, and it is not a malformed-payload 4xx.

### Capture attempts (why no runtime trace)

- `mitmdump -s cap.py --listen-port 8899` works and records flows (verified with
  a manual `curl -x` — HTTP 200 captured).
- `opencode.exe` is a **self-contained PE32+** (8,192 B stub) and ignores
  `HTTP_PROXY`/`HTTPS_PROXY`; `NODE_OPTIONS=--require preload.cjs` with an
  undici `ProxyAgent` also did not intercept it.
- Running the CLI directly **succeeds** (`PONG`), so the client can use the
  free tier from this machine — but its traffic never traversed the proxy.
- Not attempted (needs authorization): editing the `hosts` file to point
  `opencode.ai` at `127.0.0.1` plus a TLS listener, which would intercept any
  client regardless of proxy support.

## Verdict

**Evidence exhausted.** ~35 replay variants, byte-exact replay included, all
403. The free-tier credential is **not a static header, id format, tool list,
or body field**: it is bound to something the real client holds at runtime, so
replaying an observed request cannot work.

Nothing here justifies a fingerprint change as a *fix* for the 403.

## Actionable defects found (independent of the 403)

These are real mismatches against 2.0.29 / `opencode2api`, worth fixing on
their own merits:

1. **Session counter is unbounded.** `fingerprint.ts` increments
   `sequenceCounter` with no cap, so the inverted time part drifts outside the
   documented counter window (1–63). Clamp it.
2. **Core agent tools are short.** Anonymous free tier expects
   `bash, edit, glob, grep, read`; the adapter backfills only two.
3. **Chat wire usage.** When a non-streaming request is forced onto Chat SSE,
   `stream_options.include_usage` must be set.
4. **Anonymous needs no `Authorization`.** Do not send one (and never send a
   `Bearer public` placeholder).

## Evidence ledger

| Claim | Source | Grade |
| --- | --- | --- |
| Format ses_ 64 hex, tool_ 12 hex | CLI binary literals | static-confirmed |
| Header cluster (9 names) | CLI string cluster | static-confirmed |
| `x-opencode-request` absent in 2.0.29 | CLI cluster + Linux bundles | static-confirmed |
| `x-opencode-ticket` = local PTY | PTY paths in both builds + probes | static-confirmed |
| Desktop app never calls `/zen/v1` | full bundle/binary URL scan | static-confirmed |
| All `-free` models 403 with valid tools | live probes | runtime-confirmed |
| Paid model 401, chat-free 400 | live probes | runtime-confirmed |
| `Bearer public` inert | live probe | runtime-confirmed |
| Cause of the gate | — | **unknown** |

## Next evidence needed (in order)

1. An authorized `hosts`-based interception of the real client's traffic
   (the only method that survives a proxy-ignoring binary).
2. Failing that, a request capture from an instrumented run of the bundled
   **server** process, which is the component that actually calls `/zen/v1`.
3. Do not guess a "natural sibling" header or path and describe it as observed.

## Owners

`src/providers/integrations/opencode/fingerprint.ts`,
`src/providers/integrations/opencode/provider.ts`,
`test/providers/opencode-fingerprint.test.ts`,
`documentation/reference/providers.md`.
