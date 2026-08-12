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
    const cloned = deepCloneJson((value as Record<string, unknown>)[key]);
    if (key === "__proto__") {
      // Plain assignment would invoke Object.prototype's __proto__ setter and
      // reshape the clone's prototype instead of copying data. Snapshots are
      // JSON that may come from disk, and JSON.parse does produce an own
      // "__proto__" key, so define it as a real own property: the data survives
      // intact and the schema validator can reject it as an unknown field.
      Object.defineProperty(out, key, {
        value: cloned,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else {
      out[key] = cloned;
    }
  }
  return out as T;
}
