import { HOST_RUNTIME_CONFIG_SCHEMA_VERSION, type HostRuntimeConfig } from "./hostRuntimeConfig";

/** Error thrown when a HostRuntimeConfig violates structural invariants. */
export class HostRuntimeConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostRuntimeConfigValidationError";
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new HostRuntimeConfigValidationError(message);
  }
}

function checkPositiveInt(value: number, name: string): void {
  check(
    Number.isSafeInteger(value) && value > 0,
    `${name} must be a positive integer, got ${value}`,
  );
}

/**
 * Validate a host runtime configuration.
 *
 * These values never influence authoritative simulation state — a bad value
 * makes the app janky, not the world different — but a zero or negative
 * cadence would divide by zero or spin the worker, so it is still checked at
 * the boundary.
 */
export function validateHostRuntimeConfig(config: HostRuntimeConfig): void {
  check(
    config.schemaVersion === HOST_RUNTIME_CONFIG_SCHEMA_VERSION,
    `host runtime config schemaVersion ${config.schemaVersion} does not match supported version ` +
      `${HOST_RUNTIME_CONFIG_SCHEMA_VERSION}`,
  );
  checkPositiveInt(config.targetTicksPerSecond1x, "targetTicksPerSecond1x");
  checkPositiveInt(config.normalRenderSnapshotsPerSecond, "normalRenderSnapshotsPerSecond");
  checkPositiveInt(config.maxModeRenderSnapshotsPerSecond, "maxModeRenderSnapshotsPerSecond");
  checkPositiveInt(config.maxWorkerSliceMs, "maxWorkerSliceMs");
  checkPositiveInt(config.autosaveCheckInterval, "autosaveCheckInterval");
  checkPositiveInt(config.ticksPerSimYear, "ticksPerSimYear");
  checkPositiveInt(config.maxDetailedRenderedOrganisms, "maxDetailedRenderedOrganisms");
  check(
    config.maxModeRenderSnapshotsPerSecond <= config.normalRenderSnapshotsPerSecond,
    "MAX mode must not emit render snapshots more often than normal mode (docs/02 §8)",
  );
}
