// Web-search tool identity and invocation contracts.
import type { ToolDefinition } from "../../protocol/canonical-model";

/**
 * Returns whether a declaration is a provider-hosted search tool.
 *
 * Client-side tools such as Codex's plain `WebSearch` name are not hosted
 * declarations and must pass through untouched.
 */
export function isWebSearchTool(
  tool: Pick<ToolDefinition, "name" | "native_type" | "tool_type">,
): boolean {
  if (tool.native_type?.startsWith("web_search_") === true) return true;
  return tool.tool_type === "web_search";
}

/** Returns whether a model-emitted function call asks to run web search. */
export function isWebSearchToolName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z]/g, "");
  return (
    normalized === "websearch" ||
    normalized === "websearchpreview" ||
    name.startsWith("web_search")
  );
}

/** Search parameters taken from a model-emitted web-search tool invocation. */
export interface WebSearchInvocation {
  readonly query: string;
  readonly maxResults: number;
  /** The originating tool-call id, used to close the model's tool round. */
  readonly callId?: string;
}
