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
 *
 * Note what this number does *not* affect: the authoritative state hash. A
 * world's identity is seed + authoritative config + engine version + commands
 * (see `hashState.ts` in `@eon/engine`); how its pixels reach a canvas is not
 * part of it, and a protocol bump must never change a golden hash.
 */
export const PROTOCOL_VERSION = 3;
