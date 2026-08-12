import { POS_SCALE, TRIG_SCALE } from "../math/fixed";
import { cosLut, sinLut } from "../math/trigLut";
import type { EngineContext } from "../EngineContext";

/**
 * Spatial queries used by sensing (docs/10 §9, docs/04 §§12, 14).
 *
 * Written as explicit loops rather than visitor callbacks: a closure per
 * organism per tick is exactly the per-tick allocation CLAUDE.md forbids.
 *
 * Every query encodes its tie-breaks. "Nearest" alone is ambiguous when two
 * candidates are equidistant, and an ambiguous winner would let the spatial
 * insertion order leak into authoritative state.
 */

/**
 * Scale of the cached half-FOV cosine and of the forward basis used in the
 * visibility test.
 *
 * The test compares `(d·f)²` with `cos² · |d|²` so it needs no square root per
 * candidate. At full TRIG_SCALE precision that product would reach ~2.6e18 and
 * lose exactness above 2^53; at this scale the worst case is ~1.6e14. The cost
 * is an angular resolution of a fraction of a degree at the FOV boundary,
 * which no ecological outcome can depend on.
 */
export const FOV_COS_SCALE = 256;

/** Result of the last {@link findNearestVisibleCreature} call: -1 when none. */
export interface NearestCreature {
  slot: number;
  distSq: number;
}

/**
 * Nearest creature that the observer can actually see (docs/04 §12).
 *
 * Filters: not itself, alive, within the observer's genetic vision range, and
 * inside its field of view. There is no terrain occlusion in MVP, and no
 * species, diet or threat information is available here — the brain gets
 * geometry and phenotype cues only.
 *
 * Ties break on lower squared distance, then lower entity ID (docs/03 §10).
 *
 * The result is written into the caller's `out` object so the hot sensing loop
 * allocates nothing.
 */
export function findNearestVisibleCreature(
  ctx: EngineContext,
  observerSlot: number,
  out: NearestCreature,
): void {
  const { organisms, phenotypes, spatialPre } = ctx;
  const grid = spatialPre;
  // Hoisted into locals: this is the hottest loop in the engine (measured at
  // roughly half of a tick at 5000 organisms), and repeating the property
  // chains per candidate costs more than the arithmetic does.
  const posX = organisms.x;
  const posY = organisms.y;
  const alive = organisms.alive;
  const ids = organisms.entityId;
  const head = grid.head;
  const next = grid.next;
  const gridSize = grid.size;

  const ox = posX[observerSlot] as number;
  const oy = posY[observerSlot] as number;
  const range = phenotypes.visionRangePos[observerSlot] as number;
  const rangeSq = range * range;
  const cosHalfFov = phenotypes.visionCosHalfFov[observerSlot] as number;
  const cosSq = cosHalfFov * cosHalfFov;

  const angle = organisms.angle[observerSlot] as number;
  const fx = Math.trunc((cosLut(angle) * FOV_COS_SCALE) / TRIG_SCALE);
  const fy = Math.trunc((sinLut(angle) * FOV_COS_SCALE) / TRIG_SCALE);

  const minCellX = grid.cellX(ox - range);
  const maxCellX = grid.cellX(ox + range);
  const minCellY = grid.cellY(oy - range);
  const maxCellY = grid.cellY(oy + range);

  let bestSlot = -1;
  let bestDistSq = 0;
  let bestId = 0;

  for (let cy = minCellY; cy <= maxCellY; cy += 1) {
    const rowBase = cy * gridSize;
    for (let cx = minCellX; cx <= maxCellX; cx += 1) {
      for (let slot = head[rowBase + cx] as number; slot !== -1; slot = next[slot] as number) {
        if (slot === observerSlot || alive[slot] !== 1) {
          continue;
        }
        const dx = (posX[slot] as number) - ox;
        const dy = (posY[slot] as number) - oy;
        const distSq = dx * dx + dy * dy;
        // Reject anything out of range, and anything no closer than the best
        // candidate so far, before paying for the field-of-view test.
        if (distSq > rangeSq || (bestSlot !== -1 && distSq > bestDistSq)) {
          continue;
        }

        // Field of view: cos(angle between) >= cos(halfFov), compared squared.
        // The sign split is required because squaring loses the sign: with a
        // narrow FOV (cos >= 0) anything behind is out, and with a wide one
        // (cos < 0) anything ahead is in.
        const dot = dx * fx + dy * fy;
        if (cosHalfFov >= 0) {
          if (dot < 0 || dot * dot < cosSq * distSq) {
            continue;
          }
        } else if (dot < 0 && dot * dot > cosSq * distSq) {
          continue;
        }

        const id = ids[slot] as number;
        if (bestSlot === -1 || distSq < bestDistSq || (distSq === bestDistSq && id < bestId)) {
          bestSlot = slot;
          bestDistSq = distSq;
          bestId = id;
        }
      }
    }
  }

  out.slot = bestSlot;
  out.distSq = bestDistSq;
}

/**
 * Number of other living organisms within the crowding radius (docs/04 §14).
 *
 * A plain count with no friend/enemy interpretation: crowding is a density
 * cue, and what an organism does about density is for its network to evolve.
 *
 * The config validator caps the crowding radius at one spatial cell, so this
 * never scans more than the 3×3 neighbourhood.
 */
export function countCrowding(ctx: EngineContext, observerSlot: number): number {
  const { organisms, spatialPre, config } = ctx;
  const grid = spatialPre;

  const radius = config.senses.crowdingRadiusLU * POS_SCALE;
  if (radius <= 0) {
    return 0;
  }
  const radiusSq = radius * radius;
  const posX = organisms.x;
  const posY = organisms.y;
  const alive = organisms.alive;
  const head = grid.head;
  const next = grid.next;
  const gridSize = grid.size;

  const ox = posX[observerSlot] as number;
  const oy = posY[observerSlot] as number;

  const minCellX = grid.cellX(ox - radius);
  const maxCellX = grid.cellX(ox + radius);
  const minCellY = grid.cellY(oy - radius);
  const maxCellY = grid.cellY(oy + radius);

  let count = 0;
  for (let cy = minCellY; cy <= maxCellY; cy += 1) {
    const rowBase = cy * gridSize;
    for (let cx = minCellX; cx <= maxCellX; cx += 1) {
      for (let slot = head[rowBase + cx] as number; slot !== -1; slot = next[slot] as number) {
        if (slot === observerSlot || alive[slot] !== 1) {
          continue;
        }
        const dx = (posX[slot] as number) - ox;
        const dy = (posY[slot] as number) - oy;
        if (dx * dx + dy * dy <= radiusSq) {
          count += 1;
        }
      }
    }
  }
  return count;
}
