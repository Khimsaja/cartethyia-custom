/**
 * Whether a completed client response carried anything the buyer could use.
 *
 * A 200 with an empty answer is not a success for pick quality: the model
 * burned its budget on reasoning (or the upstream returned nothing) and the
 * client got `content: null`. Token counts cannot tell — the gateway fills
 * a missing upstream usage with an estimate, and thinking tokens count as
 * output — so this reads the answer itself, per surface, off the body the
 * client actually received.
 *
 * Fail-open by design: a shape this does not recognize, or a body that is
 * not an object at all, counts as content. Only a parseable body that
 * structurally carries no answer counts as empty. A tool-call-only turn
 * counts as content — the buyer asked for a tool call and got one.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function firstChoice(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = body["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  return isRecord(choices[0]) ? choices[0] : undefined;
}

function chatHasContent(body: Record<string, unknown>): boolean {
  const choice = firstChoice(body);
  if (choice === undefined) return false;
  const message = choice["message"];
  if (!isRecord(message)) return false;
  const content = message["content"];
  if (hasText(content)) return true;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (isRecord(part) && part["type"] === "text" && hasText(part["text"])) return true;
    }
  }
  if (hasText(message["refusal"])) return true;
  const toolCalls = message["tool_calls"];
  return Array.isArray(toolCalls) && toolCalls.length > 0;
}

function completionHasContent(body: Record<string, unknown>): boolean {
  const choice = firstChoice(body);
  if (choice === undefined) return false;
  return hasText(choice["text"]);
}

function messagesHasContent(body: Record<string, unknown>): boolean {
  const content = body["content"];
  if (!Array.isArray(content)) return false;
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part["type"] === "text" && hasText(part["text"])) return true;
    if (part["type"] === "tool_use") return true;
  }
  return false;
}

function responsesHasContent(body: Record<string, unknown>): boolean {
  if (hasText(body["output_text"])) return true;
  const output = body["output"];
  if (!Array.isArray(output)) return false;
  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item["type"] === "function_call" || item["type"] === "tool_call") return true;
    const content = item["content"];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (isRecord(part) && part["type"] === "output_text" && hasText(part["text"])) return true;
    }
  }
  return false;
}

export function responseHasVisibleContent(surface: string | undefined, body: unknown): boolean {
  if (!isRecord(body)) return true;
  switch (surface) {
    case "chat":
      return chatHasContent(body);
    case "completion":
      return completionHasContent(body);
    case "messages":
      return messagesHasContent(body);
    case "responses":
      return responsesHasContent(body);
    default:
      return true;
  }
}
