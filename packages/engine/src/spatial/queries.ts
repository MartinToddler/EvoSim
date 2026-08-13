import { POS_SCALE, TRIG_SCALE } from "../math/fixed";
import { cosLut, sinLut } from "../math/trigLut";
import type { EngineContext } from "../EngineContext";
import { currentRadiusPos } from "../organisms/phenotype";
import { FOV_COS_SCALE } from "./fov";

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

/** Result of the last {@link findNearestVisibleCreature} call: -1 when none. */
export interface NearestCreature {
  slot: number;
  distSq: number;
}

/** Result of a carcass or contact-target search: -1 when none. */
export interface NearestTarget {
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
 * Nearest carcass the observer can see (docs/04 §13, task F02).
 *
 * Carrion is found with the same eyes as anything else: the observer's genetic
 * vision range and field of view, and the same tie-breaks — lower squared
 * distance, then lower entity ID. The ID here is the *dead* organism's, which is
 * never reused, so the tie-break is stable even though carcass slots are.
 *
 * There is no separate smell sense in MVP. Adding one would be a new sensor and
 * therefore a brain format change (docs/04 §10).
 */
export function findNearestVisibleCarcass(
  ctx: EngineContext,
  observerSlot: number,
  out: NearestTarget,
): void {
  const { organisms, phenotypes, carcasses, carcassIndex } = ctx;
  out.slot = -1;
  out.distSq = 0;
  // The overwhelmingly common case in a young world, and a cheap way to keep the
  // sensing phase free of carrion work until something has actually died.
  if (carcasses.liveCount === 0) {
    return;
  }

  const grid = carcassIndex;
  const posX = carcasses.x;
  const posY = carcasses.y;
  const active = carcasses.active;
  const ids = carcasses.entityId;
  const head = grid.head;
  const next = grid.next;
  const gridSize = grid.size;

  const ox = organisms.x[observerSlot] as number;
  const oy = organisms.y[observerSlot] as number;
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
        if (active[slot] !== 1) {
          continue;
        }
        const dx = (posX[slot] as number) - ox;
        const dy = (posY[slot] as number) - oy;
        const distSq = dx * dx + dy * dy;
        if (distSq > rangeSq || (bestSlot !== -1 && distSq > bestDistSq)) {
          continue;
        }

        // Same squared field-of-view test as the creature query, including the
        // sign split that a squared comparison makes necessary.
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
 * Nearest carcass whose position lies inside the eater's own body, i.e. in
 * mouth range (docs/04 §20, task F02).
 *
 * A carcass is a point (docs/03 §23 gives it no radius), so "in mouth range"
 * means the eater is standing on it: `distance <= currentRadius`. That needs no
 * new constant, which is the point — a configured reach would be a magic number
 * with no observable meaning, while a body radius is already the length scale
 * every other contact rule in the engine uses.
 *
 * Reads the POST-movement index, because feeding resolves after movement.
 */
export function findCarcassInMouthRange(
  ctx: EngineContext,
  eaterSlot: number,
  radiusPos: number,
  out: NearestTarget,
): void {
  const { organisms, carcasses, carcassIndex } = ctx;
  out.slot = -1;
  out.distSq = 0;
  if (carcasses.liveCount === 0 || radiusPos <= 0) {
    return;
  }

  const grid = carcassIndex;
  const posX = carcasses.x;
  const posY = carcasses.y;
  const active = carcasses.active;
  const meat = carcasses.remainingMeat;
  const ids = carcasses.entityId;
  const head = grid.head;
  const next = grid.next;
  const gridSize = grid.size;

  const ox = organisms.x[eaterSlot] as number;
  const oy = organisms.y[eaterSlot] as number;
  const reachSq = radiusPos * radiusPos;

  const minCellX = grid.cellX(ox - radiusPos);
  const maxCellX = grid.cellX(ox + radiusPos);
  const minCellY = grid.cellY(oy - radiusPos);
  const maxCellY = grid.cellY(oy + radiusPos);

  let bestSlot = -1;
  let bestDistSq = 0;
  let bestId = 0;

  for (let cy = minCellY; cy <= maxCellY; cy += 1) {
    const rowBase = cy * gridSize;
    for (let cx = minCellX; cx <= maxCellX; cx += 1) {
      for (let slot = head[rowBase + cx] as number; slot !== -1; slot = next[slot] as number) {
        // A carcass with no meat left is not food. It is released later in the
        // same phase; skipping it here keeps a zero-meat claim out of the
        // aggregation instead of relying on the release having happened first.
        if (active[slot] !== 1 || (meat[slot] as number) <= 0) {
          continue;
        }
        const dx = (posX[slot] as number) - ox;
        const dy = (posY[slot] as number) - oy;
        const distSq = dx * dx + dy * dy;
        if (distSq > reachSq) {
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
 * Nearest living organism whose body touches the attacker's (docs/04 §21,
 * task F04).
 *
 * Contact is `distance <= attackerRadius + targetRadius` — two discs touching.
 * No field-of-view filter: docs/04 §21 lists exactly four attack requirements
 * (output over threshold, target in contact range, cooldown zero, energy
 * available) and a facing requirement is not among them. Biting whatever is
 * pressed against you needs no eyes, and aiming is already expressed by having
 * moved into contact.
 *
 * The candidate search radius uses the largest body the gene range allows,
 * because the target's own radius is only known once it has been found. Reads
 * the POST-movement index: combat resolves against where bodies actually ended
 * up this tick.
 *
 * Ties: lower squared distance, then lower entity ID (docs/03 §10).
 */
export function findContactTarget(
  ctx: EngineContext,
  attackerSlot: number,
  attackerRadiusPos: number,
  out: NearestTarget,
): void {
  const { organisms, phenotypes, spatialPost, config } = ctx;
  out.slot = -1;
  out.distSq = 0;

  const grid = spatialPost;
  const posX = organisms.x;
  const posY = organisms.y;
  const alive = organisms.alive;
  const ids = organisms.entityId;
  const adultRadius = phenotypes.adultRadiusPos;
  const development = organisms.developmentQ;
  const head = grid.head;
  const next = grid.next;
  const gridSize = grid.size;

  const ox = posX[attackerSlot] as number;
  const oy = posY[attackerSlot] as number;
  const searchRadius = attackerRadiusPos + config.organism.geneRanges.adultRadiusMaxPos;

  const minCellX = grid.cellX(ox - searchRadius);
  const maxCellX = grid.cellX(ox + searchRadius);
  const minCellY = grid.cellY(oy - searchRadius);
  const maxCellY = grid.cellY(oy + searchRadius);

  let bestSlot = -1;
  let bestDistSq = 0;
  let bestId = 0;

  for (let cy = minCellY; cy <= maxCellY; cy += 1) {
    const rowBase = cy * gridSize;
    for (let cx = minCellX; cx <= maxCellX; cx += 1) {
      for (let slot = head[rowBase + cx] as number; slot !== -1; slot = next[slot] as number) {
        if (slot === attackerSlot || alive[slot] !== 1) {
          continue;
        }
        const dx = (posX[slot] as number) - ox;
        const dy = (posY[slot] as number) - oy;
        const distSq = dx * dx + dy * dy;
        if (bestSlot !== -1 && distSq > bestDistSq) {
          continue;
        }
        const contact =
          attackerRadiusPos +
          currentRadiusPos(adultRadius[slot] as number, development[slot] as number);
        if (distSq > contact * contact) {
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
