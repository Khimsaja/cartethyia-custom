## Unreleased

- Web-search requests from chat clients (Claude Code, Codex CLI) now route
  through the selected model first: a route whose *provider* serves hosted
  search keeps its native tool, and a route that cannot serve it runs the
  query on an operator-configured search provider (exa → gemini → codex →
  tavily → brave) and continues on the selected route with the results
  injected as a user context turn. The direct `POST /v1/search` API is
  unchanged.
- Web-search capability is now a property of the provider, not the model row:
  `models.web_search` is dropped (migration `0039`), and native search is
  decided by `providerSupportsWebSearch`. Discovery previously wrote `false`
  for models it had no metadata for, which filtered capable routes out of
  native search on a metadata gap.
- Hosted search tools are translated per wire instead of being forwarded
  verbatim: Codex receives `{"type":"web_search"}` (it rejects both the raw
  Anthropic payload and `web_search_preview`), and an [OI]-compatible wire
  receives `web_search_preview`. A bare `{"type":"web_search"}` declaration
  on `/v1/chat/completions` is now recognized and no longer dropped.
- The provider-detail "Test search" control now shows the probe's latency,
  result count, and the normalized hits (or the upstream error) instead of a
  bare pass/fail line.
