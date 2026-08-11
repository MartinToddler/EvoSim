import { describe, expect, it } from "vitest";
import { Q } from "../math/fixed";
import { Xoshiro128, splitmix32 } from "./Xoshiro128";

/**
 * Golden vectors (task B04). The uint32 sequences below were cross-validated
 * against an independent Python implementation of splitmix32 seeding +
 * xoshiro128** (Blackman & Vigna reference algorithm). Any change here is an
 * engine-version-bump event.
 */
const GOLDEN_SEED = 0xe0a12026;

const GOLDEN_STATE_E0A12026 = [0xc45acd5c, 0x0ee01018, 0x0a729883, 0xc0e0b41a] as const;

const GOLDEN_U32_E0A12026 = [
  2976521549, 2585919721, 2406525635, 3283258247, 491088336, 1367079974, 2279094759, 4215663913,
  2819276595, 2699625748, 1007410095, 663437229,
];

const GOLDEN_STATE_SEED1 = [0x5e2d1772, 0x14e498f0, 0xd20ea1fd, 0xb382f339] as const;

const GOLDEN_U32_SEED1 = [
  393288148, 2174103013, 3814759091, 2092745082, 1865176206, 2179171167, 3207394750, 2858353069,
  559075315, 3395495274, 4035540825, 1929427096,
];

describe("splitmix32 seeding", () => {
  it("expands seeds into the documented state words", () => {
    expect(Xoshiro128.fromSeed(GOLDEN_SEED).serializeState()).toEqual(GOLDEN_STATE_E0A12026);
    expect(Xoshiro128.fromSeed(1).serializeState()).toEqual(GOLDEN_STATE_SEED1);
  });

  it("coerces seeds to uint32", () => {
    expect(Xoshiro128.fromSeed(-1).serializeState()).toEqual(
      Xoshiro128.fromSeed(0xffffffff).serializeState(),
    );
    expect(Xoshiro128.fromSeed(2 ** 32).serializeState()).toEqual(
      Xoshiro128.fromSeed(0).serializeState(),
    );
  });

  it("splitmix32 advances state deterministically", () => {
    const round1 = splitmix32(0);
    const round2 = splitmix32(round1.state);
    expect(round1.state).toBe(0x9e3779b9);
    expect(round1.value).toBeGreaterThanOrEqual(0);
    expect(round2.value).not.toBe(round1.value);
  });
});

describe("nextU32 golden vectors", () => {
  it("matches the reference sequence for the fixture seed 0xE0A12026", () => {
    const rng = Xoshiro128.fromSeed(GOLDEN_SEED);
    const out = GOLDEN_U32_E0A12026.map(() => rng.nextU32());
    expect(out).toEqual(GOLDEN_U32_E0A12026);
  });

  it("matches the reference sequence for seed 1", () => {
    const rng = Xoshiro128.fromSeed(1);
    const out = GOLDEN_U32_SEED1.map(() => rng.nextU32());
    expect(out).toEqual(GOLDEN_U32_SEED1);
  });

  it("always yields uint32 values", () => {
    const rng = Xoshiro128.fromSeed(0xdeadbeef);
    for (let i = 0; i < 1000; i += 1) {
      const v = rng.nextU32();
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("derived draws", () => {
  it("nextInt matches its golden sequence and bounds", () => {
    const rng = Xoshiro128.fromSeed(GOLDEN_SEED);
    const out = Array.from({ length: 8 }, () => rng.nextInt(100));
    expect(out).toEqual([49, 21, 35, 47, 36, 74, 59, 13]);
  });

  it("nextInt stays inside [0, max) for many draws", () => {
    const rng = Xoshiro128.fromSeed(7);
    for (let i = 0; i < 5000; i += 1) {
      const v = rng.nextInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });

  it("nextInt(1) is always 0 and rejects invalid bounds", () => {
    const rng = Xoshiro128.fromSeed(7);
    expect(rng.nextInt(1)).toBe(0);
    expect(() => rng.nextInt(0)).toThrow();
    expect(() => rng.nextInt(1.5)).toThrow();
    expect(() => rng.nextInt(2 ** 32)).toThrow();
  });

  it("nextQ matches its golden sequence and range [0, Q)", () => {
    const rng = Xoshiro128.fromSeed(GOLDEN_SEED);
    const out = Array.from({ length: 8 }, () => rng.nextQ());
    expect(out).toEqual([3405, 233, 2755, 2951, 2512, 3110, 2535, 3369]);
    for (let i = 0; i < 5000; i += 1) {
      const v = rng.nextQ();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(Q);
    }
  });

  it("nextSignedQ matches its golden sequence and range [-Q, Q]", () => {
    const rng = Xoshiro128.fromSeed(GOLDEN_SEED);
    const out = Array.from({ length: 8 }, () => rng.nextSignedQ());
    expect(out).toEqual([553, 0, -158, -476, 4013, 91, 2888, 825]);
    for (let i = 0; i < 5000; i += 1) {
      const v = rng.nextSignedQ();
      expect(v).toBeGreaterThanOrEqual(-Q);
      expect(v).toBeLessThanOrEqual(Q);
    }
  });

  it("approxNormalQ matches its golden sequence (stable Irwin-Hall draws)", () => {
    const rng = Xoshiro128.fromSeed(GOLDEN_SEED);
    const out = Array.from({ length: 8 }, () => rng.approxNormalQ());
    expect(out).toEqual([1488, 2650, 2231, 3284, -4772, -3867, 4431, 837]);
  });

  it("approxNormalQ stays within [-6Q, 6Q] and is roughly centered", () => {
    const rng = Xoshiro128.fromSeed(123);
    let sum = 0;
    for (let i = 0; i < 4096; i += 1) {
      const v = rng.approxNormalQ();
      expect(v).toBeGreaterThanOrEqual(-6 * Q);
      expect(v).toBeLessThanOrEqual(6 * Q);
      sum += v;
    }
    // Deterministic sample mean; |mean| far below one sigma (≈ Q).
    expect(Math.abs(sum / 4096)).toBeLessThan(Q / 8);
  });
});

describe("state serialization", () => {
  it("save/restore reproduces the exact continuation sequence", () => {
    const rng = Xoshiro128.fromSeed(GOLDEN_SEED);
    for (let i = 0; i < 100; i += 1) {
      rng.nextU32();
    }
    const saved = rng.serializeState();
    const continued = Array.from({ length: 16 }, () => rng.nextU32());

    const restored = Xoshiro128.fromState(saved);
    const replayed = Array.from({ length: 16 }, () => restored.nextU32());
    expect(replayed).toEqual(continued);
  });

  it("restoreState rejects invalid states", () => {
    const rng = Xoshiro128.fromSeed(1);
    expect(() => rng.restoreState([0, 0, 0, 0])).toThrow();
    expect(() => rng.restoreState([1.5, 0, 0, 0] as never)).toThrow();
    expect(() => rng.restoreState([-1, 0, 0, 1] as never)).toThrow();
  });

  it("serializeState does not advance the generator", () => {
    const rng = Xoshiro128.fromSeed(9);
    const before = rng.serializeState();
    rng.serializeState();
    expect(rng.serializeState()).toEqual(before);
  });
});
