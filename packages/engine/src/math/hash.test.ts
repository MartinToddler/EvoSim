import { describe, expect, it } from "vitest";
import { HASH_TAG, StateHash, hashWords } from "./hash";

describe("StateHash", () => {
  it("matches golden digests (locks the canonical hash algorithm)", () => {
    expect(new StateHash().digest()).toBe("5e3ca61da9656255");
    expect(hashWords([0])).toBe("b4fdc79e97e08d5a");
    expect(hashWords([1, 2, 3])).toBe("c07b52bf5247628f");
    expect(new StateHash().string("EON").digest()).toBe("38107b37df8f333b");
  });

  it("is deterministic across instances", () => {
    const a = new StateHash().word(42).word(7).digest();
    const b = new StateHash().word(42).word(7).digest();
    expect(a).toBe(b);
  });

  it("is order sensitive", () => {
    expect(hashWords([1, 2])).not.toBe(hashWords([2, 1]));
  });

  it("coerces words to their unsigned 32-bit pattern", () => {
    expect(hashWords([-1])).toBe(hashWords([0xffffffff]));
    expect(hashWords([2 ** 32])).toBe(hashWords([0]));
  });

  it("length prefixes disambiguate array boundaries", () => {
    const split12 = new StateHash().array(HASH_TAG.u32, [1, 2]).array(HASH_TAG.u32, [3]).digest();
    const split1 = new StateHash().array(HASH_TAG.u32, [1]).array(HASH_TAG.u32, [2, 3]).digest();
    expect(split12).toBe("c75241afcacb2f97");
    expect(split1).toBe("3ed24921ea4c9705");
    expect(split12).not.toBe(split1);
  });

  it("type tags disambiguate identical values in different array types", () => {
    const asU16 = new StateHash().array(HASH_TAG.u16, [1, 2]).digest();
    const asU32 = new StateHash().array(HASH_TAG.u32, [1, 2]).digest();
    expect(asU16).toBe("7c92aec3dd7e3dc7");
    expect(asU32).toBe("2948bf6861a7d0d0");
    expect(asU16).not.toBe(asU32);
  });

  it("hashes typed arrays identically to plain arrays with the same values", () => {
    const typed = new StateHash().array(HASH_TAG.i16, new Int16Array([5, -5])).digest();
    const plain = new StateHash().array(HASH_TAG.i16, [5, -5]).digest();
    expect(typed).toBe(plain);
  });

  it("produces 16 lowercase hex characters", () => {
    expect(hashWords([123456789])).toMatch(/^[0-9a-f]{16}$/);
  });
});
