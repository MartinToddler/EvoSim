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
    // `JSON.parse` can produce a real own "__proto__" key, and snapshots are
    // JSON that may come from disk. Plain assignment would invoke
    // Object.prototype's setter and reshape the clone's prototype instead of
    // copying the data, so every key is defined as an own property.
    Object.defineProperty(out, key, {
      value: deepCloneJson((value as Record<string, unknown>)[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out as T;
}
