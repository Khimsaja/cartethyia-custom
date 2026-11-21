// Dependency readiness guard: refuses `/v1/*` and `/console/api/*` traffic
// while dependencies are unhealthy or the process is draining.
import { Elysia } from "elysia";
import { GatewayError } from "../../protocol/gateway-error";
import { fastPathname } from "../pathname";
import { shutdownNotice } from "../shutdown-notice";
import type { ReadinessMiddlewareDeps } from "../contracts";

export function createDependencyReadinessMiddleware(deps: ReadinessMiddlewareDeps): Elysia {
  return new Elysia()
    .beforeHandle(async ({ request }) => {
      const path = fastPathname(request.url);
      if (
        path === "/health" ||
        path === "/health/ready" ||
        (!path.startsWith("/v1/") && !path.startsWith("/console/api/"))
      )
        return;
      if (deps.shutdownCoordinator?.isDraining()) {
        const notice = shutdownNotice(deps.shutdownCoordinator.shutdownReason?.());
        throw new GatewayError(notice.code, 503, notice.message);
      }
      // GET /v1/models only reads the public catalog — the same cheap read
      // the concurrency guard exempts — so a slow readiness probe must not
      // turn a models fetch into a 503. Drain still blocks it: a draining
      // process is going away regardless of how cheap the read is.
      if (request.method === "GET" && fastPathname(request.url) === "/v1/models") return;
      const readiness = await deps.readiness();
      if (readiness.status !== "ready") {
        // A probe that timed out under load says nothing about the dependencies —
        // it could not get a backend in time, usually because the process is
        // saturated. Fail open: the timeout is usually the event loop busy
        // rebuilding the route snapshot, not a down database (the probe's own
        // comment in persistence/readiness.ts says the same). Shedding here
        // turned a transient slow probe into a buyer-facing 503 storm on a
        // host with ample headroom, so let the request run — it still has its
        // own deadlines. A hard failure (connection refused, migrations
        // missing) keeps the dependency message below, which tells the
        // operator what to actually fix.
        if (readiness.reason?.endsWith("timed out")) {
          return;
        }
        throw new GatewayError("platform_unavailable", 503, "The gateway's dependencies are not ready, so no request can be served (request {requestId}). Retry shortly; if it persists, check the database and coordination backend. Warming up — back in a moment ☕️");
      }
    })
    .as("plugin");
}
