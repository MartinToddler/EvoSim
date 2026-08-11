import { StateHash } from "../math/hash";
import type { SimulationConfig } from "./SimulationConfig";

/**
 * Canonical config serialization + hash.
 *
 * JSON.stringify key order follows insertion order, which is not canonical,
 * so the config is serialized with recursively sorted object keys before
 * hashing. Number formatting via ECMA-262 ToString(Number) is exactly
 * specified, so the canonical string — and therefore the hash — is
 * deterministic across platforms.
 */

export class ConfigSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigSerializationError";
  }
}

/** Serialize any plain JSON value with lexicographically sorted object keys. */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null) {
    throw new ConfigSerializationError("null is not allowed in canonical config data");
  }
  switch (typeof value) {
    case "number":
      if (!Number.isFinite(value)) {
        throw new ConfigSerializationError(`non-finite number in config: ${value}`);
      }
      return String(value);
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJsonStringify(item)).join(",")}]`;
      }
      const keys = Object.keys(value).sort();
      const parts = keys.map((key) => {
        const item = (value as Record<string, unknown>)[key];
        return `${JSON.stringify(key)}:${canonicalJsonStringify(item)}`;
      });
      return `{${parts.join(",")}}`;
    }
    default:
      throw new ConfigSerializationError(`unsupported value type in config: ${typeof value}`);
  }
}

/** 64-bit hex digest of the canonical config serialization. */
export function hashConfig(config: SimulationConfig): string {
  return new StateHash().string(canonicalJsonStringify(config)).digest();
}
