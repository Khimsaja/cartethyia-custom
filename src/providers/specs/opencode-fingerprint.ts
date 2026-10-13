import { getOpenCodeVersion } from "../operations/client-versions";
import { createHash, randomBytes } from "node:crypto";

let lastTimestamp = 0;
let sequenceCounter = 0;
const SESSION_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Generate a valid OpenCode session identifier matching official binary:
 * `ses_` + 12-char hex (bitwise inverted millisecond timestamp * 4096 + seq) + 14-char base62.
 */
export function generateOpenCodeSessionId(now = Date.now()): string {
  if (now !== lastTimestamp) {
    lastTimestamp = now;
    sequenceCounter = 0;
  }
  sequenceCounter++;
  const num = BigInt(now) * 0x1000n + BigInt(sequenceCounter);
  const inverted = ~num;
  const hex = Array.from({ length: 6 }, (_, i) =>
    Number((inverted >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0"),
  ).join("");
  const rand = crypto.getRandomValues(new Uint8Array(14));
  const suffix = Array.from(rand, (byte) => SESSION_ID_ALPHABET[byte % 62]).join("");
  return `ses_${hex}${suffix}`;
}

function stableOpenCodeSessionId(affinity: string): string {
  const digest = createHash("sha256").update(`opencode-session:${affinity}`).digest();
  const timestamp = digest.subarray(0, 6).toString("hex");
  const suffix = Array.from(digest.subarray(6, 20), (byte) => SESSION_ID_ALPHABET[byte % 62]).join("");
  return `ses_${timestamp}${suffix}`;
}

function isOpenCodeSessionId(value: string | undefined): value is string {
  return value !== undefined && /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(value);
}

function createTraceHeaders(): Record<string, string> {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const parentSpanId = randomBytes(8).toString("hex");
  return {
    traceparent: `00-${traceId}-${spanId}-01`,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
  };
}

/** Build the observed OpenCode CLI identity headers for an upstream dispatch. */
export function buildOpenCodeHeaders(
  version = getOpenCodeVersion(),
  affinity?: string,
  projectId?: string,
): Record<string, string> {
  let sessionId: string;
  if (isOpenCodeSessionId(affinity)) {
    sessionId = affinity;
  } else if (affinity !== undefined) {
    sessionId = stableOpenCodeSessionId(affinity);
  } else {
    sessionId = generateOpenCodeSessionId();
  }
  return {
    "x-opencode-client": "cli",
    "x-opencode-session": sessionId,
    "x-opencode-session-id": sessionId,
    "x-session-affinity": sessionId,
    "x-session-id": sessionId,
    "x-opencode-project": projectId ?? "global",
    "user-agent": `opencode/latest/${version}/cli`,
    ...createTraceHeaders(),
  };
}
