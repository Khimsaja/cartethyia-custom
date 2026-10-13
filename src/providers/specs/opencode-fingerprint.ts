import { getOpenCodeVersion } from "../operations/client-versions";

let lastTimestamp = 0;
let sequenceCounter = 0;

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
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const suffix = Array.from(rand, (byte) => chars[byte % 62]).join("");
  return `ses_${hex}${suffix}`;
}

/** Generate a valid OpenCode message/request identifier: `msg_` + 30-char hex. */
export function generateOpenCodeRequestId(): string {
  return `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 30)}`;
}

function isOpenCodeSessionId(value: string | undefined): value is string {
  return value !== undefined && /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(value);
}

/** Build OpenCode identity headers while keeping cache affinity separate from its session ID. */
export function buildOpenCodeHeaders(
  version = getOpenCodeVersion(),
  affinity?: string,
): Record<string, string> {
  return {
    "x-opencode-client": "opencode",
    "x-opencode-session": isOpenCodeSessionId(affinity) ? affinity : generateOpenCodeSessionId(),
    ...(affinity === undefined ? {} : { "x-session-affinity": affinity }),
    "x-opencode-request": generateOpenCodeRequestId(),
    "x-opencode-project": "global",
    "user-agent": `opencode/${version}`,
  };
}
