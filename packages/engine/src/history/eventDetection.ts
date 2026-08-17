import { assert } from "@eon/shared";
import type { EngineContext } from "../EngineContext";
import { SpeciesEndReason } from "../evolution/SpeciesStore";
import { TraitDim, writeTraitVector } from "../evolution/traitVector";
import { Q } from "../math/fixed";
import { HASH_TAG, type StateHash } from "../math/hash";
import { DeathCause } from "../organisms/death";
import { bodyMass, currentRadiusPos, maxEnergyForOrganism } from "../organisms/phenotype";
import { EventSeverity, WorldEventType } from "./EventStore";
import {
  SPECIES_STAT_METRIC_COUNT,
  SpeciesStatMetric,
  WORLD_STAT_METRIC_COUNT,
  WorldStatMetric,
} from "./StatisticsStore";

/**
 * Statistics sampling and deterministic event detection — phase 17 of the
 * authoritative tick order (docs/05 §§10, 13–17, docs/03 §7, task I06).
 *
 * Runs every `time.statisticsInterval` ticks. One pass assembles the world
 * sample, one pass per active species assembles the species samples, and the
 * detectors below turn those samples into timeline events. FirstPredation is
 * the one event not detected here: it must capture the attacker and victim at
 * the moment of the kill, so combat resolution reports it (docs/05 §14).
 *
 * ## Spam control (docs/05 §§13, 16)
 *
 * Every detector either fires at most once ever (FirstPredation), once per
 * species (CarnivoreLineageDetected), once per structural change
 * (SpeciesSplit/SpeciesExtinct — emitted where the change happens), once per
 * pressure episode (PopulationCapReached), or behind an explicit debounce
 * (boom/crash share a cooldown; mass extinction re-arms only after a full
 * fresh window). There is no detector that can emit the same finding twice.
 */

/**
 * Boom/crash rolling baseline width, in statistics samples (docs/05 §16
 * "rolling baseline"). 10 samples = 1000 ticks at the default cadence.
 */
export const POPULATION_BASELINE_WINDOW_SAMPLES = 10;

/**
 * Minimum absolute population change for a boom or crash (docs/05 §16
 * "minimum absolute change"). Keeps tiny worlds from booming from 4 to 7.
 */
export const POPULATION_EVENT_MIN_ABS_DELTA = 32;

/**
 * Mass extinction lookback window, in statistics samples (docs/05 §17
 * "inside configured interval"). 20 samples = 2000 ticks = one simulated year
 * at the default cadences.
 */
export const MASS_EXTINCTION_WINDOW_SAMPLES = 20;

/**
 * Species IDs attached to a MassExtinction event are capped; the payload
 * carries the true count. Keeps a catastrophic event from carrying an
 * unbounded ID list through hash, snapshot and protocol.
 */
export const MASS_EXTINCTION_MAX_LISTED_SPECIES = 32;

/**
 * Consecutive qualifying statistics samples before a lineage is declared
 * carnivorous (docs/05 §15 "persists several statistics intervals").
 */
export const CARNIVORE_PERSIST_SAMPLES = 5;

/**
 * Minimum energy a species must have consumed within one statistics interval
 * for its meat fraction to count as observed at all (docs/05 §15 "adequate
 * food observations"). Below this the sample neither advances nor resets the
 * streak — starvation is not evidence of diet.
 */
export const CARNIVORE_MIN_INTERVAL_ENERGY = 2000;

/**
 * Mutable detector state — the part of event detection that influences FUTURE
 * events and is therefore authoritative: hashed, serialized, and restored
 * exactly (docs/02 §9 "statistics accumulators used by event logic").
 */
export class EventDetectors {
  /** Statistics samples taken so far; the next sample's index. */
  sampleCount = 0;

  // --- World interval deltas (previous cumulative values) -------------------
  prevTotalBirths = 0;
  prevTotalDeaths = 0;
  prevCombatDeaths = 0;
  prevPlantEnergyConsumed = 0;
  prevMeatEnergyConsumed = 0;

