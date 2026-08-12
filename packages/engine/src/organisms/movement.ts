import { ANGLE_STEPS, POS_SCALE, Q, TRIG_SCALE, clamp, qmul } from "../math/fixed";
import { addAngle } from "../math/angle";
import { cosLut, sinLut } from "../math/trigLut";
import { isqrt } from "../math/isqrt";
import { statelessNoiseU32 } from "../random/statelessNoise";
import type { EngineContext } from "../EngineContext";
import { currentRadiusPos } from "./phenotype";

/**
 * Movement, terrain and soft collisions — phases 5 and 6 of the authoritative
 * tick order (docs/03 §§11-13, task D09).
 *
 * There is no frame delta anywhere: one call advances exactly one fixed tick.
 *
 * ## Velocity units
 *
 * Positions are integers in world sub-units (POS_SCALE per LU) and velocities
 * are integers in {@link VELOCITY_SCALE}ths of a sub-unit per tick. The finer
 * velocity unit is not decoration: the slowest genome moves 9 sub-units per
 * tick at full throttle, so a velocity quantized to whole sub-units would
 * round most of a slow organism's motion away and bias selection against low
 * speed genes. Each organism carries the leftover fraction of its step in
 * `posFracX/posFracY`, so no motion is lost to truncation.
 */

/** Velocity units per position sub-unit per tick. */
export const VELOCITY_SCALE = 256;
/** log2(VELOCITY_SCALE); the shift that turns a velocity into whole sub-units. */
const VELOCITY_SHIFT = 8;

/**
 * Phase 5 — integrate movement (docs/03 §11).
 *
 * 1. turn by the brain's turn intent, scaled by the organism's maximum turn;
 * 2. target velocity = heading × effective max speed × throttle;
 * 3. approach that target by at most the organism's acceleration;
 * 4. apply the terrain movement multiplier;
 * 5. integrate the position.
 *
 * Step 4 scales the DISPLACEMENT, not the stored velocity. Water then slows an
 * organism down without making swimming cheap: movement energy is billed from
 * the propulsive effort in `speedFraction`, multiplied by the water cost
 * factor (docs/04 §7). Reducing the stored velocity instead would have made
 * water a 4× multiplier on a 16× smaller number — a discount for drowning.
 */
export function integrateMovement(ctx: EngineContext): void {
  const { organisms, phenotypes, environment, scratch, config } = ctx;
  const waterSpeedMultiplierQ = config.organism.movement.waterSpeedMultiplierQ;

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }

    // 1. Turn. Positive turn output increases the heading (clockwise).
    const maxTurn = phenotypes.maxTurnSteps[slot] as number;
    const turnQ = scratch.turnQ[slot] as number;
    const angle = addAngle(organisms.angle[slot] as number, Math.trunc((turnQ * maxTurn) / Q));
    organisms.angle[slot] = angle;

    // 2. Target velocity.
    const maxSpeed = phenotypes.maxSpeedVel[slot] as number;
    const targetSpeed = qmul(maxSpeed, scratch.throttleQ[slot] as number);
    const targetVx = Math.trunc((cosLut(angle) * targetSpeed) / TRIG_SCALE);
    const targetVy = Math.trunc((sinLut(angle) * targetSpeed) / TRIG_SCALE);

    // 3. Approach it, bounded by acceleration.
    let vx = organisms.vx[slot] as number;
    let vy = organisms.vy[slot] as number;
    const dvx = targetVx - vx;
    const dvy = targetVy - vy;
    const deltaMagnitude = isqrt(dvx * dvx + dvy * dvy);
    const acceleration = phenotypes.accelerationVel[slot] as number;
    if (deltaMagnitude > acceleration) {
      vx += Math.trunc((dvx * acceleration) / deltaMagnitude);
      vy += Math.trunc((dvy * acceleration) / deltaMagnitude);
      scratch.accelFractionQ[slot] = Q;
    } else {
      vx = targetVx;
      vy = targetVy;
      scratch.accelFractionQ[slot] =
        acceleration > 0 ? Math.trunc((deltaMagnitude * Q) / acceleration) : 0;
    }
    organisms.vx[slot] = vx;
    organisms.vy[slot] = vy;

    const speed = isqrt(vx * vx + vy * vy);
    scratch.speedFractionQ[slot] =
      maxSpeed > 0 ? Math.min(Q, Math.trunc((speed * Q) / maxSpeed)) : 0;

    // 4. Terrain multiplier on the displacement.
    const cell = environment.cellIndexFromPosition(
      organisms.x[slot] as number,
      organisms.y[slot] as number,
    );
    const inWater = environment.isWaterCell(cell);
    const moveVx = inWater ? qmul(vx, waterSpeedMultiplierQ) : vx;
    const moveVy = inWater ? qmul(vy, waterSpeedMultiplierQ) : vy;

    // 5. Integrate, carrying the sub-sub-unit remainder. The shift floors and
    // the mask keeps the remainder non-negative, so backwards motion is exact
    // too: a step of -1 becomes -1 whole unit plus 255/256 carried forward.
    const stepX = moveVx + (organisms.posFracX[slot] as number);
    const stepY = moveVy + (organisms.posFracY[slot] as number);
    organisms.x[slot] = (organisms.x[slot] as number) + (stepX >> VELOCITY_SHIFT);
    organisms.y[slot] = (organisms.y[slot] as number) + (stepY >> VELOCITY_SHIFT);
    organisms.posFracX[slot] = stepX & (VELOCITY_SCALE - 1);
    organisms.posFracY[slot] = stepY & (VELOCITY_SCALE - 1);
  }
}

