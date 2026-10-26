/**
 * Shared upstream JSON executor for [OpenAI]-compatible adapters: POSTs a payload
 * with deadline/abort wiring and returns the response plus a release hook.
 *
 * A streamed body (`streamBody`) serializes the payload as JSON chunks instead
 * of one `JSON.stringify` flat string. That matters for large prompts: the
 * stringified copy is otherwise retained for the whole upstream wait — the
 * validated fetch holds its body, the provider capture holds it again, and the
 * dispatch frames hold the canonical string it was copied from — so one
 * request parks ~2x its prompt in heap while a slow upstream thinks. A
 * streamed body still references the canonical strings (it cannot copy them
 * away), but it creates no second flat string, and each chunk is released
 * once written to the socket, before the wait starts. The escaped copy of
 * one string value exists only transiently, while that value is being sent.
 *
 * Streaming is opt-in and only for plain JSON payloads: anything the chunk
 * serializer cannot reproduce byte-for-byte (cyclic values, class instances,
 * bigint) falls back to the string path, so no caller silently changes wire
 * bytes. It is also off whenever the attempt's provider body will be
 * captured (`capture_provider_body`), because capture reads the string body
 * to persist it — a stream has no string to read.
 */
import type { ProviderDispatchContext, ValidatedOutboundFetch } from "../../providers/provider-contracts";
import { abortGatewayError, createUpstreamDeadlineLifecycle } from "../../providers/operations/upstream-deadline";

/** Largest JSON piece handed to the socket at once. */
const MAX_STREAM_CHUNK_CHARS = 64 * 1024;

/**
 * Whether `value` is a plain JSON value the chunk serializer reproduces
 * exactly. `undefined`/function/symbol are allowed because `JSON.stringify`
 * has defined behaviour for them (dropped in objects, `null` in arrays);
 * anything else non-plain (a `Date`, a class instance, a cyclic graph, a
 * bigint — which `JSON.stringify` rejects) forces the string fallback.
 */
function isPlainJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean" || type === "number") return true;
  if (type === "undefined" || type === "function" || type === "symbol") return true;
  if (type !== "object") return false;
  if (ancestors.has(value as object)) return false;
  if (!Array.isArray(value)) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
  }
  ancestors.add(value as object);
  try {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!isPlainJsonValue(item, ancestors)) return false;
      }
    } else {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (!isPlainJsonValue((value as Record<string, unknown>)[key], ancestors)) return false;
      }
    }
    return true;
  } finally {
    ancestors.delete(value as object);
  }
}

/**
 * Serializes `value` as JSON pieces, mirroring `JSON.stringify` semantics:
 * object members whose value is `undefined`/function/symbol are dropped,
 * array slots with those values become `null`, non-finite numbers become
 * `null`. A string value is escaped in one `JSON.stringify` call (a transient
 * copy while it is being sent) and then sliced, so no piece — and no
 * encoder buffer — ever holds the whole value at once beyond that transient.
 */
function* jsonChunks(value: unknown): Generator<string> {
  if (value === null) {
    yield "null";
    return;
  }
  const type = typeof value;
  if (type === "string") {
    const escaped = JSON.stringify(value);
    for (let i = 0; i < escaped.length; i += MAX_STREAM_CHUNK_CHARS) {
      yield escaped.slice(i, i + MAX_STREAM_CHUNK_CHARS);
    }
    return;
  }
  if (type === "number") {
    yield Number.isFinite(value as number) ? String(value) : "null";
    return;
  }
  if (type === "boolean") {
    yield (value as boolean) ? "true" : "false";
    return;
  }
  if (type === "undefined" || type === "function" || type === "symbol") {
    // Reachable only in array slots; object members are skipped by the caller.
    yield "null";
    return;
  }
  if (Array.isArray(value)) {
    yield "[";
    let first = true;
    for (const item of value) {
      if (!first) yield ",";
      first = false;
      yield* jsonChunks(item);
    }
    yield "]";
    return;
  }
  yield "{";
  let first = true;
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (member === undefined || typeof member === "function" || typeof member === "symbol") continue;
    if (!first) yield ",";
    first = false;
    yield JSON.stringify(key);
    yield ":";
    yield* jsonChunks(member);
  }
  yield "}";
}

/** A pull-driven byte stream over the JSON pieces of `payload`. */
function jsonBodyStream(payload: Record<string, unknown>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pieces = jsonChunks(payload);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = pieces.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(next.value));
    },
  });
}

export async function postUpstreamJson(
  fetchUrl: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  context: ProviderDispatchContext,
  outboundFetch: ValidatedOutboundFetch,
  options?: { streamBody?: boolean },
): Promise<{ res: Response; signal: AbortSignal; release: () => void }> {
  const lifecycle = createUpstreamDeadlineLifecycle(context);
  try {
    const stream =
      options?.streamBody === true && isPlainJsonValue(payload, new Set())
        ? jsonBodyStream(payload)
        : undefined;
    const res = await outboundFetch(fetchUrl, {
      method: "POST",
      headers,
      body: stream ?? JSON.stringify(payload),
      signal: lifecycle.signal,
      // Undici-style fetch implementations require this for stream bodies;
      // the validated fetch ignores unknown init fields.
      ...(stream ? ({ duplex: "half" } as RequestInit) : {}),
    });
    return {
      res,
      signal: lifecycle.signal,
      release: lifecycle.release,
    };
  } catch (error: unknown) {
    lifecycle.release();
    const abortError = abortGatewayError(lifecycle, error, context.abort_signal);
    if (abortError) throw abortError;
    throw error;
  }
}
