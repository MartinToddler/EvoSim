import type { RenderSnapshotView } from "@eon/protocol";

/**
 * Hit-testing for organism selection (task G09, docs/06 §6).
 *
 * ## Why this is not Pixi interaction
 *
 * docs/06 §6 is explicit: do not attach thousands of Pixi event handlers. With
 * 8192 organisms that would mean 8192 interactive display objects, a hit tree
 * rebuilt whenever anything moves, and per-pointer-event traversal — for a
 * feature that fires when a human clicks, a few times a minute. Instead the
 * click is transformed into world space once and tested against the last render
 * snapshot with a linear scan. 8192 distance comparisons is microseconds.
 *
 * ## Deterministic tie-breaking
 *
 * Two organisms can occupy the same point. Picking "whichever the loop saw
 * first" would make selection depend on storage order, which changes as slots
 * are reused. So ties in distance are broken by the lowest entity ID — the
 * project's standard tie-break (CLAUDE.md), and stable for as long as the
 * organism lives.
 *
 * Selection is a pure read of a projection. Nothing here can reach the engine.
 */

export interface PickResult {
  entityId: number;
  /** Index into the snapshot columns, for immediate visual feedback. */
  index: number;
  distanceLU: number;
}

/**
 * Nearest organism to a world point, or `null`.
 *
 * A hit requires the point to fall within the organism's body radius grown by
 * `toleranceLU` — a fixed *screen* tolerance converted to world units by the
 * caller, so small organisms stay clickable when zoomed out without becoming
 * absurdly easy to hit when zoomed in.
 */
export function pickOrganism(
  view: RenderSnapshotView,
  organismCount: number,
  worldXLU: number,
  worldYLU: number,
  toleranceLU: number,
): PickResult | null {
  let bestIndex = -1;
  let bestEntityId = 0;
  let bestDistanceSq = Number.POSITIVE_INFINITY;

  const count = Math.min(organismCount, view.organismId.length);
  for (let i = 0; i < count; i += 1) {
    const dx = (view.organismX[i] as number) - worldXLU;
    const dy = (view.organismY[i] as number) - worldYLU;
    const distanceSq = dx * dx + dy * dy;

    const reach = (view.organismRadiusLU[i] as number) + toleranceLU;
    if (distanceSq > reach * reach) {
      continue;
    }
    const entityId = view.organismId[i] as number;
    if (distanceSq < bestDistanceSq || (distanceSq === bestDistanceSq && entityId < bestEntityId)) {
      bestDistanceSq = distanceSq;
      bestIndex = i;
      bestEntityId = entityId;
    }
  }

  if (bestIndex < 0) {
    return null;
  }
  return { entityId: bestEntityId, index: bestIndex, distanceLU: Math.sqrt(bestDistanceSq) };
}

/**
 * Index of `entityId` in the snapshot, or -1 when it is not in this frame.
 *
 * The selected organism can vanish between frames — it died, or it was culled
 * by a truncated snapshot. Callers use -1 to mean "keep the selection but stop
 * drawing a ring on a stale position", never to mean "clear the selection":
 * whether a dead selection is dropped is a UI decision, made once the Worker
 * confirms the death.
 */
export function findOrganismIndex(
  view: RenderSnapshotView,
  organismCount: number,
  entityId: number,
): number {
  const count = Math.min(organismCount, view.organismId.length);
  for (let i = 0; i < count; i += 1) {
    if (view.organismId[i] === entityId) {
      return i;
    }
  }
  return -1;
}
