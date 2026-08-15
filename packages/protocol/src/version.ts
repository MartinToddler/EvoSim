/**
 * Wire protocol version between the main thread and the simulation Worker.
 *
 * Bump when any message/command wire shape changes (docs/02 §18).
 *
 * ## History
 *
 * - **1** — Milestone 0/1. The generic `Envelope` shape only; no concrete
 *   message union existed, and nothing spoke this protocol over a real port.
 * - **2** — Milestone 6. The main→worker and worker→main unions, the packed
 *   binary render/terrain/vegetation layouts, and `requestId` correlation. This
 *   is the first version an actual Worker speaks.
 * - **3** — Milestone 7. Observation payload growth, no new message types:
 *   the terrain snapshot gains four static display planes (temperature,
 *   moisture, fertility, plant capacity — field layout 2), `TelemetryDto`
 *   gains alive-population trait means and organism biomass for the charts,
 *   `EntityDetailsDto` gains the cost breakdown and last-tick brain
 *   inputs/intents for the inspector, and `WorldSummaryDto` gains a
 *   non-authoritative `display` block (labels and legend ranges).
 * - **4** — Milestone 8. Species and history. New request/response pairs
 *   `QUERY_SPECIES` → `SPECIES_DETAILS`, `REQUEST_TREE` → `TREE_SNAPSHOT` and
 *   `REQUEST_HISTORY_RANGE` → `HISTORY_EVENTS`; `TelemetryDto` gains species
 *   counts and `latestEventId` (the pull signal — there is no event push
 *   stream); `WorldDisplayDto` gains event/severity/end-reason/trait label
 *   arrays.
 *
 * Protocol 5 (Milestone 9, player interventions): `QUEUE_COMMAND` →
 *   `COMMAND_RESULT` carries canonical player commands and their stamped
 *   identities; `TERRAIN_SNAPSHOT` re-ships the packed terrain fields after a
 *   command edits the world; `TelemetryDto` gains `pendingCommandCount`;
 *   `WorldDisplayDto` gains intervention labels and bounds; the canonical
 *   stroke resampler (`resampleStroke`) joins the package as part of the wire
 *   contract's meaning.
 *
 * Protocol 6 (Milestone 10) adds persistence: `REQUEST_SAVE` asks the Worker to
 * serialize its engine into a durable snapshot container, `SNAPSHOT_DATA`
 * transfers those bytes back for the main thread to store, and `LOAD_WORLD`
 * hands a stored container back to the Worker to resume from. No existing
 * message changed shape; the union simply grew.
 *
 * Protocol 7 (Milestone 11) adds rewind and branching: `REQUEST_REWIND` hands
 * the Worker a stored save and a target tick, `REWIND_PROGRESS` and
 * `HISTORICAL_MODE_READY` report the replay, `RETURN_TO_PRESENT` leaves the
 * preview, and `CREATE_BRANCH` asks for the bytes that become a new world's
 * origin — carried by the existing `SNAPSHOT_DATA` with the new `"branch"`
 * reason. Only that reason union widened; no existing message changed shape.
 *
 * Protocol 8 (Milestone 12) adds performance and memory observability, with no
 * new message types: `TelemetryDto` gains a `memory` block carrying the engine's
 * approximate per-category byte totals (docs/07 §11) and the render buffer
 * pool's allocated bytes. It is a diagnostic stream for the development
 * performance HUD; nothing authoritative reads it, and no existing message
 * changed shape.
 *
 * Protocol 9 (ADR 0025) adds `WorldSummaryDto.environmentHash`: the digest of
 * the generated environment arrays, computed once when a world is adopted. It
 * exists so the New World flow can prove the map the user previewed and
 * accepted is byte-for-byte the map the authoritative world runs — an identity
 * check, not a behaviour. No message type changed shape otherwise.
 *
 * Note what this number does *not* affect: the authoritative state hash. A
 * world's identity is seed + authoritative config + engine version + commands
 * (see `hashState.ts` in `@eon/engine`); how its pixels reach a canvas is not
 * part of it, and a protocol bump must never change a golden hash.
 */
export const PROTOCOL_VERSION = 9;
