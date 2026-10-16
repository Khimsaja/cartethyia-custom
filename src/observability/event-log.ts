import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Per-request telemetry lives in hourly JSONL files, not in Postgres. The
 * database keeps only the durable aggregate. Every reader that used to query
 * `telemetry_events` reads through here, so the file is the single source for
 * recent requests and the table is no longer written.
 */
export const TELEMETRY_EVENT_DIR = "./data/telemetry-events";

export interface TelemetryEventRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly tenantId?: string;
  readonly requestId: string;
  readonly sourceSurface: string | null;
  readonly requestedModel: string | null;
  readonly requestedEffort: string | null;
  readonly providerId: string | null;
  readonly accountId: string | null;
  readonly networkPoolId: string | null;
  readonly endpoint: string | null;
  readonly apiKeyId: string | null;
  readonly userAgent: string | null;
  readonly clientIp: string | null;
  readonly latencyMs: number | null;
  readonly ttfbMs: number | null;
  readonly stream: boolean | null;
  readonly status: string | null;
  readonly httpStatus: number | null;
  readonly errorOrigin: string | null;
  readonly errorCategory: string | null;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly estimatedCostUsd: number | null;
  readonly creditUsed: number | null;
  readonly resolveMs: number | null;
  readonly tokensPerSec: number | null;
  readonly firstContentDeltaAtMs: number | null;
  readonly lastEventAtMs: number | null;
  /** Why the drawer payloads are empty, or `captured`; absent when unrecorded. */
  readonly payloadCaptureState?: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0 && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function normalize(raw: Record<string, unknown>): TelemetryEventRecord | undefined {
  const tenantId = asString(raw["tenantId"]);
  const requestId = asString(raw["requestId"]);
  const createdAt = asString(raw["createdAt"]);
  // No time means the row cannot be ordered or aged out. Inventing one made
  // every undated row reappear as "just now" on each read.
  if (!tenantId || !requestId || !createdAt) return undefined;
  return {
    id: asString(raw["id"]) ?? requestId,
    createdAt,
    tenantId,
    requestId,
    sourceSurface: asString(raw["sourceSurface"]),
    requestedModel: asString(raw["requestedModel"]),
    requestedEffort: asString(raw["requestedEffort"]),
    providerId: asString(raw["providerId"]),
    accountId: asString(raw["accountId"]),
    networkPoolId: asString(raw["networkPoolId"]),
    endpoint: asString(raw["endpoint"]),
    apiKeyId: asString(raw["apiKeyId"]),
    userAgent: asString(raw["userAgent"]),
    clientIp: asString(raw["clientIp"]),
    latencyMs: asNumber(raw["latencyMs"]),
    ttfbMs: asNumber(raw["ttfbMs"]),
    stream: typeof raw["stream"] === "boolean" ? raw["stream"] : null,
    status: asString(raw["status"]),
    httpStatus: asNumber(raw["httpStatus"]),
    errorOrigin: asString(raw["errorOrigin"]),
    errorCategory: asString(raw["errorCategory"]),
    inputTokens: asNumber(raw["inputTokens"]),
    cachedInputTokens: asNumber(raw["cachedInputTokens"]),
    outputTokens: asNumber(raw["outputTokens"]),
    reasoningTokens: asNumber(raw["reasoningTokens"]),
    estimatedCostUsd: asNumber(raw["estimatedCostUsd"]),
    creditUsed: asNumber(raw["creditUsed"]),
    resolveMs: asNumber(raw["resolveMs"]),
    tokensPerSec: asNumber(raw["tokensPerSec"]),
    firstContentDeltaAtMs: asNumber(raw["firstContentDeltaAtMs"]),
    lastEventAtMs: asNumber(raw["lastEventAtMs"]),
  };
}

function eventFileHour(file: string): string {
  return file.slice(0, 13);
}

function hourStamp(date: Date): string {
  return date.toISOString().slice(0, 13).replaceAll(":", "-");
}

/**
 * Incremental parse index over the hourly event files.
 *
 * The console polls its usage endpoints every few seconds over a window that
 * can hold millions of retained events. Re-reading and re-parsing that whole
 * window per poll spent the dashboard's cost on the same event loop that
 * serves the requests, so a busy gateway slowed its own console. A poll only
 * needs the bytes appended since the last one: this index keeps the parsed
 * records per file and reads each file's tail from the byte offset it last
 * consumed.
 */
interface EventFileIndex {
  /** Bytes consumed; always ends on a newline so a torn tail is re-read. */
  bytes: number;
  /** Records in file order, oldest first. */
  events: TelemetryEventRecord[];
}

const eventIndex = new Map<string, EventFileIndex>();
let indexRefreshedAt = 0;
let indexRefresh: Promise<void> | undefined;
let indexedEventCount = 0;
let indexedBytesRead = 0;
let indexRefreshes = 0;

/** How long a refresh is reused before another poll re-tails the files. */
const INDEX_REFRESH_TTL_MS = 250;