/**
 * Phase 6 — terrain constraint and soft collisions (docs/03 §§12-13).
 *
 * The world boundary is a wall: positions clamp to it and the outward velocity
 * component is dropped, so an organism pressed against the edge does not
 * accumulate velocity it can never spend. There is no toroidal wrap in MVP.
 *
 * Water is entered, not forbidden. A terrestrial organism that walks into
 * water keeps moving slowly and starts a grace counter; the health cost is
 * billed in the metabolism phase, and the terrain-danger sensors give
 * avoidance something to evolve against (docs/03 §12).
 *
 * Overlap is allowed and only nudged apart (docs/03 §13). Corrections are
 * accumulated for every pair first and applied afterwards, so the result does
 * not depend on the order pairs happen to be visited — integer addition is
 * exact and commutative, which an in-place resolve would not be.
 */
export function resolveTerrainAndSoftCollisions(ctx: EngineContext): void {
  const { organisms, phenotypes, environment, scratch, spatialPre, config, seed } = ctx;
  const maxPos = config.world.sizeLU * POS_SCALE - 1;
  const strengthQ = config.organism.movement.softSeparationStrengthQ;
  const grid = spatialPre;
  const highWater = organisms.slotHighWater;

  // World boundary first, so separation works on in-bounds positions.
  for (let slot = 0; slot < highWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    clampToWorld(organisms, slot, maxPos);
    scratch.moveCorrectionX[slot] = 0;
    scratch.moveCorrectionY[slot] = 0;
  }

  if (strengthQ > 0) {
    for (let slot = 0; slot < highWater; slot += 1) {
      if (organisms.alive[slot] !== 1) {
        continue;
      }
      const xPos = organisms.x[slot] as number;
      const yPos = organisms.y[slot] as number;
      const radius = currentRadiusPos(
        phenotypes.adultRadiusPos[slot] as number,
        organisms.developmentQ[slot] as number,
      );

      // Bodies are at most 4.5 LU in radius and one spatial cell is 32 LU, so
      // any overlapping partner is in the 3×3 neighbourhood. The grid still
      // holds pre-movement buckets; a tick's displacement is a fraction of an
      // LU, far inside that margin.
      const cx = grid.cellX(xPos);
      const cy = grid.cellY(yPos);
      const minCellX = cx > 0 ? cx - 1 : 0;
      const maxCellX = cx < grid.size - 1 ? cx + 1 : grid.size - 1;
      const minCellY = cy > 0 ? cy - 1 : 0;
      const maxCellY = cy < grid.size - 1 ? cy + 1 : grid.size - 1;

      for (let ny = minCellY; ny <= maxCellY; ny += 1) {
        const rowBase = ny * grid.size;
        for (let nx = minCellX; nx <= maxCellX; nx += 1) {
          for (
            let other = grid.head[rowBase + nx] as number;
            other !== -1;
            other = grid.next[other] as number
          ) {
            // Each pair is handled exactly once, by its lower slot.
            if (other <= slot || organisms.alive[other] !== 1) {
              continue;
            }
            const dx = (organisms.x[other] as number) - xPos;
            const dy = (organisms.y[other] as number) - yPos;
            const otherRadius = currentRadiusPos(
              phenotypes.adultRadiusPos[other] as number,
              organisms.developmentQ[other] as number,
            );
            const contact = radius + otherRadius;
            const distSq = dx * dx + dy * dy;
            if (distSq >= contact * contact) {
              continue;
            }

            let pushX: number;
            let pushY: number;
            if (distSq === 0) {
              // Exactly coincident: no direction exists, so derive one from the
              // entity IDs (docs/03 §13) rather than from iteration order.
              //
              // Both the hash inputs and the sign are ordered by entity ID, not
              // by slot. Slots are recycled, so hashing (lowerSlotId,
              // higherSlotId) would give the same two organisms a different
              // separation direction depending only on who died recently —
              // storage order leaking into authoritative state, which is what
              // the entity-ID tie-break rule exists to prevent (CLAUDE.md).
              const selfId = organisms.entityId[slot] as number;
              const otherId = organisms.entityId[other] as number;
              const selfIsLower = selfId < otherId;
              const noise = statelessNoiseU32(
                seed,
                selfIsLower ? selfId : otherId,
                selfIsLower ? otherId : selfId,
              );
              const angle = noise & (ANGLE_STEPS - 1);
              const amount = qmul(contact, strengthQ) >> 1;
              // `push` is applied as +push to `other` and -push to `slot`, so
              // the drawn angle always points at the HIGHER entity ID.
              const sign = selfIsLower ? 1 : -1;
              pushX = sign * Math.trunc((cosLut(angle) * amount) / TRIG_SCALE);
              pushY = sign * Math.trunc((sinLut(angle) * amount) / TRIG_SCALE);
            } else {
              const distance = isqrt(distSq);
              const amount = qmul(contact - distance, strengthQ) >> 1;
              pushX = Math.trunc((dx * amount) / distance);
              pushY = Math.trunc((dy * amount) / distance);
            }

            scratch.moveCorrectionX[slot] = (scratch.moveCorrectionX[slot] as number) - pushX;
            scratch.moveCorrectionY[slot] = (scratch.moveCorrectionY[slot] as number) - pushY;
            scratch.moveCorrectionX[other] = (scratch.moveCorrectionX[other] as number) + pushX;
            scratch.moveCorrectionY[other] = (scratch.moveCorrectionY[other] as number) + pushY;
          }
        }
      }
    }
  }

  for (let slot = 0; slot < highWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    organisms.x[slot] = (organisms.x[slot] as number) + (scratch.moveCorrectionX[slot] as number);
    organisms.y[slot] = (organisms.y[slot] as number) + (scratch.moveCorrectionY[slot] as number);
    clampToWorld(organisms, slot, maxPos);

    const cell = environment.cellIndexFromPosition(
      organisms.x[slot] as number,
      organisms.y[slot] as number,
    );
    if (environment.isWaterCell(cell)) {
      scratch.inWater[slot] = 1;
      // Saturate rather than wrap: the counter only has to say "past grace".
      const ticks = (organisms.waterTicks[slot] as number) + 1;
      organisms.waterTicks[slot] = ticks > 65535 ? 65535 : ticks;
    } else {
      scratch.inWater[slot] = 0;
      organisms.waterTicks[slot] = 0;
    }
  }
}

/** Clamp a position into the world and drop the velocity pushing outward. */
function clampToWorld(organisms: EngineContext["organisms"], slot: number, maxPos: number): void {
  const x = organisms.x[slot] as number;
  if (x < 0 || x > maxPos) {
    organisms.x[slot] = clamp(x, 0, maxPos);
    organisms.vx[slot] = 0;
    organisms.posFracX[slot] = 0;
  }
  const y = organisms.y[slot] as number;
  if (y < 0 || y > maxPos) {
    organisms.y[slot] = clamp(y, 0, maxPos);
    organisms.vy[slot] = 0;
    organisms.posFracY[slot] = 0;
  }
}
