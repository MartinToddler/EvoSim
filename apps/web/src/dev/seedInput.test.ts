import { describe, expect, it } from "vitest";
import { MAX_SEED, formatSeedHex, parseSeedInput } from "./seedInput";

function expectSeed(raw: string, seed: number): void {
  const result = parseSeedInput(raw);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toBe(seed);
  }
}

function expectRejected(raw: string): string {
  const result = parseSeedInput(raw);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.error;
}

describe("parseSeedInput", () => {
  it("accepts decimal and hex forms of the same seed", () => {
    expectSeed("3768655910", 0xe0a12026);
    expectSeed("0xE0A12026", 0xe0a12026);
    expectSeed("0xe0a12026", 0xe0a12026);
    expectSeed("0X0", 0);
  });

  it("tolerates surrounding whitespace", () => {
    expectSeed("  42 ", 42);
    expectSeed("\t0x2A\n", 42);
  });

  it("accepts both ends of the uint32 range", () => {
    expectSeed("0", 0);
    expectSeed(String(MAX_SEED), MAX_SEED);
    expectSeed("0xFFFFFFFF", MAX_SEED);
  });

  it("rejects trailing garbage instead of silently parsing a prefix", () => {
    // Number.parseInt("100abc") is 100 — a different world than the user typed.
    expect(expectRejected("100abc")).toContain("not an unsigned integer");
    expect(expectRejected("0x1G")).toContain("not an unsigned integer");
    expect(expectRejected("12 34")).toContain("not an unsigned integer");
  });

  it("rejects decimals instead of truncating them", () => {
    expect(expectRejected("1.5")).toContain("not an unsigned integer");
    expect(expectRejected("1e3")).toContain("not an unsigned integer");
  });

  it("rejects negative seeds rather than wrapping them", () => {
    expect(expectRejected("-1")).toContain("not an unsigned integer");
  });

  it("rejects values outside the uint32 range rather than coercing with >>> 0", () => {
    expect(expectRejected(String(MAX_SEED + 1))).toContain("Seed must be in");
    expect(expectRejected("0x100000000")).toContain("Seed must be in");
  });

  it("rejects an empty field with an actionable message", () => {
    expect(expectRejected("")).toContain("Enter a seed");
    expect(expectRejected("   ")).toContain("Enter a seed");
  });

  it("rejects hex without digits and bare 0x", () => {
    expect(expectRejected("0x")).toContain("not an unsigned integer");
  });
});

describe("formatSeedHex", () => {
  it("formats as zero-padded uppercase hex", () => {
    expect(formatSeedHex(0xe0a12026)).toBe("0xE0A12026");
    expect(formatSeedHex(0)).toBe("0x00000000");
    expect(formatSeedHex(42)).toBe("0x0000002A");
    expect(formatSeedHex(MAX_SEED)).toBe("0xFFFFFFFF");
  });

  it("round-trips through the parser for every representable seed shape", () => {
    for (const seed of [0, 1, 42, 0x1234, 0xe0a12026, MAX_SEED]) {
      expectSeed(formatSeedHex(seed), seed);
    }
  });
});
