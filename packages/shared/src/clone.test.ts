import { describe, expect, it } from "vitest";
import { deepCloneJson } from "./clone";

describe("deepCloneJson", () => {
  it("clones nested objects and arrays without sharing references", () => {
    const source = { a: 1, b: { c: [1, 2, { d: "x" }] }, e: true };
    const clone = deepCloneJson(source);
    expect(clone).toEqual(source);
    expect(clone).not.toBe(source);
    expect(clone.b).not.toBe(source.b);
    expect(clone.b.c).not.toBe(source.b.c);
    expect(clone.b.c[2]).not.toBe(source.b.c[2]);
  });

  it("returns primitives unchanged", () => {
    expect(deepCloneJson(42)).toBe(42);
    expect(deepCloneJson("s")).toBe("s");
    expect(deepCloneJson(false)).toBe(false);
  });

  it("clones of frozen sources are mutable at runtime", () => {
    const frozen = Object.freeze({ x: Object.freeze({ y: 1 }) });
    // The static type keeps `readonly`, so widen for the runtime mutation check.
    const clone = deepCloneJson(frozen) as { x: { y: number } };
    clone.x.y = 2;
    expect(clone.x.y).toBe(2);
    expect(frozen.x.y).toBe(1);
  });
});

describe("deepCloneJson prototype safety", () => {
  it("copies a __proto__ key as data instead of reshaping the clone", () => {
    // JSON.parse produces a real own "__proto__" key, and snapshots are JSON
    // that may come from disk. Plain assignment would invoke the setter on
    // Object.prototype and silently change the clone's prototype instead.
    const hostile = JSON.parse('{"a":1,"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const clone = deepCloneJson(hostile);

    expect(Object.keys(clone).sort()).toEqual(["__proto__", "a"]);
    expect(Object.getPrototypeOf(clone)).toBe(Object.prototype);
    expect((clone as { polluted?: boolean }).polluted).toBeUndefined();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
