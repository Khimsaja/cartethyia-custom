/**
 * Process-wide concurrency cap.
 *
 * Per-key and per-tenant caps already exist, and they are the right place for
 * a fair share. They do not bound the process: a hundred keys each inside
 * their own cap still open a hundred upstream calls at once, and the event
 * loop, the database pool, and the upstream all feel that as one burst.
 *
 * This admits requests into this process and refuses past the cap with 503 and
 * a retry hint. It is deliberately not a queue: queueing would hold the
 * connection open and make the overload look like latency. A client that
 * retries after the hint lands on a process that has drained.
 *
 * The cap is an explicit operator constant (400), NOT the derived value
 * from `config/resources.ts`: upstream 2.6.4 derives it from the memory
 * limit with a hard 64 ceiling for a single-core process. This gateway
 * runs 6 vCPU with an explicit operator decision for 400 (buyer capacity,
 * Oct 2026; worst-case in-flight memory grows with the cap, which the
 * operator accepted). The derived path keeps its own 64 ceiling for
 * anyone using it; the guard's default controller below is built with
 * the operator cap as its ceiling so the 400 is honoured, not silently
 * re-clamped to 64.
 */
import { Elysia } from "elysia";
import { GatewayError } from "../../protocol/gateway-error";
import { MAX_PROCESS_CONCURRENCY } from "../../config/resources";
import { fastPathname } from "../pathname";

/** In-flight `/v1` requests one process will carry before refusing. */
export const PROCESS_CONCURRENCY_CAP = 400;
const PROCESS_CONCURRENCY_RETRY_MS = 3_000;

/**
 * A bounded set of in-flight tokens.
 *
 * Owned by the caller rather than held in a module global: the previous shape
 * was one `let inFlight` for the whole module, so two middleware instances
 * (tests, or a second app in one process) shared and corrupted a single count.
 */
export interface ProcessConcurrencyController {
  /**
   * Takes a token, or returns `undefined` when the process is full.
   *
   * The returned release function is idempotent — released twice still frees
   * exactly one token — because a request can reach more than one completion
   * path (an abort racing a normal finish).
   */
  tryAcquire(): (() => void) | undefined;
  /** Tokens currently held. */
  activeCount(): number;
  /** The effective cap. */
  limit(): number;
}

/**
 * `ceiling` defaults to upstream's MAX_PROCESS_CONCURRENCY (64), so
 * single-argument callers keep upstream's behaviour exactly. The guard's
 * default controller passes the operator cap as its ceiling so an
 * explicit operator cap above 64 is honoured instead of silently
 * re-clamped; without that the 400 below would run as 64.
 */
export function createProcessConcurrencyController(
  limit: number = PROCESS_CONCURRENCY_CAP,
  ceiling: number = MAX_PROCESS_CONCURRENCY,
): ProcessConcurrencyController {
  const effective = Math.min(ceiling, Math.max(1, Math.trunc(limit)));
  let active = 0;
  return {
    tryAcquire() {
      if (active >= effective) return undefined;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (active > 0) active -= 1;
      };
    },
    activeCount() {
      return active;
    },
    limit() {
      return effective;
    },
  };
}

/**
 * The controller the middleware below uses when none is injected.
 *
 * Exported so the metrics sampler can publish its live count: in-flight
 * concurrency is the number that explains both a latency rise and a shed, and
 * a gauge nobody sets is worse than no gauge.
 */
export const defaultProcessConcurrencyController = createProcessConcurrencyController(
  PROCESS_CONCURRENCY_CAP,
  PROCESS_CONCURRENCY_CAP,
);

/** The current in-flight count. Exposed for tests; not a control surface. */
export function processInFlight(): number {
  return defaultProcessConcurrencyController.activeCount();
}

/**
 * Whether a request is exempt from the process cap. `GET /v1/models` only
 * reads the route snapshot — no upstream call, no body, no lease — so
 * counting it against the same cap as a chat dispatch lets a saturated
 * process refuse the cheapest possible read, which is exactly how buyers
 * met `platform_unavailable` on a models fetch while chat was busy. The
 * exemption is deliberately narrow (method + exact path): every other
 * `/v1/` request still counts, and an exempt request takes no token so
 * there is nothing to release.
 */
function isConcurrencyExempt(request: Request): boolean {
  return request.method === "GET" && fastPathname(request.url) === "/v1/models";
}

/**
 * The middleware.
 *
 * The token is keyed by the Request object in a `WeakMap` and released only if
 * one was actually taken. The previous code decremented a module-global count
 * in `afterResponse` for every `/v1` request — including the ones this guard
 * had just REJECTED, which never incremented it. Under sustained overload that
 * drove the count down spuriously and let more requests through than the cap
 * allows, which is the opposite of what a cap is for.
 *
 * Two additions on top of the upstream shape, both from the pre-2.6.4
 * guard: `GET /v1/models` is exempt (it takes no token, so there is
 * nothing to release), and a client that vanishes mid-flight releases
 * its token via an abort listener — Elysia does not fire `afterResponse`
 * for a vanished client, so without it a token would leak for the life
 * of the process. The release is idempotent, so the abort path racing
 * `afterResponse` frees exactly one token.
 */
export function createProcessConcurrencyMiddleware(
  controller: ProcessConcurrencyController = defaultProcessConcurrencyController,
): Elysia {
  const tokens = new WeakMap<Request, () => void>();
  return new Elysia()
    .beforeHandle(({ request }) => {
      const path = fastPathname(request.url);
      // Only the gateway surface counts. Console reads and health probes must
      // still answer while the process is saturated, or an operator cannot
      // see why it is refusing.
      if (!path.startsWith("/v1/")) return;
      if (isConcurrencyExempt(request)) return;
      // Already dead: taking a token for it would leak, since neither
      // `afterResponse` nor (reliably) a fresh abort event will free it.
      if (request.signal.aborted) return;
      const release = controller.tryAcquire();
      if (release === undefined) {
        throw new GatewayError(
          "platform_unavailable",
          503,
          "The gateway is at its concurrency limit. Retry shortly.",
          { retryAfterMs: PROCESS_CONCURRENCY_RETRY_MS },
        );
      }
      tokens.set(request, release);
      // Second release path for vanished clients (see above). Idempotent:
      // if `afterResponse` already ran, this is a no-op.
      request.signal.addEventListener(
        "abort",
        () => {
          tokens.delete(request);
          release();
        },
        { once: true },
      );
    })
    .afterResponse(({ request }: { request: Request }) => {
      const release = tokens.get(request);
      if (release === undefined) return;
      tokens.delete(request);
      release();
    })
    .as("plugin");
}
