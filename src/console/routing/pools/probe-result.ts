import type { HealthCheckResult } from "./contracts";
import { isIP } from "node:net";

/**
 * Pulls the egress address out of a Cloudflare trace response.
 *
 * The body is newline-delimited `key=value` pairs and the line we want is
 * `ip=<address>`. Returns undefined when the body is not a trace response or
 * carries no address, so callers treat "no address" as a missing observation
 * rather than a probe failure.
 */
export function parseEgressIp(body: string): string | undefined {
  const match = /^ip=(\S+)$/m.exec(body);
  const value = match?.[1]?.trim();
  return value && isIP(value) ? value : undefined;
}

/**
 * Classifies probe responses without confusing an HTTP proxy response with a
 * failed tunnel. 402 and 407 prove the proxy answered, but make it unusable.
 */
export function classifyPoolProbeResponse(
  poolId: string,
  response: Pick<Response, "ok" | "status">,
  latencyMs: number,
): HealthCheckResult {
  if (response.status === 402 || response.status === 407) {
    const reason =
      response.status === 402 ? "Payment Required" : "Proxy Authentication Required";
    return {
      poolId,
      status: "reachable",
      httpStatus: response.status,
      latencyMs,
      errorMessage: `Proxy reachable — HTTP ${response.status} ${reason}`,
    };
  }

  return {
    poolId,
    status: "healthy",
    latencyMs,
    ...(response.ok ? {} : { errorMessage: `HTTP ${response.status} (reachable)` }),
  };
}

/** Reads the explicit status from a failed HTTP-proxy CONNECT handshake. */
export function classifyPoolConnectError(
  poolId: string,
  error: unknown,
  latencyMs: number,
): HealthCheckResult | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = /^Proxy CONNECT failed: (402|407)\b/.exec(error.message);
  if (!match) return undefined;
  const status = match[1] === "402" ? 402 : 407;
  return classifyPoolProbeResponse(poolId, { ok: false, status }, latencyMs);
}
