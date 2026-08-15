import { SpeciesEndReason, type SpeciesRecord } from "../evolution/SpeciesStore";
import { SpeciesStatMetric, WorldStatMetric } from "../history/StatisticsStore";
import { engineInternals } from "../internal";
import { Q } from "../math/fixed";
import { currentRadiusPos, massFromRadiusPos, maxEnergyForMass } from "../organisms/phenotype";
import type { SimulationEngine } from "../SimulationEngine";

/**
 * Read-only species queries for the worker host (docs/02 §14 QUERY_SPECIES /
 * REQUEST_TREE, docs/06 §§12, 14, 19).
 *
 * Pure projections, like queryEntity: they read authoritative state between
 * ticks and return plain data. Nothing here mutates a store, draws randomness
 * or is itself authoritative — a test pins that querying does not move the
 * state hash.
 */

/** One species row for the Tree of Life and species lists. */
export interface SpeciesSummary {
  id: number;
  parentSpeciesId: number;
  originTick: number;
  endTick: number;
  /** SpeciesEndReason value: 0 active, 1 split, 2 extinct. */
  endReason: number;
  population: number;
  /** Lifetime observed intake, for the docs/06 §19 dominant-diet display. */
  plantEnergyConsumed: number;
  meatEnergyConsumed: number;
  carnivoreDetected: boolean;
  /** Normalized signed diet position of the current centroid, in [-Q, Q]. */
  centroidDietQ: number;
}

/** Everything the species inspector shows (docs/06 §12). */
export interface SpeciesDetails extends SpeciesSummary {
  founderEntityId: number;
  generationAtOrigin: number;
  totalBirths: number;
  totalDeaths: number;
  totalKills: number;
  /** Current centroid, TRAIT_DIMENSIONS normalized [0, Q] values. */
  centroidTraits: number[];
  /** Centroid at origin, same shape. */
  originCentroid: number[];
  /** Split-candidate progress: 0 when no candidate is being tracked. */
  candidatePasses: number;
  /** Analyses a candidate must survive before the split executes. */
  stabilityIntervalsRequired: number;
  /** IDs of daughter species, ascending; empty unless this species split. */
  childIds: number[];
  /** Live means, computed on demand; zeros when the species has no members. */
  meanAgeTicks: number;
  meanEnergyRatioQ: number;
  /** Recent per-species samples (docs/06 §15), oldest first. */
  series: {
    ticks: number[];
    population: number[];
    meanSizeQ: number[];
    meanSpeedQ: number[];
    meanDietQ: number[];
  };
}

/** The whole registry, for the Tree of Life (docs/05 §19). */
export interface TreeSnapshot {
  tick: number;
  /** Every species ever, ascending ID — parents always precede children. */
  species: SpeciesSummary[];
}

/** Normalized diet dimension of a centroid mapped back to signed [-Q, Q]. */
function centroidDietSignedQ(record: SpeciesRecord): number {
  // Trait dimension 6 stores diet normalized to [0, Q] over the [-Q, Q] band.
  const normalized = record.centroidTraits[6] as number;
  return 2 * normalized - Q;
}

function summarize(record: SpeciesRecord): SpeciesSummary {
  return {
    id: record.id,
    parentSpeciesId: record.parentSpeciesId,
    originTick: record.originTick,
    endTick: record.endTick,
    endReason: record.endReason,
    population: record.population,
    plantEnergyConsumed: record.plantEnergyConsumed,
    meatEnergyConsumed: record.meatEnergyConsumed,
    carnivoreDetected: record.carnivoreDetected,
    centroidDietQ: centroidDietSignedQ(record),
  };
}

/** Snapshot every species record for the tree. */
export function queryTree(engine: SimulationEngine): TreeSnapshot {
  return {
    tick: engine.tick,
    species: engine.species.records.map(summarize),
  };
}