/**
 * Ceiling on retained records. Retention bounds the window in time, not in
 * memory, so the oldest file leaves the index first and is read directly if a
 * query still asks for it.
 */
const INDEX_MAX_EVENTS = 250_000;

export interface TelemetryIndexStats {
  readonly files: number;
  readonly events: number;
  readonly bytesRead: number;
  readonly refreshes: number;
}

/** Counters the tests read to prove a poll stops re-parsing the window. */
export function telemetryIndexStats(): TelemetryIndexStats {
  return {
    files: eventIndex.size,
    events: indexedEventCount,
    bytesRead: indexedBytesRead,
    refreshes: indexRefreshes,
  };
}

/** Drops the index. Used by tests; nothing on the request path calls it. */
export function resetTelemetryIndex(): void {
  eventIndex.clear();
  indexedEventCount = 0;
  indexedBytesRead = 0;
  indexRefreshes = 0;
  indexRefreshedAt = 0;
  indexRefresh = undefined;
}

/**
 * Parses the complete lines of `text` and reports the bytes they occupy. A
 * trailing partial line is left for the next refresh: advancing past it would
 * skip bytes the writer is still appending.
 */
function parseCompleteLines(text: string): { events: TelemetryEventRecord[]; consumed: number } {
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return { events: [], consumed: 0 };
  const events: TelemetryEventRecord[] = [];
  for (const line of text.slice(0, lastNewline).split("\n")) {
    if (!line) continue;
    try {
      const event = normalize(JSON.parse(line) as Record<string, unknown>);
      if (event) events.push(event);
    } catch {
      // A torn tail from a crash is skipped, not fatal. The next line stands alone.
    }
  }
  return { events, consumed: lastNewline + 1 };
}

