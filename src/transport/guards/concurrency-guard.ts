/**
 * Process-wide concurrency cap.
 *
 * Per-key and per-tenant caps already exist, and they are the right place for
 * a fair share. They do not bound the process: a hundred keys each inside
 * their own cap still open a hundred upstream calls at once, and the event
 * loop, the database pool, and the upstream all feel that as one burst.
 *
 * This counts requests in flight in this process and refuses past the cap
 * with 503 and a three-second retry hint. It is deliberately not a queue:
 * queueing would hold the connection open and make the overload look like
 * latency. A client that retries after the hint lands on a process that has
 * drained.
 */
import { Elysia } from "elysia";
import { GatewayError } from "../../protocol/gateway-error";
import { fastPathname } from "../pathname";

/** In-flight `/v1` requests one process will carry before refusing. */
export const PROCESS_CONCURRENCY_CAP = 256;
const PROCESS_CONCURRENCY_RETRY_MS = 3_000;

let inFlight = 0;

/**
 * Requests this middleware actually counted. Elysia fires a plugin's
 * `afterResponse` for a matched route even when the request never reached
 * this middleware's `beforeHandle` — rejected by an earlier hook, or
 * rejected by the cap check itself before incrementing. An unconditional
 * decrement therefore steals a slot from a genuinely in-flight request
 * for every rejection, and under sustained load with a trickle of
 * rejections the counter drains below the cap on its own: measured, a
 * 260-request saturation held the counter at the cap only for one probe
 * interval, then served every later probe while the chats were still
 * running. Only a request recorded here may decrement, so a rejection
 * costs nothing and the counter reflects real load. A `WeakSet` keyed by
 * the `Request` object (the same instance in both hooks, verified) leaks
 * nothing: entries die with their request.
 */
const counted = new WeakSet<object>();

/** The current in-flight count. Exposed for tests; not a control surface. */
export function processInFlight(): number {
  return inFlight;
}

/**
 * Whether a request is exempt from the process cap. `GET /v1/models` only
 * reads the route snapshot — no upstream call, no body, no lease — so
 * counting it against the same cap as a chat dispatch lets a saturated
 * process refuse the cheapest possible read, which is exactly how buyers
 * met `platform_unavailable` on a models fetch while chat was busy. The
 * exemption is deliberately narrow (method + exact path): every other
 * `/v1/` request still counts, and an exempt request must never be
 * decremented either, or it would steal a slot from a counted request.
 */
function isConcurrencyExempt(request: Request): boolean {
  return request.method === "GET" && fastPathname(request.url) === "/v1/models";
}

export function createProcessConcurrencyMiddleware(): Elysia {
  return new Elysia()
    .beforeHandle(({ request }) => {
      const path = fastPathname(request.url);
      // Only the gateway surface counts. Console reads and health probes must
      // still answer while the process is saturated, or an operator cannot
      // see why it is refusing.
      if (!path.startsWith("/v1/")) return;
      if (isConcurrencyExempt(request)) return;
      if (inFlight >= PROCESS_CONCURRENCY_CAP) {
        throw new GatewayError(
          "platform_unavailable",
          503,
          "The gateway is at its concurrency limit. Retry shortly.",
          { retryAfterMs: PROCESS_CONCURRENCY_RETRY_MS },
        );
      }
      inFlight += 1;
      counted.add(request);
    })
    .afterResponse(({ request }: { request: Request }) => {
      const path = fastPathname(request.url);
      if (!path.startsWith("/v1/")) return;
      if (isConcurrencyExempt(request)) return;
      if (!counted.has(request)) return;
      counted.delete(request);
      if (inFlight > 0) inFlight -= 1;
    })
    .as("plugin");
}
