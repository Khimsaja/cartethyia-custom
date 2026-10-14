# Cartethyia

<img width="1760" height="576" alt="Cartethyia banner" src="https://github.com/user-attachments/assets/666f3a3d-136e-49d7-8bec-ff967f93b78f" />

**A self-hosted multi-provider AI gateway.**

Cartethyia gives AI clients one stable, OpenAI- and Anthropic-compatible endpoint while the gateway handles the operational work behind it: provider-aware translation, account selection, health-aware failover, quota and cooldown enforcement, usage accounting, telemetry, and optional proxy pools.

Configure provider accounts once, issue an API key, and point OpenCode, Droid, Cline, Claude Code, Codex, or any compatible client at Cartethyia. The client keeps its native protocol; Cartethyia normalizes the request, selects a viable route, dispatches upstream, and returns the response in the contract the client expects.

Built with Bun, TypeScript, Elysia, embedded SQLite or external PostgreSQL, and optional Redis coordination.

## <img src="https://api.iconify.design/lucide/download.svg?color=%238b949e" width="20" height="20" alt=""> Installation

You need Node/npm and **Bun 1.4.0 or newer**.

```bash
npm install --global cartethyia
cartethyia setup
carte
```

Setup asks for a database mode:

- **Lite** — embedded SQLite. No database server. Fine for one instance.
- **Full** — PostgreSQL you already run. Redis is optional until more than one
process has to coordinate.

`carte` starts the gateway in the system tray and returns the terminal to you.
Closing that terminal does not stop it. `cartethyia start` stays in the
foreground. Config and data live in your OS user directories, not inside the
npm package.

The tray shows the running version and the latest npm release, and can install
an update. **Open Console** opens `http://127.0.0.1:<port>/console`. **Reset
password** and **Backup & Restore** open Console Settings. **Exit** stops the
gateway. This does not install a login/startup service.

To remove it: `npm uninstall --global cartethyia`.

## <img src="https://api.iconify.design/lucide/sparkles.svg?color=%238b949e" width="20" height="20" alt=""> What it actually does


|                                       |                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| <img src="https://api.iconify.design/lucide/languages.svg?color=%238b949e" width="16" height="16" alt=""> **Speaks the provider's own dialect** | Adapters reproduce the client identity, headers, and billing signals a provider expects, instead of sending every request as a generic API call. |
| <img src="https://api.iconify.design/lucide/key-round.svg?color=%238b949e" width="16" height="16" alt=""> **Keeps credentials in their lane** | OAuth and client-specific behavior stays on the matching adapter. Ordinary API-key traffic is not silently treated as an OAuth client. |
| <img src="https://api.iconify.design/lucide/refresh-cw.svg?color=%238b949e" width="16" height="16" alt=""> **Client versions stay current** | Version metadata is refreshed in the background and written into provider headers, instead of pinning an old build forever. |
| <img src="https://api.iconify.design/lucide/activity.svg?color=%238b949e" width="16" height="16" alt=""> **Routing looks at health** | Model, alias, combo, capability, account state, cooldown, quota, and whether a provider is up. |
| <img src="https://api.iconify.design/lucide/repeat.svg?color=%238b949e" width="16" height="16" alt=""> **A retry still counts** | Failover does not skip admission, usage, quota, or telemetry. |
| <img src="https://api.iconify.design/lucide/eye.svg?color=%238b949e" width="16" height="16" alt=""> **You can see the whole hop** | Client request, what we translated, what the provider returned, what the client got. Bounded and redacted. |
| <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%238b949e" width="16" height="16" alt=""> **Failures stay distinct** | Disabled, exhausted, cooling, missing model, and a dead pool are different answers. They are not all "502". |
| <img src="https://api.iconify.design/lucide/globe.svg?color=%238b949e" width="16" height="16" alt=""> **Signed-in web sessions** | Some providers run on a pasted signed-in session and a static catalog. Those sessions are not API keys and they are not refresh grants. |
| <img src="https://api.iconify.design/lucide/database.svg?color=%238b949e" width="16" height="16" alt=""> **Move up without rebuilding** | Start on SQLite. Move to PostgreSQL with a JSON backup. Add Redis only when several processes have to share state. |


Most proxies stop at "send this somewhere else". The tables above exist so you
can answer, without reading upstream logs: what did the client send, what did
Cartethyia translate, which account and pool were picked, what did the provider
return, and what did the client finally get?

**Why it exists:** [Why Cartethyia](documentation/why-cartethyia.md) — the problem it was built for, how it differs from plain forwarders, and the custom-built capabilities shaped by operating it. It also covers the Bun + Elysia choice over Next.js and the reverse-engineering method behind the provider gates.

## <img src="https://api.iconify.design/lucide/route.svg?color=%238b949e" width="20" height="20" alt=""> Routes


| Route                   | For                                       |
| ----------------------- | ----------------------------------------- |
| `/v1/chat/completions`  | OpenAI-style chat                         |
| `/v1/responses`         | Responses API, including Codex tools      |
| `/v1/messages`          | Anthropic Messages, including Claude Code |
| `/v1/models`            | What this key can call                    |
| `/v1/completions`       | Legacy text completions                   |
| `/v1/responses/compact` | Responses compaction                      |
| `/v1/search`            | Web search                                |
| `/v1/systemone`         | System One                                |


The route picks the wire. After that, routing, admission, retry, and accounting
are the same.

## <img src="https://api.iconify.design/lucide/layers.svg?color=%238b949e" width="20" height="20" alt=""> Lite or Full

Same app either way. Lite is not a cut-down edition.


|          | Pick it when                                                                       |
| -------- | ---------------------------------------------------------------------------------- |
| **Lite** | One person, one machine, or you just want it running                               |
| **Full** | Several people, a VPS, or the process is busy enough that SQLite is the bottleneck |


Docker Compose defaults to Full. A local `.env` defaults to Lite. When Lite
gets tight, export a JSON backup and restore it into Full. You do not rebuild
the config.

Details: [Getting started](documentation/getting-started.md#choose-a-database-mode).

## <img src="https://api.iconify.design/lucide/scale.svg?color=%238b949e" width="20" height="20" alt=""> License

[GNU GPL v3.0 only](LICENSE). You can use, change, and share it. If you ship a
build or a fork, ship the source with it, under the same license. No warranty.