  // --- Boom/crash (docs/05 §16) ----------------------------------------------
  /** Ring of the last N population samples; index = sampleIndex % N. */
  readonly populationRing = new Float64Array(POPULATION_BASELINE_WINDOW_SAMPLES);
  /** Sample index of the last boom OR crash; they share the debounce. */
  lastBoomCrashSample = -1;

  // --- Mass extinction (docs/05 §17) ------------------------------------------
  /** Rings over the lookback window (+1 so the window start stays resident). */
  readonly activeSpeciesRing = new Float64Array(MASS_EXTINCTION_WINDOW_SAMPLES + 1);
  readonly extinctSpeciesRing = new Float64Array(MASS_EXTINCTION_WINDOW_SAMPLES + 1);
  /** Sample index of the last mass extinction; windows may not overlap it. */
  lastMassExtinctionSample = -1;

  // --- Population cap episodes (docs/03 §2, task E06) -------------------------
  /** Cap rejections seen at the previous sample. */
  lastCapRejectedBirths = 0;
  /** True while an episode of cap pressure is ongoing (suppresses re-emission). */
  capEventActive = false;

  // --- First predation (docs/05 §14) ------------------------------------------
  /** Latched forever once the world's first combat kill was recorded. */
  firstPredationRecorded = false;

  /** Feed detector state into the canonical state hash. */
  hashInto(hasher: StateHash): void {
    hasher.safeInteger(this.sampleCount);
    hasher.safeInteger(this.prevTotalBirths);
    hasher.safeInteger(this.prevTotalDeaths);
    hasher.safeInteger(this.prevCombatDeaths);
    hasher.safeInteger(this.prevPlantEnergyConsumed);
    hasher.safeInteger(this.prevMeatEnergyConsumed);
    hasher.array(
      HASH_TAG.u32,
      Array.from(this.populationRing, (v) => v >>> 0),
    );
    hasher.word(this.lastBoomCrashSample);
    hasher.array(
      HASH_TAG.u32,
      Array.from(this.activeSpeciesRing, (v) => v >>> 0),
    );
    hasher.array(
      HASH_TAG.u32,
      Array.from(this.extinctSpeciesRing, (v) => v >>> 0),
    );
    hasher.word(this.lastMassExtinctionSample);
    hasher.safeInteger(this.lastCapRejectedBirths);
    hasher.word(this.capEventActive ? 1 : 0);
    hasher.word(this.firstPredationRecorded ? 1 : 0);
  }

  /** Capture for a snapshot. */
  capture(): EventDetectorsSnapshot {
    return {
      sampleCount: this.sampleCount,
      prevTotalBirths: this.prevTotalBirths,
      prevTotalDeaths: this.prevTotalDeaths,
      prevCombatDeaths: this.prevCombatDeaths,
      prevPlantEnergyConsumed: this.prevPlantEnergyConsumed,
      prevMeatEnergyConsumed: this.prevMeatEnergyConsumed,
      populationRing: new Float64Array(this.populationRing),
      lastBoomCrashSample: this.lastBoomCrashSample,
      activeSpeciesRing: new Float64Array(this.activeSpeciesRing),
      extinctSpeciesRing: new Float64Array(this.extinctSpeciesRing),
      lastMassExtinctionSample: this.lastMassExtinctionSample,
      lastCapRejectedBirths: this.lastCapRejectedBirths,
      capEventActive: this.capEventActive ? 1 : 0,
      firstPredationRecorded: this.firstPredationRecorded ? 1 : 0,
    };
  }

