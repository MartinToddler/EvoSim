import { describe, expect, it } from "vitest";
import { deepFreezeJson } from "./immutable";

describe("deepFreezeJson", () => {
  it("freezes nested objects and arrays", () => {
    const frozen = deepFreezeJson({ a: { b: [1, 2] }, c: 3 });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.a)).toBe(true);
    expect(Object.isFrozen(frozen.a.b)).toBe(true);
  });

  it("makes mutation throw in strict mode", () => {
    const frozen = deepFreezeJson({ a: { b: 1 }, list: [1, 2] }) as unknown as {
      a: { b: number };
      list: number[];
    };
    expect(() => {
      frozen.a.b = 2;
    }).toThrow();
    expect(() => {
      frozen.list[0] = 9;
    }).toThrow();
    expect(() => {
      frozen.list.push(3);
    }).toThrow();
  });

  it("returns the same object identity (freeze in place)", () => {
    const source = { x: 1 };
    expect(deepFreezeJson(source)).toBe(source);
  });

  it("passes primitives through", () => {
    expect(deepFreezeJson(7)).toBe(7);
    expect(deepFreezeJson("s")).toBe("s");
  });
});
