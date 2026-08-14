import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  EntityDetailsDto,
  HostRuntimeConfig,
  TelemetryDto,
  WorldDisplayDto,
  WorldSummaryDto,
} from "@eon/protocol";
import { DEFAULT_HOST_RUNTIME_CONFIG } from "@eon/protocol";
import { StatsHistory } from "../charts/StatsHistory";
import { TimeSeriesChart } from "../charts/TimeSeriesChart";
import { InspectorPanel } from "./InspectorPanel";
import { LayersPanel } from "./LayersPanel";
import { StatsPanel } from "./StatsPanel";
import { TopBar } from "./TopBar";

/**
 * Rendering tests for the Milestone 7 panels.
 *
 * `renderToStaticMarkup` runs in plain Node — no DOM, no browser — which is
 * exactly the point: these components are pure functions of their DTO props,
 * and the markup they produce is assertable the same way any other pure
 * function's output is. Interaction wiring is covered by the WorldSession
 * tests (the callbacks) and by the manual browser pass.
 */

const noop = (): void => undefined;

const display: WorldDisplayDto = {
  brainInputLabels: ["bias", "energy", "health"],
  brainIntentLabels: ["throttle", "turn", "eat", "attack", "reproduce"],
  deathCauseLabels: ["none", "starvation", "oldAge"],
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
  temperatureDisplayMinC: -25,
  temperatureDisplayMaxC: 35,
  capacityDisplayReference: 4000,
};

function worldFixture(): WorldSummaryDto {
  return {
    seed: 0xe0a12026,
    seedHex: "0xE0A12026",
    engineVersion: "0.5.0",
    protocolVersion: 3,
    configSchemaVersion: 6,
    snapshotSchemaVersion: 6,
    configHash: "abc",
    worldSizeLU: 4096,
    gridSize: 256,
    cellSizeLU: 16,
    generationAttempt: 0,
    maxOrganisms: 8192,
    maxCarcasses: 4096,
    founderCentreXLU: 100,
    founderCentreYLU: 100,
    display,
  };
}

function telemetryFixture(overrides: Partial<TelemetryDto> = {}): TelemetryDto {
  return {
    tick: 4000,
    population: 1234,
    totalBirths: 500,
    totalDeaths: 300,
    capRejectedBirths: 0,
    deathsByCause: [0, 200, 100],
    carcassCount: 12,
    plantBiomass: 84_000_000,
    plantCapacity: 168_000_000,
    maxGeneration: 7,
    organismMass: 61_000,
    meanEnergyFraction: 0.62,
    traitMeans: {
      diet: -0.35,
      maxSpeedLUPerTick: 0.31,
      adultRadiusLU: 1.4,
      visionRangeLU: 38,
      attack: 0.15,
      armor: 0.12,
      metabolicPace: 0.5,
      thermalOptimumC: 17.5,
    },
    activeSpeciesCount: 3,
    totalSpeciesCount: 5,
    extinctSpeciesCount: 1,
    latestEventId: 4,
    speed: "x1",
    achievedTicksPerSecond: 19.9,
    targetTicksPerSecond: 20,
    behindTarget: false,
    renderBuffersInFlight: 1,
    droppedRenderSnapshots: 0,
    phaseMillis: [],
    ...overrides,
  };
}

function detailsFixture(): EntityDetailsDto {
  return {
    entityId: 42,
    speciesId: 1,
    generation: 3,
    parentEntityId: 7,
    ageTicks: 1500,
    xLU: 2000.4,
    yLU: 1800.2,
    headingRadians: 1.2,
    speedLUPerTick: 0.21,
    energy: 900,
    maxEnergy: 1500,
    health: 0.85,
    development: 0.997,
    radiusLU: 1.42,
    mass: 101,
    diet: -0.42,
    maxSpeedLUPerTick: 0.33,
    visionRangeLU: 41.5,
    visionFovDegrees: 210,
    attack: 0.12,
    armor: 0.22,
    metabolicPace: 0.55,
    thermalOptimumC: 19.5,
    thermalToleranceC: 8.2,
    maturityAgeTicks: 2400,
    maxAgeTicks: 14_000,
    hueDegrees: 120,
    reproductionCooldownTicks: 60,
    costBasalPerTick: 2.4,
    costMovementPerTick: 1.1,
    thermalStress: 0.12,
    brainInputs: [1, 0.5, -0.25],
    brainIntents: [0.8, -0.2, 0.6, 0.0, 0.1],
    plantEnergyEaten: 5200,
    meatEnergyEaten: 0,
    kills: 0,
    biome: 1,
    biomeName: "Grassland",
    cellTemperatureC: 21.3,
    cellPlantBiomass: 1450,
  };
}

