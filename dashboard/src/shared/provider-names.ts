/**
 * Dashboard display names for built-in providers. Intentionally hand-maintained
 * here, not imported from `src/providers/provider-metadata.ts`: importing the
 * backend value would bundle the backend module graph (Elysia + `node:crypto`)
 * into the browser build and break Vite dev with "Module node:crypto has been
 * externalized". Same precedent as the dashboard `isRecord` copy in `lib/api.ts`.
 * Keep in sync with `RAW_BUNDLED_PROVIDER_METADATA`; the parity test
 * `provider-display-names-parity.test.ts` fails when an ID is missing.
 */
const BUILT_IN_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  claude: "Claude Code",
  codex: "Codex ChatGPT",
  grok: "Grok Build",
  xai: "xAI Grok Subscription",
  cursor: "Cursor",
  devin: "Devin",
  antigravity: "Antigravity",
  muse: "Muse Code",
  meta: "Meta Model API",
  kiro: "Kiro",
  kimi: "Kimi Code",
  opencodeft: "OpenCode Free",
  opencodezen: "OpenCode Zen",
  opencodego: "OpenCode Go",
  cerebras: "Cerebras",
  openrouter: "OpenRouter",
  mistral: "Mistral AI",
  fireworks: "Fireworks AI",
  nvidia: "NVIDIA NIM",
  deepseek: "DeepSeek",
  huggingface: "Hugging Face",
  gmi: "GMI Cloud",
  zai: "Z.AI",
  zcode: "Z.AI Coding Plan",
  hermes: "Nous Research",
  bai: "B.AI",
  inferhub: "InferHub",
  aihubmix: "AiHubMix",
  tokenharbor: "TokenHarbor",
  agentrouter: "AgentRouter",
  cline: "Cline",
  cb: "CodeBuddy",
  cbcn: "CodeBuddy CN",
  workbuddy: "WorkBuddy",
  kilo: "Kilo Code",
  commandcode: "Command Code",
  qoder: "Qoder",
  ollamacloud: "Ollama Cloud",
  gemini: "Google Gemini",
  xiaomipg: "Xiaomi MiMo (PAYG)",
  xiaomitp: "Xiaomi MiMo (Token Plan)",
  mimodesktop: "MiMo Desktop",
  mimostudio: "MiMo Studio",
  perplexity: "Perplexity",
  "github": "GitHub Copilot",
  exa: "Exa",
  tavily: "Tavily",
  brave: "Brave Search",
};

/** Resolves the label shown for a provider: explicit label (custom providers) wins, then the built-in display name, then the raw ID. */
export function providerDisplayName(providerId: string, label?: string): string {
  if (label) return label;
  return BUILT_IN_PROVIDER_DISPLAY_NAMES[providerId.toLowerCase()] ?? providerId;
}

/**
 * The provider a request names, for display.
 *
 * `providerId` is the provider that actually served the request, so it is absent
 * on a request that failed before a candidate was leased — `model_not_found` and
 * `accounts_unavailable` both fail with no provider, and that absence is
 * deliberate. The caller's `model` still carries the qualified `provider/model`
 * ref it asked for, so a row can name a provider either way.
 *
 * Returns `undefined` for a bare model id, which names no provider.
 */
export function requestProviderId(
  providerId: string | undefined,
  model: string | undefined,
): string | undefined {
  if (providerId) return providerId;
  const slash = model === undefined ? -1 : model.indexOf("/");
  return slash > 0 ? model?.slice(0, slash) : undefined;
}
