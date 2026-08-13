import { describe, expect, it } from "vitest";
import { DEFAULT_SEED, readSeedFromLocation } from "./seed";

describe("readSeedFromLocation", () => {
  it("opens the project's fixture world by default", () => {
    // The world the golden hashes, the headless runner and the soaks describe.
    expect(DEFAULT_SEED).toBe(0xe0a12026);
    expect(readSeedFromLocation("")).toBe(DEFAULT_SEED);
    expect(readSeedFromLocation("?other=1")).toBe(DEFAULT_SEED);
    expect(readSeedFromLocation("?seed=")).toBe(DEFAULT_SEED);
  });

  it("accepts decimal and hexadecimal seeds", () => {
    expect(readSeedFromLocation("?seed=12345")).toBe(12345);
    expect(readSeedFromLocation("?seed=0xE0A12026")).toBe(0xe0a12026);
    expect(readSeedFromLocation("?seed=0xdeadbeef")).toBe(0xdeadbeef);
  });

  it("normalizes to uint32 exactly as the engine does", () => {
    // The engine does `seed >>> 0`, so a link and the world it names must agree.
    expect(readSeedFromLocation("?seed=-1")).toBe(0xffffffff);
    expect(readSeedFromLocation("?seed=4294967296")).toBe(0);
  });

  it("falls back rather than throwing on nonsense", () => {
    // A typo in a shared URL should open the default world, not a blank page.
    expect(readSeedFromLocation("?seed=banana")).toBe(DEFAULT_SEED);
    expect(readSeedFromLocation("?seed=0x")).toBe(DEFAULT_SEED);
    expect(readSeedFromLocation("?seed=NaN")).toBe(DEFAULT_SEED);
    expect(readSeedFromLocation("?seed=Infinity")).toBe(DEFAULT_SEED);
  });

  it("tolerates surrounding whitespace", () => {
    expect(readSeedFromLocation("?seed=%20777%20")).toBe(777);
  });
});
