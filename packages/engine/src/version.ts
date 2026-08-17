/**
 * Engine-side version constants (CLAUDE.md "Required version constants",
 * docs/02 §18). PROTOCOL_VERSION lives in @eon/protocol.
 *
 * Policy:
 * - any intentional authoritative behavior change  => bump ENGINE_VERSION,
 *   update golden hashes and add a changelog entry;
 * - snapshot payload change                        => bump SNAPSHOT_SCHEMA_VERSION.
 *   "Payload" includes everything a stored snapshot carries, not just the field
 *   list: a snapshot embeds a SimulationConfig, so a config shape change makes
 *   older payloads unreadable and bumps this too;
 * - SimulationConfig shape change                  => bump CONFIG_SCHEMA_VERSION.
 *
 * Host/runtime settings are versioned separately by
 * HOST_RUNTIME_CONFIG_SCHEMA_VERSION in @eon/protocol. That is deliberate: it
 * lets render cadence, worker slice budget and autosave cadence evolve without
 * touching any of the constants here, and therefore without changing a single
 * world hash (ADR 0002 §4). CLAUDE.md lists four required version constants;
 * this is a fifth, non-authoritative one.
 */
export const ENGINE_VERSION = "0.10.0";
export const SNAPSHOT_SCHEMA_VERSION = 10;
export const CONFIG_SCHEMA_VERSION = 9;
