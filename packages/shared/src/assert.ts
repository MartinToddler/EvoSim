/** Error thrown when a project invariant is violated. */
export class EonAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EonAssertionError";
  }
}

/**
 * Assert an invariant. Throws {@link EonAssertionError} when the condition is false.
 *
 * Used for cheap always-on invariants; expensive debug-only invariant sweeps
 * (see docs/07 §4) get a separate switchable mechanism when they arrive.
 */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new EonAssertionError(message);
  }
}

/** Exhaustiveness helper for discriminated unions. */
export function unreachable(value: never, message = "Unreachable code reached"): never {
  throw new EonAssertionError(`${message}: ${String(value)}`);
}
