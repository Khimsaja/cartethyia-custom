import type { ValidatedFetch } from "./outbound-fetch";

/**
 * Wrap a pool-bound fetcher with a direct-egress fallback.
 *
 * The pool leg is tried first; when it throws (proxy connect failure,
 * timeout) or answers with a proxy-side status (407 proxy auth, or a
 * 502/503/504 the proxy itself produced), the same request is retried
 * once via direct egress. Genuine upstream answers -- including 4xx
 * rejections and upstream 5xx that direct egress also returns -- pass
 * through untouched, so the caller still sees the real upstream verdict.
 * Callers must pass re-sendable bodies (the claim flow only sends JSON
 * strings or no body at all).
 */
const PROXY_FAILURE_STATUSES = new Set([407, 502, 503, 504]);

export function withDirectFallback(
  poolFetcher: ValidatedFetch,
  directFetcher: ValidatedFetch = globalThis.fetch,
): ValidatedFetch {
  return async (input, init) => {
    let res: Response;
    try {
      res = await poolFetcher(input, init);
    } catch {
      return directFetcher(input, init);
    }
    if (PROXY_FAILURE_STATUSES.has(res.status)) {
      return directFetcher(input, init);
    }
    return res;
  };
}