describe("TopBar", () => {
  const hostRuntime: HostRuntimeConfig = DEFAULT_HOST_RUNTIME_CONFIG;

  function render(overrides: Partial<Parameters<typeof TopBar>[0]> = {}): string {
    return renderToStaticMarkup(
      <TopBar
        world={worldFixture()}
        hostRuntime={hostRuntime}
        telemetry={telemetryFixture()}
        speed="x1"
        debugOverlay={false}
        statsOpen={false}
        layersOpen={false}
        speciesOpen={false}
        treeOpen={false}
        timelineOpen={false}
        onSpeedChange={noop}
        onResume={noop}
        onToggleDebug={noop}
        onFitWorld={noop}
        onToggleStats={noop}
        onToggleLayers={noop}
        onToggleSpecies={noop}
        onToggleTree={noop}
        onToggleTimeline={noop}
        {...overrides}
      />,
    );
  }

  it("shows world identity, simulated year and population", () => {
    const html = render();
    expect(html).toContain("0xE0A12026");
    // 4000 ticks at 2000 ticks/year = year 2.
    expect(html).toMatch(/Year/);
    expect(html).toContain(">2<");
    expect(html).toContain("1,234");
  });

  it("shows the live species count from the Milestone 8 registry", () => {
    const html = render();
    expect(html).not.toContain("Species detection arrives with Milestone 8");
    expect(html).toContain("3 living / 1 extinct / 5 ever");
  });

  it("marks the active speed and pause state accessibly", () => {
    const paused = render({ speed: "paused", telemetry: telemetryFixture({ speed: "paused" }) });
    // The pause button is pressed; the play button is not.
    expect(paused).toMatch(/aria-pressed="true"[^>]*title="Pause the simulation"/);
    expect(paused).toContain("Paused");

    const running = render({ speed: "x20" });
    expect(running).toMatch(/aria-pressed="true"[^>]*title="400 ticks per second"/);
  });

  it("reports falling behind rather than faking the requested speed", () => {
    const html = render({
      telemetry: telemetryFixture({ behindTarget: true, achievedTicksPerSecond: 8.3 }),
    });
    expect(html).toContain("Behind");
    expect(html).toContain("8.3");
    expect(html).toContain("▼");
  });

  it("warns when the population cap has refused births", () => {
    const html = render({ telemetry: telemetryFixture({ capRejectedBirths: 17 }) });
    expect(html).toContain("Population cap reached");
    expect(html).toContain("⚠");
  });

  it("derives speed tooltips from the runtime's real 1x rate, not a hardcode", () => {
    // A host paced at 30 ticks/s must not advertise the default 20-based rates.
    const html = render({ hostRuntime: { ...hostRuntime, targetTicksPerSecond1x: 30 } });
    expect(html).toContain("30 ticks per second");
    expect(html).toContain("600 ticks per second"); // x20
    expect(html).toContain("3,000 ticks per second"); // x100
    expect(html).not.toContain("400 ticks per second");
  });
});