  /** Restore from a snapshot, validating shape. */
  restore(snapshot: EventDetectorsSnapshot): void {
    if (
      snapshot.populationRing.length !== POPULATION_BASELINE_WINDOW_SAMPLES ||
      snapshot.activeSpeciesRing.length !== MASS_EXTINCTION_WINDOW_SAMPLES + 1 ||
      snapshot.extinctSpeciesRing.length !== MASS_EXTINCTION_WINDOW_SAMPLES + 1
    ) {
      throw new EventDetectorsSnapshotError("detector ring lengths do not match this engine");
    }
    if (!Number.isSafeInteger(snapshot.sampleCount) || snapshot.sampleCount < 0) {
      throw new EventDetectorsSnapshotError(
        `restored sampleCount out of range: ${snapshot.sampleCount}`,
      );
    }
    this.sampleCount = snapshot.sampleCount;
    this.prevTotalBirths = snapshot.prevTotalBirths;
    this.prevTotalDeaths = snapshot.prevTotalDeaths;
    this.prevCombatDeaths = snapshot.prevCombatDeaths;
    this.prevPlantEnergyConsumed = snapshot.prevPlantEnergyConsumed;
    this.prevMeatEnergyConsumed = snapshot.prevMeatEnergyConsumed;
    this.populationRing.set(snapshot.populationRing);
    this.lastBoomCrashSample = snapshot.lastBoomCrashSample;
    this.activeSpeciesRing.set(snapshot.activeSpeciesRing);
    this.extinctSpeciesRing.set(snapshot.extinctSpeciesRing);
    this.lastMassExtinctionSample = snapshot.lastMassExtinctionSample;
    this.lastCapRejectedBirths = snapshot.lastCapRejectedBirths;
    this.capEventActive = snapshot.capEventActive === 1;
    this.firstPredationRecorded = snapshot.firstPredationRecorded === 1;
  }
}

/** Serializable detector state. */
export interface EventDetectorsSnapshot {
  sampleCount: number;
  prevTotalBirths: number;
  prevTotalDeaths: number;
  prevCombatDeaths: number;
  prevPlantEnergyConsumed: number;
  prevMeatEnergyConsumed: number;
  populationRing: Float64Array;
  lastBoomCrashSample: number;
  activeSpeciesRing: Float64Array;
  extinctSpeciesRing: Float64Array;
  lastMassExtinctionSample: number;
  lastCapRejectedBirths: number;
  capEventActive: number;
  firstPredationRecorded: number;
}

/** Error thrown when detector state cannot be restored. */
export class EventDetectorsSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventDetectorsSnapshotError";
  }
}

/**
 * Report a combat-attributed death the moment it happens (docs/05 §14).
 *
 * Called by combat resolution for every kill, BEFORE death finalization
 * releases either row, so both bodies are still readable whatever the slot
 * order — a mutual kill included. Only the world's first kill emits.
 */
export function reportCombatKill(
  ctx: EngineContext,
  tick: number,
  victimSlot: number,
  attackerSlot: number,
  attackerEntityId: number,
): void {
  const { detectors, events, organisms } = ctx;
  if (detectors.firstPredationRecorded) {
    return;
  }
  detectors.firstPredationRecorded = true;
  events.append({
    tick,
    type: WorldEventType.FirstPredation,
    severity: EventSeverity.Major,
    speciesIds: [
      organisms.speciesId[attackerSlot] as number,
      organisms.speciesId[victimSlot] as number,
    ],
    entityIds: [attackerEntityId, organisms.entityId[victimSlot] as number],
    regionXPos: organisms.x[victimSlot] as number,
    regionYPos: organisms.y[victimSlot] as number,
    regionRadiusPos: 0,
    payloadVersion: 1,
    payload: [],
  });
}

/**
 * Phase 17 — collect statistics and detect events.
 *
 * All arithmetic is integer (sums of integers, truncated means); nothing here
 * draws from the PRNG. The sample index is `detectors.sampleCount` BEFORE
 * increment, so sample 0 is the tick-0 founder world.
 */
