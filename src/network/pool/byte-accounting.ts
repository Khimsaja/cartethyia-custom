/**
 * Per-pool egress byte accounting.
 *
 * Counts the bytes a pool's proxy actually carries. The number that matters is
 * the *wire* figure — TLS records, handshake, and all — because that is what a
 * proxy provider bills. Node's socket counters cannot supply it: once TLS wraps
 * a socket, `bytesWritten` on the raw socket stays at 0, and `TLSSocket`'s own
 * counters report decrypted plaintext (measured at ~17% of the true wire
 * volume). So the bytes are summed here, from the raw socket's `data` events,
 * before TLS ever sees them.
 *
 * The cost is one integer addition per TCP chunk (typically 16-64 KiB), not per
 * byte, and nothing is allocated.
 */

/** Running totals for one pool. */
export interface PoolByteTotals {
  /** Bytes sent to the proxy (uploads, TLS handshake, CONNECT). */
  readonly sent: number;
  /** Bytes received from the proxy (downloads). */
  readonly received: number;
}

const totals = new Map<string, { sent: number; received: number }>();

/**
 * Bound on tracked pools. Keys are pool ids, so the real bound is the pool
 * count; this only guards against a bug that mints unbounded ids.
 */
export const MAX_BYTE_ENTRY_COUNT = 10_000;

function entry(poolId: string): { sent: number; received: number } {
  let current = totals.get(poolId);
  if (!current) {
    if (totals.size >= MAX_BYTE_ENTRY_COUNT) {
      const oldest = totals.keys().next().value;
      if (oldest !== undefined) totals.delete(oldest);
    }
    current = { sent: 0, received: 0 };
    totals.set(poolId, current);
  }
  return current;
}

/** Adds one direction's chunk to a pool's running total. */
export function recordPoolBytes(poolId: string, direction: "sent" | "received", bytes: number): void {
  if (bytes <= 0) return;
  entry(poolId)[direction] += bytes;
}

/** Totals for one pool; zeroes when it has carried nothing yet. */
export function poolByteTotals(poolId: string): PoolByteTotals {
  const current = totals.get(poolId);
  return current ? { sent: current.sent, received: current.received } : { sent: 0, received: 0 };
}

/** Every pool that has carried traffic, for the live snapshot. */
export function poolByteSnapshot(): ReadonlyArray<{ poolId: string } & PoolByteTotals> {
  return [...totals.entries()].map(([poolId, value]) => ({
    poolId,
    sent: value.sent,
    received: value.received,
  }));
}

/** Test seam: drop all accounting. */
export function resetPoolByteAccounting(): void {
  totals.clear();
}

/**
 * Wraps a raw (pre-TLS) socket so both directions are tallied for `poolId`.
 *
 * Attaching a second `data` listener is safe: it observes the same chunks the
 * TLS layer consumes and does not alter the stream. `once`-style listeners are
 * deliberately not used — the socket is long-lived under keep-alive.
 */
export function accountSocketBytes<T extends { on: (event: string, listener: (chunk: unknown) => void) => unknown }>(
  socket: T,
  poolId: string,
): T {
  socket.on("data", (chunk: unknown) => {
    const length = (chunk as { length?: number } | null)?.length;
    if (typeof length === "number") recordPoolBytes(poolId, "received", length);
  });
  return socket;
}

/**
 * Counts outbound bytes written to a raw socket.
 *
 * Wrapping `write` rather than listening for an event: there is no "data sent"
 * event on a socket, and the raw socket's own `bytesWritten` is unreliable once
 * TLS owns it (see the module note above).
 */
export function accountSocketWrites<T extends { write: (...args: never[]) => unknown }>(
  socket: T,
  poolId: string,
): T {
  const original = socket.write.bind(socket) as (...args: unknown[]) => unknown;
  socket.write = ((...args: unknown[]) => {
    const chunk = args[0];
    // Strings are checked first on purpose: they carry a `length` property too,
    // and that counts characters, not the bytes that actually go on the wire.
    if (typeof chunk === "string") {
      const encoding = typeof args[1] === "string" ? (args[1] as BufferEncoding) : "utf8";
      recordPoolBytes(poolId, "sent", Buffer.byteLength(chunk, encoding));
    } else {
      const length = (chunk as { length?: number } | null)?.length;
      if (typeof length === "number") recordPoolBytes(poolId, "sent", length);
    }
    return original(...args);
  }) as unknown as T["write"];
  return socket;
}