describe("InspectorPanel", () => {
  function render(overrides: Partial<Parameters<typeof InspectorPanel>[0]> = {}): string {
    return renderToStaticMarkup(
      <InspectorPanel
        selectedEntityId={42}
        details={detailsFixture()}
        gone={false}
        following={false}
        display={display}
        onClear={noop}
        onFocus={noop}
        onToggleFollow={noop}
        onSelectSpecies={noop}
        {...overrides}
      />,
    );
  }

  it("invites selection when nothing is selected", () => {
    const html = render({ selectedEntityId: null, details: null });
    expect(html).toContain("Click an organism");
  });

  it("shows identity, vitals, traits, costs and surroundings", () => {
    const html = render();
    expect(html).toContain("Organism #42");
    expect(html).toContain("Generation");
    expect(html).toContain("#7"); // parent
    expect(html).toContain("99.7% (juvenile)");
    expect(html).toContain("herbivore (-0.42)");
    expect(html).toContain("Grassland");
    expect(html).toContain("Running costs");
    expect(html).toContain("2.4"); // basal
    expect(html).toContain("cooldown 60 ticks");
  });

  it("labels the brain view from the world's own label list", () => {
    const html = render();
    expect(html).toContain("Brain (last tick)");
    expect(html).toContain("throttle");
    expect(html).toContain("reproduce");
    expect(html).toContain("bias");
    // Turn is signed and formatted with an explicit sign.
    expect(html).toContain("-0.20");
  });

  it("says plainly when the organism is gone and hides follow", () => {
    const html = render({ gone: true });
    expect(html).toContain("no longer alive");
    expect(html).not.toContain(">Follow<");
  });

  it("reflects an active follow", () => {
    const html = render({ following: true });
    expect(html).toContain("Following ✓");
  });
});

describe("LayersPanel", () => {
  function render(overrides: Partial<Parameters<typeof LayersPanel>[0]> = {}): string {
    return renderToStaticMarkup(
      <LayersPanel
        active="terrain"
        opacity={0.85}
        display={display}
        onSelect={noop}
        onOpacity={noop}
        {...overrides}
      />,
    );
  }

  it("lists every world layer with the active one checked", () => {
    const html = render({ active: "temperature" });
    for (const label of [
      "Terrain",
      "Biomes",
      "Elevation",
      "Temperature",
      "Moisture",
      "Fertility",
      "Plant biomass",
      "Plant capacity",
      "Organism density",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toMatch(/aria-checked="true"[^>]*>Temperature/);
    // Radios are aria-checked only: aria-pressed belongs to toggle buttons and
    // contradicts the radio role for assistive tech.
    expect(html).not.toContain("aria-pressed");
  });

  it("captions the temperature legend with the published display range", () => {
    const html = render({ active: "temperature" });
    expect(html).toContain("-25 °C");
    expect(html).toContain("35 °C");
  });

  it("shows biome swatches for the categorical layer", () => {
    const html = render({ active: "biome" });
    expect(html).toContain("Grassland");
    expect(html).toContain("Tundra");
  });
});

describe("StatsPanel and charts", () => {
  it("renders numeric summaries and charts from bounded history", () => {
    const history = new StatsHistory(64);
    for (let i = 1; i <= 30; i += 1) {
      history.push(telemetryFixture({ tick: i * 100, population: 1000 + i }));
    }
    const html = renderToStaticMarkup(
      <StatsPanel
        history={history}
        revision={3000}
        telemetry={telemetryFixture()}
        display={display}
        ticksPerSimYear={2000}
      />,
    );
    expect(html).toContain("Population");
    expect(html).toContain("Plant biomass");
    expect(html).toContain("Births &amp; deaths");
    expect(html).toContain("Mean diet");
    // Charts are real SVG paths, and deaths-by-cause totals are named.
    expect(html).toContain("<path");
    expect(html).toContain("starvation");
    // The numeric summary of the newest population value is present as text.
    expect(html).toContain("1,030");
  });

  it("shows an honest collecting state before two samples exist", () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart
        title="Population"
        ticksPerSimYear={2000}
        formatValue={(value) => value.toFixed(0)}
        series={[{ label: "population", color: "#3987e5", points: [] }]}
      />,
    );
    expect(html).toContain("collecting…");
    expect(html).not.toContain("<path");
  });
});