export function collectStatisticsAndDetectEvents(ctx: EngineContext, tick: number): void {
  const {
    organisms,
    phenotypes,
    physical,
    environment,
    carcasses,
    species,
    stats,
    detectors,
    events,
    config,
    scratch,
    traitRanges,
  } = ctx;

  const sampleIndex = detectors.sampleCount;
  const speciesCount = species.count;
  scratch.ensureSpeciesAccumulators(speciesCount);

  // --- One pass over live organisms: world means + per-species sums ---------
  let energyRatioSumQ = 0;
  let dietSumQ = 0;
  const massScale = config.organism.massScalePerRadiusSquared;
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    const radius = currentRadiusPos(
      phenotypes.adultRadiusPos[slot] as number,
      organisms.developmentQ[slot] as number,
    );
    const maxEnergy = maxEnergyForOrganism(
      physical,
      slot,
      bodyMass(physical, slot, radius, massScale),
      config,
    );
    if (maxEnergy > 0) {
      const ratioQ = Math.trunc(((organisms.energy[slot] as number) * Q) / maxEnergy);
      energyRatioSumQ += ratioQ < Q ? ratioQ : Q;
    }
    const dietQ = phenotypes.dietQ[slot] as number;
    dietSumQ += dietQ;

    const speciesIndex = (organisms.speciesId[slot] as number) - 1;
    // The trait vector normalizations double as the species chart scales.
    writeTraitVector(scratch.speciesMemberTraits, 0, phenotypes, slot, traitRanges);
    scratch.speciesPopulation[speciesIndex] =
      (scratch.speciesPopulation[speciesIndex] as number) + 1;
    scratch.speciesSizeSum[speciesIndex] =
      (scratch.speciesSizeSum[speciesIndex] as number) +
      (scratch.speciesMemberTraits[TraitDim.AdultSize] as number);
    scratch.speciesSpeedSum[speciesIndex] =
      (scratch.speciesSpeedSum[speciesIndex] as number) +
      (scratch.speciesMemberTraits[TraitDim.EffectiveMaxSpeed] as number);
    scratch.speciesDietSum[speciesIndex] = (scratch.speciesDietSum[speciesIndex] as number) + dietQ;
  }
  const population = organisms.liveCount;

  // --- World totals -----------------------------------------------------------
  let plantBiomass = 0;
  for (let cell = 0; cell < environment.cellCount; cell += 1) {
    plantBiomass += environment.plantBiomass[cell] as number;
  }
  const carcassMeat =
    carcasses.totalMeatCreated - carcasses.totalMeatEaten - carcasses.totalMeatDecayed;

  let totalPlantConsumed = 0;
  let totalMeatConsumed = 0;
  let extinctCount = 0;
  for (const record of species.records) {
    totalPlantConsumed += record.plantEnergyConsumed;
    totalMeatConsumed += record.meatEnergyConsumed;
    if (record.endReason === SpeciesEndReason.Extinct) {
      extinctCount += 1;
    }
  }

  const combatDeaths = organisms.deathsByCause[DeathCause.Combat] as number;
  const worldSample = new Array<number>(WORLD_STAT_METRIC_COUNT).fill(0);
  worldSample[WorldStatMetric.Population] = population;
  worldSample[WorldStatMetric.ActiveSpecies] = species.activeCount;
  worldSample[WorldStatMetric.ExtinctSpecies] = extinctCount;
  worldSample[WorldStatMetric.PlantBiomass] = plantBiomass;
  worldSample[WorldStatMetric.CarcassMeat] = carcassMeat;
  worldSample[WorldStatMetric.BirthsInterval] = organisms.totalBirths - detectors.prevTotalBirths;
  worldSample[WorldStatMetric.DeathsInterval] = organisms.totalDeaths - detectors.prevTotalDeaths;
  worldSample[WorldStatMetric.CombatDeathsInterval] = combatDeaths - detectors.prevCombatDeaths;
  worldSample[WorldStatMetric.MeanEnergyRatioQ] =
    population === 0 ? 0 : Math.trunc(energyRatioSumQ / population);
  worldSample[WorldStatMetric.MeanDietQ] = population === 0 ? 0 : Math.trunc(dietSumQ / population);
  worldSample[WorldStatMetric.PlantEnergyInterval] =
    totalPlantConsumed - detectors.prevPlantEnergyConsumed;
  worldSample[WorldStatMetric.MeatEnergyInterval] =
    totalMeatConsumed - detectors.prevMeatEnergyConsumed;
  stats.pushWorldSample(tick, worldSample);

  detectors.prevTotalBirths = organisms.totalBirths;
  detectors.prevTotalDeaths = organisms.totalDeaths;
  detectors.prevCombatDeaths = combatDeaths;
  detectors.prevPlantEnergyConsumed = totalPlantConsumed;
  detectors.prevMeatEnergyConsumed = totalMeatConsumed;

  // --- Per-species samples and the carnivore-lineage detector -----------------
  const speciesSample = new Array<number>(SPECIES_STAT_METRIC_COUNT).fill(0);
  for (let index = 0; index < speciesCount; index += 1) {
    const record = species.records[index] as (typeof species.records)[number];
    if (record.endReason !== SpeciesEndReason.Active) {
      continue;
    }
    const members = scratch.speciesPopulation[index] as number;
    assert(
      members === record.population,
      `species ${record.id} population ${record.population} does not match ${members} sampled members`,
    );
    speciesSample[SpeciesStatMetric.Population] = members;
    speciesSample[SpeciesStatMetric.MeanSizeQ] =
      members === 0 ? 0 : Math.trunc((scratch.speciesSizeSum[index] as number) / members);
    speciesSample[SpeciesStatMetric.MeanSpeedQ] =
      members === 0 ? 0 : Math.trunc((scratch.speciesSpeedSum[index] as number) / members);
    speciesSample[SpeciesStatMetric.MeanDietQ] =
      members === 0 ? 0 : Math.trunc((scratch.speciesDietSum[index] as number) / members);
    stats.pushSpeciesSample(record.id, tick, speciesSample);

    // Carnivore lineage (docs/05 §15): observed intake, never the diet gene.
    const deltaPlant = record.plantEnergyConsumed - record.prevPlantConsumedSample;
    const deltaMeat = record.meatEnergyConsumed - record.prevMeatConsumedSample;
    record.prevPlantConsumedSample = record.plantEnergyConsumed;
    record.prevMeatConsumedSample = record.meatEnergyConsumed;
    const intake = deltaPlant + deltaMeat;
    if (intake < CARNIVORE_MIN_INTERVAL_ENERGY) {
      // Not enough observation to judge either way; the streak neither grows
      // nor resets (docs/05 §15 "adequate food observations").
      continue;
    }
    const qualifies =
      record.population >= config.history.carnivoreMinPopulation &&
      deltaMeat * Q >= intake * config.history.carnivoreObservedMeatFractionQ;
    if (!qualifies) {
      record.carnivoreStreak = 0;
      continue;
    }
    record.carnivoreStreak += 1;
    if (record.carnivoreStreak >= CARNIVORE_PERSIST_SAMPLES && !record.carnivoreDetected) {
      // World-first carnivory is a bigger moment than the tenth lineage.
      let worldFirst = true;
      for (const other of species.records) {
        if (other.carnivoreDetected) {
          worldFirst = false;
          break;
        }
      }
      record.carnivoreDetected = true;
      const meatFractionQ = Math.trunc((deltaMeat * Q) / intake);
      events.append({
        tick,
        type: WorldEventType.CarnivoreLineageDetected,
        severity: worldFirst ? EventSeverity.Major : EventSeverity.Notable,
        speciesIds: [record.id],
        payloadVersion: 1,
        payload: [meatFractionQ, record.population, worldFirst ? 1 : 0],
      });
    }
  }

  // --- Boom / crash (docs/05 §16) ----------------------------------------------
  if (sampleIndex >= POPULATION_BASELINE_WINDOW_SAMPLES) {
    let baselineSum = 0;
    for (let i = 0; i < POPULATION_BASELINE_WINDOW_SAMPLES; i += 1) {
      baselineSum += detectors.populationRing[i] as number;
    }
    const baseline = Math.trunc(baselineSum / POPULATION_BASELINE_WINDOW_SAMPLES);
    const cooldownOver =
      detectors.lastBoomCrashSample < 0 ||
      sampleIndex - detectors.lastBoomCrashSample > config.history.eventCooldownStatsSamples;
    if (baseline > 0 && cooldownOver) {
      const boom =
        population * Q >= baseline * (Q + config.history.populationBoomFractionQ) &&
        population - baseline >= POPULATION_EVENT_MIN_ABS_DELTA;
      const crash =
        population * Q <= baseline * (Q - config.history.populationCrashFractionQ) &&
        baseline - population >= POPULATION_EVENT_MIN_ABS_DELTA;
      if (boom || crash) {
        detectors.lastBoomCrashSample = sampleIndex;
        events.append({
          tick,
          type: boom ? WorldEventType.PopulationBoom : WorldEventType.PopulationCrash,
          severity: EventSeverity.Notable,
          payloadVersion: 1,
          payload: [population, baseline],
        });
      }
    }
  }
  detectors.populationRing[sampleIndex % POPULATION_BASELINE_WINDOW_SAMPLES] = population;

  // --- Mass extinction (docs/05 §17) ---------------------------------------------
  const massExtRingSize = MASS_EXTINCTION_WINDOW_SAMPLES + 1;
  detectors.activeSpeciesRing[sampleIndex % massExtRingSize] = species.activeCount;
  detectors.extinctSpeciesRing[sampleIndex % massExtRingSize] = extinctCount;
  if (sampleIndex >= MASS_EXTINCTION_WINDOW_SAMPLES) {
    const windowStartSample = sampleIndex - MASS_EXTINCTION_WINDOW_SAMPLES;
    if (windowStartSample > detectors.lastMassExtinctionSample) {
      const activeAtStart = detectors.activeSpeciesRing[
        windowStartSample % massExtRingSize
      ] as number;
      const extinctAtStart = detectors.extinctSpeciesRing[
        windowStartSample % massExtRingSize
      ] as number;
      const extinctions = extinctCount - extinctAtStart;
      if (
        activeAtStart >= config.history.massExtinctionMinStartingSpecies &&
        extinctions * Q >= activeAtStart * config.history.massExtinctionFractionQ
      ) {
        detectors.lastMassExtinctionSample = sampleIndex;
        const windowStartTick =
          tick - MASS_EXTINCTION_WINDOW_SAMPLES * config.time.statisticsInterval;
        const affected: number[] = [];
        for (const record of species.records) {
          if (
            record.endReason === SpeciesEndReason.Extinct &&
            record.endTick > windowStartTick &&
            record.endTick <= tick &&
            affected.length < MASS_EXTINCTION_MAX_LISTED_SPECIES
          ) {
            affected.push(record.id);
          }
        }
        events.append({
          tick,
          type: WorldEventType.MassExtinction,
          severity: EventSeverity.Major,
          speciesIds: affected,
          payloadVersion: 1,
          payload: [extinctions, activeAtStart],
        });
      }
    }
  }

  // --- Population cap episodes (task E06) ------------------------------------------
  const capRejected = organisms.capRejectedBirths;
  if (capRejected > detectors.lastCapRejectedBirths) {
    if (!detectors.capEventActive) {
      detectors.capEventActive = true;
      events.append({
        tick,
        type: WorldEventType.PopulationCapReached,
        severity: EventSeverity.Notable,
        payloadVersion: 1,
        payload: [capRejected - detectors.lastCapRejectedBirths, capRejected],
      });
    }
  } else {
    // A full interval with no rejected birth ends the episode; the next one
    // will emit again. One event per episode, not one per interval.
    detectors.capEventActive = false;
  }
  detectors.lastCapRejectedBirths = capRejected;

  detectors.sampleCount = sampleIndex + 1;
}
