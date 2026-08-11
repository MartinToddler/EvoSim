/**
 * Engine-side version constants (CLAUDE.md "Required version constants",
 * docs/02 §18). PROTOCOL_VERSION lives in @eon/protocol.
 *
 * Policy:
 * - any intentional authoritative behavior change  => bump ENGINE_VERSION,
 *   update golden hashes and add a changelog entry;
 * - snapshot layout change                         => bump SNAPSHOT_SCHEMA_VERSION;
 * - SimulationConfig shape change                  => bump CONFIG_SCHEMA_VERSION.
 */
export const ENGINE_VERSION = "0.1.0";
export const SNAPSHOT_SCHEMA_VERSION = 1;
export const CONFIG_SCHEMA_VERSION = 1;
