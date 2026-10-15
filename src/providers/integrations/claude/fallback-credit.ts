/**
 * Fallback-credit token cache for Claude refusal redemption.
 *
 * When Claude returns a refusal with `stop_details.fallback_credit_token`,
 * the token is valid for 5 minutes. Within that window, the same request can
 * be replayed with `stop_details: { fallback_credit_token: "..." }` injected
 * to get a free retry.
 *
 * The cache is an LRU keyed by a hash of the request body. On refusal, the
 * token is stored; on the next identical request, it is injected before send.
 *
 * Design: documentation/research/oh-my-pi-provider-comparison.md (#2, M).
 */

const CREDIT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 64;

export interface FallbackCreditEntry {
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * LRU cache for fallback-credit tokens. Keyed by a hash of the request body.
 * Evicts oldest entries when the cache exceeds `maxSize`.
 */
export class FallbackCreditCache {
  private readonly cache = new Map<string, FallbackCreditEntry>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(options: { maxSize?: number; ttlMs?: number } = {}) {
    this.maxSize = options.maxSize ?? MAX_CACHE_SIZE;
    this.ttlMs = options.ttlMs ?? CREDIT_TTL_MS;
  }

  /** Get a cached token for the given body hash, or undefined if expired/missing. */
  get(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    // LRU: refresh position by re-inserting
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.token;
  }

  /** Store a token for the given body hash. */
  set(key: string, token: string): void {
    // Evict oldest if at capacity (Map preserves insertion order)
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
    // Refresh position if already present
    this.cache.delete(key);
    this.cache.set(key, {
      token,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /** Clear all entries. */
  clear(): void {
    this.cache.clear();
  }

  /** Current size (for tests). */
  get size(): number {
    return this.cache.size;
  }
}

/**
 * Compute a simple hash of the request body for cache keying.
 * Uses FNV-1a — fast, deterministic, sufficient for cache identity.
 */
export function hashBody(body: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

// Shared process-wide cache instance
export const sharedFallbackCreditCache = new FallbackCreditCache();