/** Reads the bytes after `from` and parses their complete lines. */
async function readAppended(
  file: string,
  from: number,
): Promise<{ events: TelemetryEventRecord[]; consumed: number }> {
  const handle = await open(join(TELEMETRY_EVENT_DIR, file), "r").catch(() => undefined);
  if (handle === undefined) return { events: [], consumed: 0 };
  try {
    const size = (await handle.stat()).size;
    if (size <= from) return { events: [], consumed: 0 };
    const length = size - from;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, from);
    indexedBytesRead += bytesRead;
    return parseCompleteLines(buffer.toString("utf8", 0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function eventFiles(): Promise<string[]> {
  return (await readdir(TELEMETRY_EVENT_DIR).catch(() => [] as string[]))
    .filter((file) => file.endsWith(".jsonl"))
    .sort();
}

async function refreshEventIndex(): Promise<void> {
  const files = await eventFiles();
  const present = new Set(files);
  for (const [file, entry] of eventIndex) {
    if (present.has(file)) continue;
    indexedEventCount -= entry.events.length;
    eventIndex.delete(file);
  }
  for (const file of files) {
    const entry = eventIndex.get(file);
    const { events, consumed } = await readAppended(file, entry?.bytes ?? 0);
    if (consumed === 0) continue;
    if (entry === undefined) eventIndex.set(file, { bytes: consumed, events });
    else {
      entry.events.push(...events);
      entry.bytes += consumed;
    }
    indexedEventCount += events.length;
  }
  while (indexedEventCount > INDEX_MAX_EVENTS && eventIndex.size > 1) {
    const oldest = [...eventIndex.keys()].sort()[0];
    if (oldest === undefined) break;
    indexedEventCount -= eventIndex.get(oldest)?.events.length ?? 0;
    eventIndex.delete(oldest);
  }
  indexRefreshedAt = Date.now();
  indexRefreshes += 1;
}

/** Brings the index up to date, sharing one tail read across concurrent polls. */
async function ensureEventIndex(): Promise<void> {
  if (indexRefreshedAt !== 0 && Date.now() - indexRefreshedAt < INDEX_REFRESH_TTL_MS) return;
  if (indexRefresh !== undefined) return indexRefresh;
  indexRefresh = refreshEventIndex().finally(() => {
    indexRefresh = undefined;
  });
  return indexRefresh;
}

/** Every record of one file, oldest first, preferring the index. */
async function fileEvents(file: string): Promise<readonly TelemetryEventRecord[]> {
  const entry = eventIndex.get(file);
  if (entry !== undefined) return entry.events;
  // Evicted by the memory ceiling, or not yet indexed: read it directly rather
  // than report a shorter window than the log actually holds.
  return (await readAppended(file, 0)).events;
}

/** Reads every retained event, newest first. A missing directory is an empty log. */
export async function readTelemetryEvents(): Promise<TelemetryEventRecord[]> {
  await ensureEventIndex();
  const events: TelemetryEventRecord[] = [];
  for (const file of await eventFiles()) events.push(...(await fileEvents(file)));
  events.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return events;
}

export interface EventQuery {
  readonly tenantId?: string;
  readonly since?: Date;
  readonly apiKeyIds?: readonly string[];
  readonly accountIds?: readonly string[];
  readonly requestId?: string;
  readonly httpStatus?: number;
  readonly limit?: number;
}

function matches(event: TelemetryEventRecord, query: EventQuery, since: number | undefined, keys: ReadonlySet<string> | undefined, accounts: ReadonlySet<string> | undefined): boolean {
  if (query.tenantId !== undefined && event.tenantId !== query.tenantId) return false;
  if (since !== undefined && new Date(event.createdAt).getTime() < since) return false;
  if (keys && (event.apiKeyId === null || !keys.has(event.apiKeyId))) return false;
  if (accounts && (event.accountId === null || !accounts.has(event.accountId))) return false;
  if (query.requestId !== undefined && event.requestId !== query.requestId) return false;
  if (query.httpStatus !== undefined && event.httpStatus !== query.httpStatus) return false;
  return true;
}

/** The events matching a query, already newest first. */
export async function queryTelemetryEvents(query: EventQuery): Promise<TelemetryEventRecord[]> {
  await ensureEventIndex();
  const files = (await eventFiles())
    .filter((file) => query.since === undefined || eventFileHour(file) >= hourStamp(query.since))
    .reverse();
  const since = query.since?.getTime();
  const keys = query.apiKeyIds ? new Set(query.apiKeyIds) : undefined;
  const accounts = query.accountIds ? new Set(query.accountIds) : undefined;
  const events: TelemetryEventRecord[] = [];
  for (const file of files) {
    const inFile = await fileEvents(file);
    const matched: TelemetryEventRecord[] = [];
    // Newest first inside the file, so the caller's order is preserved without
    // a per-file sort.
    for (let index = inFile.length - 1; index >= 0; index -= 1) {
      const event = inFile[index]!;
      if (!matches(event, query, since, keys, accounts)) continue;
      matched.push(event);
      // A requestId lookup needs one row: stop at the first (newest) match
      // instead of walking the whole retention window.
      if (query.requestId !== undefined) return matched;
    }
    events.push(...matched);
    if (query.limit !== undefined && events.length >= query.limit) return events.slice(0, query.limit);
  }
  return events;
}

/**
 * Indexed records at or after `from`, newest first, stopping at the first
 * record older than `from`.
 *
 * This is for the aggregate fold, which only ever needs the events it has not
 * folded yet, so the scan starts at the newest file's tail instead of walking
 * the window. The early stop assumes append order is time order: the writer
 * appends each event as its request completes and `createdAt` is stamped at
 * that moment. An ordered read the console renders goes through
 * `queryTelemetryEvents`, which sorts instead of assuming.
 */
export async function indexedEventsSince(
  from: Date | undefined,
  tenantId?: string,
): Promise<TelemetryEventRecord[]> {
  await ensureEventIndex();
  const since = from?.getTime();
  const out: TelemetryEventRecord[] = [];
  for (const file of (await eventFiles()).reverse()) {
    const inFile = await fileEvents(file);
    for (let index = inFile.length - 1; index >= 0; index -= 1) {
      const event = inFile[index]!;
      const at = new Date(event.createdAt).getTime();
      if (!Number.isFinite(at)) continue;
      if (since !== undefined && at < since) return out;
      if (tenantId !== undefined && event.tenantId !== tenantId) continue;
      out.push(event);
    }
  }
  return out;
}

export interface EventTotals {
  requests: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  truncated: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  estimatedCost: number;
  unpriced: number;
  latencySum: number;
  latencyCount: number;
  tokensPerSecSum: number;
  tokensPerSecCount: number;
}

export function emptyTotals(): EventTotals {
  return { requests: 0, succeeded: 0, failed: 0, cancelled: 0, truncated: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, estimatedCost: 0, unpriced: 0, latencySum: 0, latencyCount: 0, tokensPerSecSum: 0, tokensPerSecCount: 0 };
}

/** Folds one event into a totals bucket. `failed` counts any non-completed terminal status. */
export function accumulate(totals: EventTotals, event: TelemetryEventRecord): void {
  totals.requests += 1;
  if (event.status === "completed") totals.succeeded += 1;
  else if (event.status === "cancelled") totals.cancelled += 1;
  else if (event.status === "truncated") totals.truncated += 1;
  else if (event.status !== null) totals.failed += 1;
  totals.inputTokens += event.inputTokens ?? 0;
  totals.cachedTokens += event.cachedInputTokens ?? 0;
  totals.outputTokens += event.outputTokens ?? 0;
  if (event.estimatedCostUsd !== null) totals.estimatedCost += event.estimatedCostUsd;
  else if (event.status === "completed") totals.unpriced += 1;
  if (event.latencyMs !== null) { totals.latencySum += event.latencyMs; totals.latencyCount += 1; }
  if (event.tokensPerSec !== null) { totals.tokensPerSecSum += event.tokensPerSec; totals.tokensPerSecCount += 1; }
}

