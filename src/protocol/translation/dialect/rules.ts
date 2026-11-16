/**
 * Dialect policies & heuristic rules.
 *
 * The default policies are frozen to today's behavior — they are the baseline
 * the golden tests assert against. A dialect not listed here falls back to the
 * family default in `resolver.ts`.
 */
import type { WireFamily } from "../../canonical-model";
import type { DialectId, DialectPolicy } from "./types";

/** The generic OpenAI-compatible default — mirrors current `chat` wire behavior. */
const OPENAI_POLICY: DialectPolicy = {
  reasoningContentField: "reasoning_content",
  maxTokensField: "max_tokens",
  stripSpecialTokens: false,
  supportsMultipleSystemMessages: true,
  supportsToolChoice: true,
  requiresAssistantContentForToolCalls: false,
  allowsSyntheticReasoningContent: true,
  thinkingFormat: "openai",
  inband: null,
};

/** The generic Anthropic/Messages default. */
const ANTHROPIC_POLICY: DialectPolicy = {
  maxTokensField: "max_tokens",
  stripSpecialTokens: false,
  supportsMultipleSystemMessages: true,
  supportsToolChoice: true,
  requiresAssistantContentForToolCalls: false,
  allowsSyntheticReasoningContent: true,
  thinkingFormat: "openai",
  inband: null,
};

/** DeepSeek: `reasoning_content`, `max_tokens`, no tool_choice, DSML in-band. */
const DEEPSEEK_POLICY: DialectPolicy = {
  reasoningContentField: "reasoning_content",
  maxTokensField: "max_tokens",
  stripSpecialTokens: "deepseek",
  supportsMultipleSystemMessages: true,
  supportsToolChoice: false,
  requiresAssistantContentForToolCalls: true,
  allowsSyntheticReasoningContent: false,
  thinkingFormat: "deepseek",
  inband: "deepseek",
};

/** Qwen: `enable_thinking` + `<tool_call>` chat template, strict system cardinality. */
const QWEN_POLICY: DialectPolicy = {
  reasoningContentField: "reasoning_content",
  maxTokensField: "max_tokens",
  stripSpecialTokens: false,
  supportsMultipleSystemMessages: false,
  supportsToolChoice: true,
  requiresAssistantContentForToolCalls: false,
  allowsSyntheticReasoningContent: true,
  thinkingFormat: "qwen",
  inband: "qwen",
};

/**
 * PLaMo: OpenAI-compatible except it rejects `reasoning_content` outright —
 * replaying a prior assistant turn's reasoning answers 400
 * `{"detail": "reasoning_content is not supported."}` (live 400 2026-11-16:
 * the first turn succeeds, every follow-up fails because the reasoning-bearing
 * assistant message stays in history). The policy therefore carries no
 * `reasoningContentField`, so the codecs drop the side channel instead of
 * sending it; everything else matches the OpenAI default.
 */
const PLAMO_POLICY: DialectPolicy = {
  maxTokensField: "max_tokens",
  stripSpecialTokens: false,
  supportsMultipleSystemMessages: true,
  supportsToolChoice: true,
  requiresAssistantContentForToolCalls: false,
  allowsSyntheticReasoningContent: true,
  thinkingFormat: "openai",
  inband: null,
};

/** Resolved policy per dialect id. A missing id falls back in `resolver.ts`. */
export const DEFAULT_DIALECT_POLICIES: Readonly<Record<DialectId, DialectPolicy>> = {
  openai: OPENAI_POLICY,
  anthropic: ANTHROPIC_POLICY,
  deepseek: DEEPSEEK_POLICY,
  qwen: QWEN_POLICY,
  kimi: OPENAI_POLICY,
  glm: OPENAI_POLICY,
  minimax: OPENAI_POLICY,
  plamo: PLAMO_POLICY,
  gemini: OPENAI_POLICY,
};

interface DialectRule {
  readonly dialect: DialectId;
  readonly match: (modelId: string, providerId: string, wireFamily: WireFamily) => boolean;
}

/**
 * Heuristic rules (used only when no DB override and no explicit
 * `ModelDefinition.dialect` exists). Declarative and provider/model-id based,
 * matching the precedent of `src/protocol/translation/quirks.ts`.
 */
export const DIALECT_RULES: readonly DialectRule[] = [
  {
    dialect: "deepseek",
    match: (_modelId, providerId) => providerId.toLowerCase() === "deepseek",
  },
  {
    dialect: "plamo",
    match: (_modelId, providerId) => providerId.toLowerCase() === "plamo",
  },
  {
    dialect: "qwen",
    match: (modelId) => /qwen|portal|alibaba|qwq/i.test(modelId),
  },
];
