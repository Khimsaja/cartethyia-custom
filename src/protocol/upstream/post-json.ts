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
 * to persist it — a stream has no string to read. Note the validated fetch
 * (`createValidatedFetch` → `dial()`) buffers a stream body into bytes to
 * measure content-length before sending, so on that path a streamed body
 * never reaches the socket and provides no memory benefit — and its
 * serializer generator's frame can retain the payload after the request
 * ends. Callers on the validated-fetch path should leave `streamBody` off.
 * `bodyEncoder` lets a provider send the same body with non-JSON encoding
 * (e.g. zstd, which the Grok Build CLI does). When omitted, the JSON string is
 * sent as-is.
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
  // Held in a `let` so the serializer can be dropped once the stream is
  // drained or cancelled. A completed generator's frame still references
  // the payload, and the pull closure itself is retained by the runtime's
  // native fetch state after the fetch ends — so merely completing the
  // generator does not free the payload. Releasing the reference here is
  // what lets the payload be collected even while the stream object lives on.
  let pieces: Generator<string> | undefined = jsonChunks(payload);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pieces === undefined) {
        controller.close();
        return;
      }
      const next = pieces.next();
      if (next.done) {
        pieces = undefined;
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(next.value));
    },
    cancel() {
      // An abandoned upload must not park the payload in a suspended
      // serializer: settle it and drop the reference so the payload is
      // freed even if the runtime keeps the stream object itself alive
      // after the fetch ends.
      pieces?.return(undefined);
      pieces = undefined;
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
  bodyEncoder?: (payload: Record<string, unknown>) => string | Uint8Array<ArrayBuffer>,
): Promise<{ res: Response; signal: AbortSignal; release: () => void }> {
  const lifecycle = createUpstreamDeadlineLifecycle(context);
  // The fetch must stay abortable through the request signal for the whole
  // stream lifetime. The lifecycle signal alone stops forwarding that abort
  // as soon as `release()` runs (right after headers arrive), so a client
  // that disconnects mid-stream never aborts the upstream fetch: the
  // runtime keeps the request body stream — and the payload it serializes —
  // alive indefinitely. Combining the request signal keeps the fetch
  // abortable; the deadline arm is still released by `release()`.
  const fetchSignal = AbortSignal.any([context.abort_signal, lifecycle.signal]);
  // Hoisted so the catch can cancel a stream the fetch abandoned mid-drain.
  let stream: ReadableStream<Uint8Array> | undefined;
  try {
    // A stream is only created when it will actually be sent as the body.
    // When a `bodyEncoder` is present the body is the encoder output, so
    // building a stream here would create a serializer that is never drained
    // or cancelled — its frame would retain the payload indefinitely.
    stream =
      bodyEncoder === undefined &&
      options?.streamBody === true &&
      isPlainJsonValue(payload, new Set())
        ? jsonBodyStream(payload)
        : undefined;
    const res = await outboundFetch(fetchUrl, {
      method: "POST",
      headers,
      body: bodyEncoder ? bodyEncoder(payload) : (stream ?? JSON.stringify(payload)),
      signal: fetchSignal,
      // Undici-style fetch implementations require this for stream bodies;
      // the validated fetch ignores unknown init fields.
      ...(stream ? ({ duplex: "half" } as RequestInit) : {}),
    });
    return {
      res,
      signal: fetchSignal,
      release: lifecycle.release,
    };
  } catch (error: unknown) {
    // A failed dial/fetch must not abandon the serializer: a stream that was
    // never drained or cancelled keeps its generator suspended mid-payload,
    // and the runtime's native fetch state retains the pull closure (see
    // jsonBodyStream) — so the whole payload stays reachable for the life of
    // the process. Cancel it here; the lifecycle release alone does not.
    await stream?.cancel().catch(() => undefined);
    lifecycle.release();
    const abortError = abortGatewayError(lifecycle, error, context.abort_signal);
    if (abortError) throw abortError;
    throw error;
  }
}
