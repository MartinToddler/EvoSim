/**
 * Nominal (branded) typing helper for numeric identifiers.
 *
 * Example: `type EntityId = Brand<number, "EntityId">`. Entity/species ID rules
 * (monotonic uint32, 0 invalid, never reused) are defined in docs/03 §5 and are
 * implemented by the engine stores in Milestone 3+.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** Entity ID 0 is invalid everywhere (docs/03 §5). */
export const INVALID_ID = 0;