/** Full inspector detail for one species, or null if the ID was never issued. */
export function querySpecies(engine: SimulationEngine, speciesId: number): SpeciesDetails | null {
  if (!Number.isSafeInteger(speciesId) || speciesId < 1 || speciesId > engine.species.count) {
    return null;
  }
  const record = engine.species.get(speciesId);
  const { organisms } = engine;
  const { context } = engineInternals(engine);

  // Live means for the inspector (docs/05 §10 species sample: mean age/energy).
  let ageSum = 0;
  let energyRatioSumQ = 0;
  let members = 0;
  if (record.endReason === SpeciesEndReason.Active && record.population > 0) {
    const { phenotypes, config } = context;
    for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
      if (organisms.alive[slot] !== 1 || organisms.speciesId[slot] !== speciesId) {
        continue;
      }
      members += 1;
      ageSum += organisms.ageTicks[slot] as number;
      const radius = currentRadiusPos(
        phenotypes.adultRadiusPos[slot] as number,
        organisms.developmentQ[slot] as number,
      );
      const mass = massFromRadiusPos(radius, config.organism.massScalePerRadiusSquared);
      const maxEnergy = maxEnergyForMass(mass, config);
      if (maxEnergy > 0) {
        const ratio = Math.trunc(((organisms.energy[slot] as number) * Q) / maxEnergy);
        energyRatioSumQ += Math.min(ratio, Q);
      }
    }
  }

  const childIds: number[] = [];
  for (const other of engine.species.records) {
    if (other.parentSpeciesId === speciesId) {
      childIds.push(other.id);
    }
  }

  const stats = engine.stats;
  const ticks = stats.speciesSeries(speciesId, SpeciesStatMetric.Population).ticks;
  const series = {
    ticks,
    population: stats.speciesSeries(speciesId, SpeciesStatMetric.Population).values,
    meanSizeQ: stats.speciesSeries(speciesId, SpeciesStatMetric.MeanSizeQ).values,
    meanSpeedQ: stats.speciesSeries(speciesId, SpeciesStatMetric.MeanSpeedQ).values,
    meanDietQ: stats.speciesSeries(speciesId, SpeciesStatMetric.MeanDietQ).values,
  };

  return {
    ...summarize(record),
    founderEntityId: record.founderEntityId,
    generationAtOrigin: record.generationAtOrigin,
    totalBirths: record.totalBirths,
    totalDeaths: record.totalDeaths,
    totalKills: record.totalKills,
    centroidTraits: Array.from(record.centroidTraits),
    originCentroid: Array.from(record.originCentroid),
    candidatePasses: record.candidate === null ? 0 : record.candidate.passes,
    stabilityIntervalsRequired: engine.config.species.stabilityIntervals,
    childIds,
    meanAgeTicks: members === 0 ? 0 : Math.trunc(ageSum / members),
    meanEnergyRatioQ: members === 0 ? 0 : Math.trunc(energyRatioSumQ / members),
    series,
  };
}

/**
 * Events with `id > sinceEventId` plus the retained world population series,
 * for the timeline (docs/02 §14 REQUEST_HISTORY_RANGE, docs/06 §13).
 */
export interface HistorySlice {
  tick: number;
  droppedEventCount: number;
  /** IDs the UI can page from; empty when nothing new. */
  events: {
    id: number;
    tick: number;
    type: number;
    severity: number;
    speciesIds: number[];
    entityIds: number[];
    regionXPos: number;
    regionYPos: number;
    regionRadiusPos: number;
    payloadVersion: number;
    payload: number[];
  }[];
  /** Retained world series for the timeline backdrop, oldest first. */
  worldSeries: {
    ticks: number[];
    population: number[];
    activeSpecies: number[];
  };
}

export function queryHistory(engine: SimulationEngine, sinceEventId: number): HistorySlice {
  const events = engine.events.eventsSince(sinceEventId).map((event) => ({
    id: event.id,
    tick: event.tick,
    type: event.type,
    severity: event.severity,
    speciesIds: [...event.speciesIds],
    entityIds: [...event.entityIds],
    regionXPos: event.regionXPos,
    regionYPos: event.regionYPos,
    regionRadiusPos: event.regionRadiusPos,
    payloadVersion: event.payloadVersion,
    payload: [...event.payload],
  }));
  const population = engine.stats.worldSeries(WorldStatMetric.Population);
  const activeSpecies = engine.stats.worldSeries(WorldStatMetric.ActiveSpecies);
  return {
    tick: engine.tick,
    droppedEventCount: engine.events.droppedEventCount,
    events,
    worldSeries: {
      ticks: population.ticks,
      population: population.values,
      activeSpecies: activeSpecies.values,
    },
  };
}
