/**
 * Deep clone for plain JSON-safe data (objects, arrays, finite numbers,
 * strings, booleans).
 *
 * Exists because the pure engine cannot assume host globals like
 * `structuredClone` (no DOM/node environment assumptions), and config/snapshot
 * data is plain data by contract anyway.
 */
export function deepCloneJson<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => deepCloneJson(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    out[key] = deepCloneJson((value as Record<string, unknown>)[key]);
  }
  return out as T;
}
