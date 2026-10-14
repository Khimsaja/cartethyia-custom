import type { CanonicalRequest, ReasoningEffort, ReasoningIntent } from "../protocol/canonical-model";
import { budgetToLevel } from "../transport/translation/thinking";
import { isRecord } from "../protocol/codecs";

/**
 * The effective reasoning effort for a canonical intent, deriving one from an
 * Anthropic-shaped `thinking` block when no explicit effort is set.
 *
 * An Anthropic client states reasoning as `thinking: { type, budget_tokens }`,
 * which the canonical model keeps as `thinking_type`/`budget_tokens` — fields
 * the OpenAI-family wires do not define. Every OpenAI-style consumer therefore
 * needs the same translation, and two of them deriving it independently is how
 * a wire ends up with an unmappable reasoning object. Returns `undefined` when
 * the intent carries no reasoning at all (or explicitly disables it).
 */
export function reasoningEffortFromIntent(reasoning: ReasoningIntent | undefined): ReasoningEffort | undefined {
  if (reasoning === undefined) return undefined;
  if (reasoning.thinking_type === "disabled") return "none";
  if (reasoning.effort !== undefined) return reasoning.effort;
  if (reasoning.thinking_type !== "enabled" && reasoning.thinking_type !== "adaptive") return undefined;
  const budget = reasoning.budget_tokens;
  // No budget means the caller enabled thinking without sizing it — the
  // ladder's default ask. A sized budget maps to the nearest tier.
  if (budget === undefined) return "high";
  return budgetToLevel(budget) ?? "high";
}

/** Projects canonical reasoning intent onto OpenAI-style effort controls. */
export function applyOpenAIReasoning(payload: Record<string, unknown>, request: CanonicalRequest | undefined): void {
  if (request === undefined || payload["reasoning_effort"] !== undefined) return;
  const effort = reasoningEffortFromIntent(request.reasoning);
  if (effort === undefined) return;
  payload["reasoning_effort"] = effort;
}

/** Applies the DeepSeek chat contract shared by CodeBuddy and WorkBuddy. */
export function applyDeepSeekReasoning(payload: Record<string, unknown>): void {
  const model = typeof payload["model"] === "string" ? payload["model"].trim().toLowerCase() : "";
  if (!model.startsWith("deepseek")) return;
  const thinking = isRecord(payload["thinking"]) ? payload["thinking"] : undefined;
  const type = typeof thinking?.["type"] === "string" ? thinking["type"].trim().toLowerCase() : "";
  if (type === "disabled") {
    delete payload["reasoning_effort"];
    delete payload["reasoningEffort"];
    return;
  }
  if (thinking === undefined) payload["thinking"] = { type: "enabled" };
  else if (type.length === 0) thinking["type"] = "enabled";
  if (typeof payload["reasoning_effort"] !== "string" || payload["reasoning_effort"].length === 0)
    payload["reasoning_effort"] = "high";
}

/** Backfills DeepSeek assistant reasoning_content required for replayed turns. */
export function backfillDeepSeekReasoningContent(payload: Record<string, unknown>): void {
  const thinking = payload["thinking"];
  const thinkingEnabled = isRecord(thinking) && thinking["type"] === "enabled";
  const messages = payload["messages"];
  if (!Array.isArray(messages)) return;
  const hasTrace = messages.some(
    (message) =>
      isRecord(message) &&
      ((typeof message["reasoning"] === "string" && message["reasoning"].length > 0) ||
        "reasoning_content" in message),
  );
  if (!thinkingEnabled && !hasTrace) return;
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "assistant") continue;
    if (typeof message["reasoning_content"] === "string") continue;
    // Only a real trace is backfilled. Writing `""` onto every assistant turn
    // made the payload claim reasoning it did not have: the upstream reads the
    // empty field as "thinking mode with the reasoning stripped", and rejects
    // the next turn with "the reasoning content from the previous turn must be
    // passed back in thinking mode". A turn with nothing to replay stays
    // without the field so the provider sees a normal assistant turn.
    if (typeof message["reasoning"] !== "string" || message["reasoning"].length === 0) continue;
    message["reasoning_content"] = message["reasoning"];
  }
}

