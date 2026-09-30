import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  accountSocketBytes,
  accountSocketWrites,
  MAX_BYTE_ENTRY_COUNT,
  poolByteSnapshot,
  poolByteTotals,
  recordPoolBytes,
  resetPoolByteAccounting,
} from "../../src/network/pool/byte-accounting";

beforeEach(() => resetPoolByteAccounting());

describe("recordPoolBytes", () => {
  test("accumulates each direction independently", () => {
    recordPoolBytes("p1", "sent", 100);
    recordPoolBytes("p1", "received", 40);
    recordPoolBytes("p1", "sent", 5);
    expect(poolByteTotals("p1")).toEqual({ sent: 105, received: 40 });
  });

  test("keeps pools separate", () => {
    recordPoolBytes("p1", "sent", 10);
    recordPoolBytes("p2", "sent", 20);
    expect(poolByteTotals("p1").sent).toBe(10);
    expect(poolByteTotals("p2").sent).toBe(20);
  });

  test("ignores zero and negative counts", () => {
    recordPoolBytes("p1", "sent", 0);
    recordPoolBytes("p1", "sent", -1);
    expect(poolByteTotals("p1")).toEqual({ sent: 0, received: 0 });
  });

  test("an unknown pool reads as zero rather than undefined", () => {
    expect(poolByteTotals("never-seen")).toEqual({ sent: 0, received: 0 });
  });

  test("the snapshot only lists pools that carried traffic", () => {
    expect(poolByteSnapshot()).toEqual([]);
    recordPoolBytes("p1", "received", 7);
    expect(poolByteSnapshot()).toEqual([{ poolId: "p1", sent: 0, received: 7 }]);
  });

  test("the entry bound evicts rather than growing without limit", () => {
    for (let i = 0; i < MAX_BYTE_ENTRY_COUNT + 1; i += 1) recordPoolBytes(`pool-${i}`, "sent", 1);
    expect(poolByteSnapshot().length).toBe(MAX_BYTE_ENTRY_COUNT);
    // The oldest key went first, the newest is still there.
    expect(poolByteTotals("pool-0")).toEqual({ sent: 0, received: 0 });
    expect(poolByteTotals(`pool-${MAX_BYTE_ENTRY_COUNT}`).sent).toBe(1);
  });
});

describe("accountSocketBytes", () => {
  test("counts every chunk read from the socket", () => {
    const socket = new EventEmitter();
    accountSocketBytes(socket, "p1");
    socket.emit("data", Buffer.alloc(1500));
    socket.emit("data", Buffer.alloc(200));
    expect(poolByteTotals("p1").received).toBe(1700);
  });

  test("stays attached across chunks and never detaches", () => {
    const socket = new EventEmitter();
    accountSocketBytes(socket, "p1");
    socket.emit("data", Buffer.alloc(1));
    socket.emit("data", Buffer.alloc(1));
    socket.emit("data", Buffer.alloc(1));
    expect(socket.listenerCount("data")).toBe(1);
    expect(poolByteTotals("p1").received).toBe(3);
  });

  test("ignores payloads without a length", () => {
    const socket = new EventEmitter();
    accountSocketBytes(socket, "p1");
    socket.emit("data", null);
    expect(poolByteTotals("p1").received).toBe(0);
  });

  test("returns the same socket so it can be used inline", () => {
    const socket = new EventEmitter();
    expect(accountSocketBytes(socket, "p1")).toBe(socket);
  });
});

describe("accountSocketWrites", () => {
  test("counts buffers and forwards them to the original write", () => {
    const written: unknown[] = [];
    const socket = {
      write: (...args: unknown[]) => {
        written.push(args[0]);
        return true;
      },
    };
    accountSocketWrites(socket, "p1");
    socket.write(Buffer.alloc(4096));
    socket.write(Buffer.alloc(64));
    expect(poolByteTotals("p1").sent).toBe(4160);
    expect(written.length).toBe(2);
  });

  test("measures string chunks in utf-8 bytes, not characters", () => {
    const socket = { write: (_chunk: unknown) => true };
    accountSocketWrites(socket, "p1");
    socket.write("é"); // 2 bytes in utf-8, 1 character
    expect(poolByteTotals("p1").sent).toBe(2);
  });

  test("passes every argument through unchanged", () => {
    const calls: unknown[][] = [];
    const socket = {
      write: (...args: unknown[]) => {
        calls.push(args);
        return true;
      },
    };
    accountSocketWrites(socket, "p1");
    socket.write(Buffer.alloc(1), "utf8", () => undefined);
    expect(calls[0]?.length).toBe(3);
    expect(calls[0]?.[1]).toBe("utf8");
  });

  test("keeps `this` bound to the socket", () => {
    const socket = {
      label: "sock",
      write(this: { label: string }, _chunk: unknown) {
        return this.label;
      },
    };
    accountSocketWrites(socket, "p1");
    expect(socket.write(Buffer.alloc(1))).toBe("sock");
  });

  test("counts only the pool it was attached to", () => {
    const socket = { write: (_chunk: unknown) => true };
    accountSocketWrites(socket, "p1");
    socket.write(Buffer.alloc(10));
    expect(poolByteTotals("p1").sent).toBe(10);
    expect(poolByteTotals("p2").sent).toBe(0);
  });
});
