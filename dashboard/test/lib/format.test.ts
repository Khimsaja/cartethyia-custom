import { describe, expect, test } from "bun:test";
import {
  formatBytes,
  formatCredits,
  formatDuration,
  formatNumber,
  formatUptime,
} from "../../src/shared/format";

/**
 * The single formatting policy: an absent or non-finite value renders as `—`,
 * and zero is a real measurement rather than an absent one. Before this module
 * existed, four `formatBytes` copies disagreed on all three points, so the same
 * byte count read differently depending on which page rendered it.
 */
describe("formatBytes", () => {
  test("scales B / KB / MB with one decimal above the base unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });

  test("renders the placeholder only for absent or non-finite values", () => {
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(0)).toBe("0 B");
  });
});

describe("formatDuration", () => {
  test("keeps sub-second values in ms and scales above", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(250)).toBe("250 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
  });

  test("renders the placeholder for absent values", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(null)).toBe("—");
  });
});

describe("formatUptime", () => {
  test("drops units that would be zero", () => {
    expect(formatUptime(45)).toBe("45s");
    expect(formatUptime(90)).toBe("1m 30s");
    expect(formatUptime(3600)).toBe("1h 0m");
    expect(formatUptime(86_400 + 3600)).toBe("1d 1h");
  });

  test("renders the placeholder for absent values", () => {
    expect(formatUptime(undefined)).toBe("—");
    expect(formatUptime(Number.NaN)).toBe("—");
  });
});

describe("formatNumber", () => {
  test("rounds and groups in the viewer's locale", () => {
    expect(formatNumber(1234.6, "en-US")).toBe("1,235");
    expect(formatNumber(1234.6, "id-ID")).toBe("1.235");
    expect(formatNumber(0, "en-US")).toBe("0");
    expect(formatNumber(undefined)).toBe("—");
  });
});

describe("formatCredits", () => {
  test("groups the raw amount instead of abbreviating it", () => {
    // The whole point of this formatter: a 9393-credit balance must read
    // `9,393`, never the compact `9.4K` that suits a chart axis.
    expect(formatCredits(9393, "en-US")).toBe("9,393");
    expect(formatCredits(1_234_567, "en-US")).toBe("1,234,567");
  });

  test("keeps up to two fraction digits, dropping a trailing .00", () => {
    expect(formatCredits(1234.56, "en-US")).toBe("1,234.56");
    expect(formatCredits(1.01, "en-US")).toBe("1.01");
    expect(formatCredits(500, "en-US")).toBe("500");
  });

  test("groups by the viewer's locale so the separators are unambiguous", () => {
    // A reader whose convention is `.`-thousands / `,`-decimals must not have
    // to guess whether `4,093.36` is four thousand or four million.
    expect(formatCredits(4093.36, "id-ID")).toBe("4.093,36");
    expect(formatCredits(1_234_567, "id-ID")).toBe("1.234.567");
  });

  test("renders the placeholder for absent values and keeps zero real", () => {
    expect(formatCredits(undefined)).toBe("—");
    expect(formatCredits(null)).toBe("—");
    expect(formatCredits(Number.NaN)).toBe("—");
    expect(formatCredits(0, "en-US")).toBe("0");
  });
});
