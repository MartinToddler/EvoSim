import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  SpeciesDetailsDto,
  SpeciesSummaryDto,
  TreeSnapshotDto,
  WorldDisplayDto,
  WorldEventDto,
} from "@eon/protocol";
import { SpeciesPanel, speciesName } from "./SpeciesPanel";
import { TimelinePanel } from "./TimelinePanel";
import { TreePanel } from "./TreePanel";

/**
 * Milestone 8 panels (tasks I07/I08), tested the way every panel here is: as
 * pure functions of DTO props rendered to static markup in Node — no DOM.
 */

const noop = (): void => {};

const display: WorldDisplayDto = {
  brainInputLabels: [],
  brainIntentLabels: [],
  deathCauseLabels: ["none", "starvation"],
  eventTypeLabels: [
    "worldCreated",
    "speciesSplit",
    "speciesExtinct",
    "populationBoom",
    "populationCrash",
    "firstPredation",
    "carnivoreLineageDetected",
    "massExtinction",
    "populationCapReached",
    "playerIntervention",
  ],
  eventSeverityLabels: ["info", "notable", "major"],
  speciesEndReasonLabels: ["active", "split", "extinct"],
  traitDimensionLabels: [
    "adultSize",
    "effectiveMaxSpeed",
    "acceleration",
    "turn",
    "visionRange",
    "visionFov",
    "diet",
    "attack",
    "armor",
    "metabolicPace",
    "thermalOptimum",
    "thermalTolerance",
    "maturity",
    "maxAge",
    "offspringInvestment",
  ],
  interventionKindLabels: [
    "globalTemperature",
    "temperatureBrush",
    "moistureBrush",
    "fertilityBrush",
    "raiseTerrain",
    "lowerTerrain",
    "addBiomass",
    "removeBiomass",
    "meteor",
  ],
  interventions: {
    brushSampleSpacingLU: 8,
    maxBrushSamplesPerCommand: 64,
    minBrushRadiusLU: 4,
    maxBrushRadiusLU: 128,
    maxTemperatureBrushStrengthCentiC: 400,
    maxMoistureBrushStrengthQ: 512,
    maxFertilityBrushStrengthQ: 512,
    maxTerrainBrushStrengthQ: 256,
    maxBiomassBrushStrengthUnits: 4000,
    maxGlobalTemperatureOffsetCentiC: 2000,
    meteorMinRadiusLU: 24,
    meteorMaxRadiusLU: 256,
  },
  temperatureDisplayMinC: -25,
  temperatureDisplayMaxC: 35,
  capacityDisplayReference: 4000,
  tickPhaseLabels: ["total", "environment", "sensing", "brain"],
};

function summary(overrides: Partial<SpeciesSummaryDto>): SpeciesSummaryDto {
  return {
    id: 1,
    parentSpeciesId: 0,
    originTick: 0,
    endTick: 0,
    endReason: 0,
    population: 120,
    plantEnergyConsumed: 90_000,
    meatEnergyConsumed: 10_000,
    carnivoreDetected: false,
    centroidDiet: -0.4,
    ...overrides,
  };
}

/** A three-species world: 1 split into 2 (active) and 3 (extinct). */
function treeFixture(): TreeSnapshotDto {
  return {
    tick: 5000,
    species: [
      summary({ id: 1, endTick: 2000, endReason: 1, population: 0 }),
      summary({ id: 2, parentSpeciesId: 1, originTick: 2000, population: 80 }),
      summary({
        id: 3,
        parentSpeciesId: 1,
        originTick: 2000,
        endTick: 4200,
        endReason: 2,
        population: 0,
        carnivoreDetected: true,
      }),
    ],
  };
}

function detailsFixture(): SpeciesDetailsDto {
  return {
    ...summary({ id: 2, parentSpeciesId: 1, originTick: 2000, population: 80 }),
    founderEntityId: 3141,
    generationAtOrigin: 6,
    totalBirths: 300,
    totalDeaths: 220,
    totalKills: 4,
    centroidTraits: new Array<number>(15).fill(0.5),
    originCentroid: new Array<number>(15).fill(0.25),
    candidatePasses: 2,
    stabilityIntervalsRequired: 5,
    childIds: [],
    meanAgeTicks: 1500,
    meanEnergyFraction: 0.61,
    series: {
      ticks: [4800, 4900, 5000],
      population: [70, 75, 80],
      meanSize: [0.5, 0.5, 0.51],
      meanSpeed: [0.4, 0.41, 0.4],
      meanDiet: [-0.4, -0.38, -0.36],
    },
  };
}

