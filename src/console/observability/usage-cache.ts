/**
 * Read-through cache for the usage endpoints.
 *
 * Answering one of these parses the retained telemetry window, which is the
 * console's dominant cost and runs on the event loop that serves the gateway.
 * Redis is configured on every deployment and this store only ever pinged it,
 * so the same window was re-parsed per instance, per poll, per endpoint. A
 * short TTL makes that once per window across the whole fleet.
 *
 * A Redis that is slow or down must never fail a request: every cache step
 * falls through to computing the answer, which is exactly what the request
 * would have done before there was a cache.
 */

/** The slice of Redis this cache needs, so it can be tested without a server. */
export interface UsageCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
}

/**
 * How long a usage response is served from cache. The dashboard polls every few
 * seconds and the telemetry log is append-only, so a short window is invisible
 * to a reader while collapsing a poll burst — and every other instance's — into
 * one computation.
 */
export const USAGE_CACHE_TTL_SECONDS = 10;

/** `undefined` when the row was never cached, so a computed `null` is cacheable. */
export async function cachedUsage<T>(
  client: UsageCacheClient | undefined,
  key: string,
  compute: () => Promise<T>,
  ttlSeconds: number = USAGE_CACHE_TTL_SECONDS,
): Promise<T> {
  if (client === undefined) return compute();
  try {
    const hit = await client.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch {
    return compute();
  }
  const value = await compute();
  try {
    await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    // A cache write must never fail a request that already has its answer.
  }
  return value;
}
