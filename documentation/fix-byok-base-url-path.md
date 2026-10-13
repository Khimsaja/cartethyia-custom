# BYOK base URLs and DeepSeek (current behavior)

This page preserves the context behind
[`test/providers/byok-base-url-path.test.ts`](../test/providers/byok-base-url-path.test.ts).
The original proposal is resolved; use the current implementation below rather
than treating the old plan or acceptance checklist as pending work.

## BYOK base URL behavior

A BYOK Base URL should identify the provider root, optionally including a
gateway/version prefix. The model-list URL is derived as `<root>/models`;
for a bare host, the helper uses `<origin>/v1/models`. If an operator submits a
full request endpoint such as
`https://api.deepseek.com/anthropic/v1/messages`, the connection test strips
the endpoint tail, probes the corrected root, and returns a warning telling the
operator which root to save. Existing gateway/version paths are preserved when
they are roots rather than request endpoints.

This behavior is implemented by `splitEndpointBaseUrl`,
`modelDiscoveryBaseUrl`, and `modelListUrl` in
`src/providers/operations/byok-wire-profile.ts`, and consumed by
`src/providers/runtime/discovery/probing-service.ts`. `resolveByokWireProfile` remains
the authority for supported wire families, endpoint paths, and credential
header shape; do not duplicate that mapping in the UI or probing code.

The exact pasted URL above is a regression-test input. Keep the example aligned
with the focused test if endpoint normalization changes.

## DeepSeek integration

DeepSeek is a bundled provider with a dedicated catalog and adapter. Dispatch
uses the Anthropic Messages format at
`https://api.deepseek.com/anthropic/v1/messages`, with `x-api-key`
authentication. Model discovery continues to use the OpenAI-compatible
`https://api.deepseek.com/v1/models` endpoint; the two surfaces are deliberately
separate.

The current implementation is owned by:

- `src/providers/core/metadata.ts` — DeepSeek identity, host, and default wire.
- `src/providers/default-registry.ts` — adapter, endpoint, and model discovery.
- `src/providers/integrations/anthropic/anthropic.ts` — `createDeepseekAnthropicAdapter`.
- `src/providers/integrations/deepseek/provider.ts` — bundled DeepSeek model rows.

For provider catalog changes, follow the
[provider-catalog skill](../.skills/cartethyia-provider-catalog/SKILL.md).