function eventFixture(overrides: Partial<WorldEventDto>): WorldEventDto {
  return {
    id: 1,
    tick: 2000,
    type: 1,
    severity: 1,
    speciesIds: [1, 2, 3],
    entityIds: [],
    region: null,
    payloadVersion: 1,
    payload: [],
    ...overrides,
  };
}

describe("speciesName", () => {
  it("uses the docs/05 §9 zero-padded fallback naming", () => {
    expect(speciesName(7)).toBe("Species 0007");
    expect(speciesName(1234)).toBe("Species 1234");
  });
});

describe("SpeciesPanel", () => {
  function render(overrides: Partial<Parameters<typeof SpeciesPanel>[0]> = {}): string {
    return renderToStaticMarkup(
      <SpeciesPanel
        tree={treeFixture()}
        selectedSpeciesId={null}
        details={null}
        display={display}
        ticksPerSimYear={2000}
        onSelectSpecies={noop}
        onOpenTree={noop}
        onClose={noop}
        {...overrides}
      />,
    );
  }

  it("lists living and ended species with honest naming", () => {
    const html = render();
    expect(html).toContain("Species 0002");
    expect(html).toContain("Living (1) · ended (2)");
    // The morphospecies honesty tooltip (docs/05 §2).
    expect(html).toContain("not reproductive isolation");
  });

  it("shows the inspector fields for a selected species", () => {
    const html = render({ selectedSpeciesId: 2, details: detailsFixture() });
    expect(html).toContain("Species 0002");
    expect(html).toContain("Species 0001"); // parent link
    expect(html).toContain("90% plants / 10% meat");
    expect(html).toContain("#3141");
    // The pending-split progress indicator.
    expect(html).toContain("2 / 5 analyses");
    // Charts and trait bars are rendered from the series/centroid.
    expect(html).toContain("Population");
    expect(html).toContain("adultSize");
  });

  it("marks carnivore lineages with a badge", () => {
    const html = render();
    expect(html).toContain("Detected carnivore lineage");
  });
});

describe("TreePanel", () => {
  function render(overrides: Partial<Parameters<typeof TreePanel>[0]> = {}): string {
    return renderToStaticMarkup(
      <TreePanel
        tree={treeFixture()}
        currentTick={5000}
        ticksPerSimYear={2000}
        selectedSpeciesId={2}
        display={display}
        onSelectSpecies={noop}
        onClose={noop}
        {...overrides}
      />,
    );
  }

  it("draws one life bar per species and a split connector", () => {
    const html = render();
    expect(html).toContain("Tree of Life");
    // Three species groups, each with a life line and a label.
    expect(html.match(/tree-species /g)?.length).toBe(3);
    expect(html).toContain("tree-connector");
    // Status distinction beyond colour: active arrowhead + extinct cross.
    expect(html).toContain("tree-cap-active");
    expect(html).toContain("tree-cap-extinct");
    expect(html).toContain("Species 0003 🥩");
  });

  it("marks the selected species", () => {
    const html = render();
    expect(html).toContain("is-selected");
  });

  it("waits politely before the first snapshot", () => {
    const html = render({ tree: null });
    expect(html).toContain("Waiting for the first species snapshot");
  });
});

describe("TimelinePanel", () => {
  function render(overrides: Partial<Parameters<typeof TimelinePanel>[0]> = {}): string {
    return renderToStaticMarkup(
      <TimelinePanel
        events={[
          eventFixture({ id: 1, tick: 0, type: 0, severity: 0, speciesIds: [1] }),
          eventFixture({ id: 2, tick: 2000, type: 1, severity: 1 }),
          eventFixture({ id: 3, tick: 4200, type: 2, severity: 1, speciesIds: [3] }),
          eventFixture({ id: 4, tick: 4600, type: 7, severity: 2, speciesIds: [3] }),
        ]}
        droppedBeforeOldest={0}
        currentTick={5000}
        ticksPerSimYear={2000}
        display={display}
        onSelectSpecies={noop}
        onClose={noop}
        {...overrides}
      />,
    );
  }

  it("renders a marker per event and a readable list", () => {
    const html = render();
    expect(html.match(/timeline-marker/g)?.length).toBe(4);
    expect(html).toContain("species split");
    expect(html).toContain("species extinct");
    expect(html).toContain("mass extinction");
  });

  it("says so when history is empty", () => {
    const html = render({ events: [] });
    expect(html).toContain("No events yet");
  });

  it("reports events dropped from the bounded log", () => {
    const html = render({ droppedBeforeOldest: 12 });
    expect(html).toContain("12");
    expect(html).toContain("older events left the in-memory log");
  });
});
