/**
 * Canonical state hashing (task B06, CLAUDE.md determinism rules,
 * docs/10 §17).
 *
 * Project-owned incremental hash over a stream of 32-bit words. Two
 * independent lanes (different seeds and multiply constants, mixing scheme
 * derived from MurmurHash3) are combined into a 64-bit hex digest, which keeps
 * accidental collisions in golden regression fixtures negligible while
 * remaining fast integer-only math.
 *
 * Canonical stream rules:
 * - values are hashed logically (explicit words), never as raw memory bytes,
 *   so the digest is endianness-independent;
 * - every array contribution is prefixed with a type tag word and a length
 *   word to keep the stream unambiguous (docs/10 §17);
 * - signed values contribute their two's-complement 32-bit pattern.
 */

const C1A = 0xcc9e2d51;
const C2A = 0x1b873593;
const C1B = 0x38b34ae5;
const C2B = 0xa1e38b93;
const SEED_A = 0x9e3779b9;
const SEED_B = 0x85ebca6b;

/** Array/type tags for the canonical stream. */
export const HASH_TAG = {
  u8: 0xe0a70101,
  i8: 0xe0a70102,
  u16: 0xe0a70103,
  i16: 0xe0a70104,
  u32: 0xe0a70105,
  i32: 0xe0a70106,
  string: 0xe0a70107,
} as const;

function rotl32(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function fmix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function toHex32(value: number): string {
  return value.toString(16).padStart(8, "0");
}

export class StateHash {
  private h1 = SEED_A;
  private h2 = SEED_B;
  private words = 0;

  /** Feed one 32-bit word (any JS integer; coerced to its unsigned 32-bit pattern). */
  word(value: number): this {
    const w = value >>> 0;

    let k1 = Math.imul(w, C1A) >>> 0;
    k1 = rotl32(k1, 15);
    k1 = Math.imul(k1, C2A) >>> 0;
    this.h1 = (Math.imul(rotl32(this.h1 ^ k1, 13), 5) + 0xe6546b64) >>> 0;

    let k2 = Math.imul(w, C1B) >>> 0;
    k2 = rotl32(k2, 17);
    k2 = Math.imul(k2, C2B) >>> 0;
    this.h2 = (Math.imul(rotl32(this.h2 ^ k2, 15), 5) + 0x38495ab5) >>> 0;

    this.words += 1;
    return this;
  }

  /** Feed a typed/plain integer array with tag + length prefix. */
  array(tag: (typeof HASH_TAG)[keyof typeof HASH_TAG], values: ArrayLike<number>): this {
    this.word(tag);
    this.word(values.length);
    for (let i = 0; i < values.length; i += 1) {
      this.word(values[i] as number);
    }
    return this;
  }

  /** Feed a string as UTF-16 code units with tag + length prefix. */
  string(value: string): this {
    this.word(HASH_TAG.string);
    this.word(value.length);
    for (let i = 0; i < value.length; i += 1) {
      this.word(value.charCodeAt(i));
    }
    return this;
  }

  /** Finalize into a 16-hex-char digest. Hashing after digest() is not supported. */
  digest(): string {
    let f1 = this.h1 ^ (this.words >>> 0);
    let f2 = this.h2 ^ (this.words >>> 0);
    f1 = fmix32(f1);
    f2 = fmix32(f2);
    // Cross-mix the lanes so the digest halves are not independently truncatable.
    const d1 = (f1 + f2) >>> 0;
    const d2 = (f2 + Math.imul(f1, 5)) >>> 0;
    return toHex32(d1) + toHex32(d2);
  }
}

/** Convenience helper: digest of a plain word sequence. */
export function hashWords(words: readonly number[]): string {
  const hasher = new StateHash();
  for (const w of words) {
    hasher.word(w);
  }
  return hasher.digest();
}
