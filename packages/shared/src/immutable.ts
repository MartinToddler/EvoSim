/**
 * Immutability primitives for plain JSON-safe data.
 *
 * Used to make authoritative configuration tamper-proof once a world exists:
 * the engine validates, deep clones, deep freezes and only then hashes, so a
 * caller can never mutate config behind an already-computed config hash.
 */

/**
 * Recursively `readonly` view of a plain data type.
 *
 * The homomorphic mapped type also covers arrays and tuples, which keeps tuple
 * shapes intact — a naive `T extends ReadonlyArray<infer E>` branch would
 * collapse `readonly [number, number, number, number]` into
 * `ReadonlyArray<number>` and break fixed-width state types such as the PRNG
 * state tuple.
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/**
 * Recursively `Object.freeze` a plain data structure and return it typed as
 * {@link DeepReadonly}. Arrays are frozen too, so index assignment throws in
 * strict mode (all ES modules are strict).
 *
 * Plain JSON-shaped data only. Never call this on TypedArrays or engine stores:
 * `Object.freeze` throws a TypeError on a TypedArray that has elements, because
 * its indexed properties cannot be made non-configurable.
 */
export function deepFreezeJson<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreezeJson((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