/** Returns Gemini's minimum output budget for a canonical reasoning intent. */
export function geminiThinkingOutputFloor(reasoning: CanonicalRequest["reasoning"]): number | undefined {
  if (reasoning === undefined || reasoning.thinking_type === "disabled") return undefined;
  if (reasoning.budget_tokens !== undefined) return geminiBudgetOutputFloor(reasoning.budget_tokens);
  if (reasoning.effort !== undefined && reasoning.effort !== "none") return geminiLevelOutputFloor(reasoning.effort);
  return undefined;
}

/**
 * Minimum output budget for a caller who asked for `low` effort and got a
 * higher one.
 *
 * A wire ladder can only serve levels the upstream accepts, so a request for
 * `low` is clamped up to whatever that model offers — `hy4-preview-f` serves
 * `high` and nothing else. Effort is not free: the higher level spends its
 * budget on reasoning before it writes the answer, so an output limit the
 * caller sized for `low` now has to cover both, and an answer that fits in
 * 2048 tokens of visible text does not fit once the reasoning share is taken
 * out of the same 2048.
 *
 * The symptom is a truncated answer that an agent retries from the top —
 * reading as a loop ("let me do / let me go / let me do it") rather than as a
 * short limit. Raising the ceiling is what keeps the raised effort usable.
 *
 * Only ever raises, and only to the model's own catalog limit: a caller who
 * deliberately asked for a small answer still gets one when the effort was
 * left alone, and no provider is asked for more output than it declares.
 */
export function raisedEffortOutputFloor(
  requested: string | undefined,
  applied: string | undefined,
  modelOutputLimit: number | undefined,
): number | undefined {
  if (requested === undefined || applied === undefined) return undefined;
  const from = BUDDY_LEVEL_RANK[requested.trim().toLowerCase()];
  const to = BUDDY_LEVEL_RANK[applied.trim().toLowerCase()];
  if (from === undefined || to === undefined || to <= from) return undefined;
  if (modelOutputLimit === undefined || !Number.isFinite(modelOutputLimit) || modelOutputLimit <= 0)
    return undefined;
  // Leave headroom instead of claiming the whole catalog limit: the caller's
  // number was a real preference about answer size, and the goal is to stop
  // truncating, not to spend the model's ceiling on every turn.
  return Math.max(RAISED_EFFORT_MIN_OUTPUT_TOKENS, Math.floor(modelOutputLimit / 2));
}

const RAISED_EFFORT_MIN_OUTPUT_TOKENS = 16_384;

const BUDDY_LEVEL_RANK: Readonly<Record<string, number>> = {
  off: 0,
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

/** Builds the Anthropic thinking block from canonical reasoning intent. */
export function buildAnthropicThinkingPayload(reasoning: ReasoningIntent): Record<string, unknown> {
  const blockBinding =
    reasoning.prefix_mismatch_behavior === undefined
      ? undefined
      : { prefix_mismatch_behavior: reasoning.prefix_mismatch_behavior };
  return {
    type: reasoning.thinking_type ?? "adaptive",
    ...(reasoning.budget_tokens === undefined ? {} : { budget_tokens: reasoning.budget_tokens }),
    ...(reasoning.display === undefined ? {} : { display: reasoning.display }),
    ...(blockBinding === undefined ? {} : { block_binding: blockBinding }),
  };
}

function geminiBudgetOutputFloor(budget: number): number {
  if (!Number.isFinite(budget)) return 32768;
  if (budget <= 1024) return 8192;
  if (budget <= 8192) return 16384;
  if (budget <= 24576) return 32768;
  return 65535;
}

function geminiLevelOutputFloor(level: string): number {
  switch (level) {
    case "minimal":
      return 4096;
    case "low":
      return 8192;
    case "medium":
      return 16384;
    case "high":
    case "xhigh":
    case "max":
      return 65535;
    default:
      return 65535;
  }
}

