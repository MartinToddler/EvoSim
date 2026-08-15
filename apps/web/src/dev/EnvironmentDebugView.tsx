import type { SimulationEngine } from "@eon/engine";
import {
  DEBUG_BIOME_NAMES,
  ENVIRONMENT_DEBUG_LAYERS,
  type EnvironmentDebugFields,
  type EnvironmentDebugLayerId,
  Q_SCALE,
  debugBiomeName,
  describeLayerLegend,
  formatCellValue,
  formatCentiC,
  formatQ,
} from "@eon/renderer";
import { memo, useCallback, useState } from "react";
import { EnvironmentFieldCanvas } from "./EnvironmentFieldCanvas";
import {
  type DebugWorldModel,
  advanceDebugWorld,
  createDebugWorld,
  readDebugWorldModel,
} from "./debugWorld";
import { FIXTURE_SEED, PRESET_SEEDS } from "./presetSeeds";
import { formatSeedHex, parseSeedInput } from "./seedInput";
import { toggleViewHref } from "../app/route";
import "./devView.css";

/**
 * Milestone 2.5 environment debug view.
 *
 * A development tool for looking at generated worlds — explicitly not the
 * Milestone 6 renderer or Milestone 7 observation UI. It is confined to
 * `apps/web/src/dev/` plus the pure painter in `@eon/renderer/debug`, so it can be
 * deleted in one directory or kept as the debug overlay of docs/06 §18.
 *
 * React holds only low-frequency values (docs/10 §23): the seed text, the selected
 * layer, the hovered cell, and one immutable world read-out plus the opaque engine
 * handle that produced it. React never reads a field off the engine during render;
 * every value on screen comes from {@link DebugWorldModel}, which is rebuilt
 * explicitly. Camera state lives inside the canvas component, and no biology,
 * classification or growth rule exists in this file.
 *
 * The hovered cell is the one value here that a pointer can change many times a
 * second, and it is needed by exactly one small panel. Everything that does not
 * depend on it — the map, the legend and the world read-out — is a memoized child
 * keyed on the world, so a hover re-renders a dozen table rows rather than the
 * whole tool.
 *
 * The first world is generated in the `useState` initializer rather than in an
 * effect. World generation is a pure function of (seed, config) — the project's
 * determinism contract guarantees it — so the initializer is idempotent and React
 * StrictMode's double invocation produces the identical world.
 */

/** Tick counts offered by the advance controls. */
const ADVANCE_STEPS = [1_000, 10_000] as const;

type WorldState =
  | { readonly status: "ready"; readonly engine: SimulationEngine; readonly model: DebugWorldModel }
  | { readonly status: "failed"; readonly seed: number; readonly message: string };

function loadWorld(seed: number): WorldState {
  const result = createDebugWorld(seed);
  return result.ok
    ? { status: "ready", engine: result.value, model: readDebugWorldModel(result.value) }
    : { status: "failed", seed, message: result.error };
}

/**
 * Pick an arbitrary seed (docs/01 §3 "Enter/randomize seed").
 *
 * `Math.random` only CHOOSES the seed; the world remains a pure function of the
 * seed chosen, and that seed is displayed so the world can be recreated exactly.
 * The determinism ban on `Math.random` covers authoritative simulation code, which
 * is lint-enforced inside `packages/engine`.
 */
function randomSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000);
}

function formatPercentQ(valueQ: number): string {
  return `${((valueQ * 100) / Q_SCALE).toFixed(1)}%`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function EnvironmentDebugView() {
  const [world, setWorld] = useState<WorldState>(() => loadWorld(FIXTURE_SEED));
  const [seedText, setSeedText] = useState(formatSeedHex(FIXTURE_SEED));
  const [inputError, setInputError] = useState<string | null>(null);
  const [layer, setLayer] = useState<EnvironmentDebugLayerId>("biome");
  const [hoveredCell, setHoveredCell] = useState<number | null>(null);
  const [recenterToken, setRecenterToken] = useState(0);

  const loadSeed = (seed: number): void => {
    setSeedText(formatSeedHex(seed));
    setInputError(null);
    setHoveredCell(null);
    setWorld(loadWorld(seed));
  };

  const submitSeed = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsed = parseSeedInput(seedText);
    if (!parsed.ok) {
      setInputError(parsed.error);
      return;
    }
    loadSeed(parsed.value);
  };

  const advance = (ticks: number): void => {
    if (world.status !== "ready") {
      return;
    }
    const result = advanceDebugWorld(world.engine, ticks);
    if (!result.ok) {
      setInputError(result.error);
      return;
    }
    setInputError(null);
    setWorld({ status: "ready", engine: world.engine, model: result.value });
  };

  const handleHover = useCallback((cellIndex: number | null) => {
    setHoveredCell(cellIndex);
  }, []);

  const activeLayer =
    ENVIRONMENT_DEBUG_LAYERS.find((descriptor) => descriptor.id === layer) ??
    ENVIRONMENT_DEBUG_LAYERS[0];
  const model = world.status === "ready" ? world.model : null;

  return (
    <div className="eon-debug">
      <header className="eon-debug__header">
        <h1>EON — world generator</h1>
        <p>
          Generate a world from a seed and inspect the environment it produced, without running it.
          This projects the authoritative environment grid to pixels and decides nothing: no
          organisms, no worker, no Pixi renderer — those live on the simulation screen.{" "}
          <a href={toggleViewHref(globalThis.location?.search ?? "", "simulation")}>
            Back to the simulation
          </a>
          .
        </p>
      </header>

      <section className="eon-debug__panel" aria-label="World controls">
        <form className="eon-debug__row" onSubmit={submitSeed}>
          <label htmlFor="eon-seed">Seed</label>
          <input
            id="eon-seed"
            className="eon-debug__seed"
            value={seedText}
            spellCheck={false}
            autoComplete="off"
            aria-describedby="eon-seed-hint"
            onChange={(event) => {
              setSeedText(event.target.value);
            }}
          />
          <button type="submit">Generate world</button>
          <button
            type="button"
            onClick={() => {
              loadSeed(randomSeed());
            }}
          >
            Random seed
          </button>
          <button
            type="button"
            onClick={() => {
              setRecenterToken((token) => token + 1);
            }}
          >
            Recenter map
          </button>
          <span id="eon-seed-hint" className="eon-debug__hint">
            Decimal or 0x-hex, uint32. Same seed and engine version always give the same world.
          </span>
        </form>

        <div className="eon-debug__row">
          <span className="eon-debug__rowLabel">Presets</span>
          {PRESET_SEEDS.map((preset) => (
            <button
              key={preset.seed}
              type="button"
              title={`${formatSeedHex(preset.seed)} — ${preset.note}`}
              aria-pressed={model?.seed === preset.seed}
              className={model?.seed === preset.seed ? "eon-debug__preset--active" : undefined}
              onClick={() => {
                loadSeed(preset.seed);
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="eon-debug__row">
          <span className="eon-debug__rowLabel">Time</span>
          {ADVANCE_STEPS.map((ticks) => (
            <button
              key={ticks}
              type="button"
              disabled={world.status !== "ready"}
              onClick={() => {
                advance(ticks);
              }}
            >
              +{formatCount(ticks)} ticks
            </button>
          ))}
          <span className="eon-debug__hint">
            Runs the engine synchronously on the main thread, so the tab freezes while it works.
            Plant growth is the only phase implemented; it runs once every 20 ticks. Real time
            controls and the worker are Milestone 6.
          </span>
        </div>
      </section>

      {inputError !== null && (
        <section className="eon-debug__error" role="alert">
          <pre>{inputError}</pre>
        </section>
      )}

      {world.status === "failed" ? (
        <section className="eon-debug__error" role="alert">
          <strong>
            No valid world for seed {formatSeedHex(world.seed)}. Nothing was generated.
          </strong>
          <pre>{world.message}</pre>
        </section>
      ) : (
        <div className="eon-debug__body">
          <section className="eon-debug__map" aria-label="Map">
            <fieldset className="eon-debug__layers">
              <legend>Layer</legend>
              {ENVIRONMENT_DEBUG_LAYERS.map((descriptor) => (
                <label key={descriptor.id} className="eon-debug__layerOption">
                  <input
                    type="radio"
                    name="eon-layer"
                    value={descriptor.id}
                    checked={layer === descriptor.id}
                    onChange={() => {
                      setLayer(descriptor.id);
                    }}
                  />
                  {descriptor.label}
                </label>
              ))}
            </fieldset>

            <p className="eon-debug__layerDescription">{activeLayer?.description}</p>

            <EnvironmentFieldCanvas
              fields={world.model.fields}
              layer={layer}
              worldKey={world.model.worldKey}
              markerGridX={world.model.founderRegion.centerGridX}
              markerGridY={world.model.founderRegion.centerGridY}
              markerRadiusCells={world.model.founderRadiusCells}
              recenterToken={recenterToken}
              onHoverCellChange={handleHover}
            />

            <LayerLegend fields={world.model.fields} layer={layer} />

            <p className="eon-debug__hint">
              Drag to pan, wheel to zoom, hover for cell values. The yellow ring marks the founder
              spawn region; cell gridlines appear when zoomed in.
            </p>
          </section>

          <aside className="eon-debug__facts">
            <WorldFacts model={world.model} />

            <h2>Hovered cell</h2>
            {hoveredCell === null ? (
              <p className="eon-debug__dim">Point at the map.</p>
            ) : (
              <HoveredCellFacts fields={world.model.fields} cellIndex={hoveredCell} />
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

/**
 * Layer legend. Memoized because `describeLayerLegend` rebuilds its entries on
 * every call and neither of its inputs depends on the pointer.
 */
const LayerLegend = memo(function LayerLegend({
  fields,
  layer,
}: {
  fields: EnvironmentDebugFields;
  layer: EnvironmentDebugLayerId;
}) {
  return (
    <div className="eon-debug__legend" aria-label="Legend">
      {describeLayerLegend(fields, layer).map((entry) => (
        <span key={entry.caption} className="eon-debug__legendEntry">
          <i className="eon-debug__swatch" style={{ background: entry.css }} aria-hidden />
          {entry.caption}
        </span>
      ))}
    </div>
  );
});

/**
 * World read-out and biome distribution.
 *
 * Memoized on the immutable {@link DebugWorldModel}: these forty-odd DOM nodes
 * describe the world, not the pointer, so they must not be rebuilt every time the
 * hovered cell changes.
 */
const WorldFacts = memo(function WorldFacts({ model }: { model: DebugWorldModel }) {
  return (
    <>
      <h2>World</h2>
      <dl>
        <Fact label="Seed">
          {formatSeedHex(model.seed)} <span className="eon-debug__dim">({model.seed})</span>
        </Fact>
        <Fact label="Environment hash">
          <code>{model.environmentHash}</code>
        </Fact>
        <Fact label="World state hash">
          <code>{model.stateHash}</code>
        </Fact>
        <Fact label="Config hash">
          <code>{model.configHash}</code>
        </Fact>
        <Fact label="Engine">
          {model.engineVersion}{" "}
          <span className="eon-debug__dim">config schema {model.configSchemaVersion}</span>
        </Fact>
        <Fact label="Tick">{formatCount(model.tick)}</Fact>
        <Fact label="Generation attempt">
          {model.generationAttempt}
          {model.generationAttempt > 0 && (
            <span className="eon-debug__dim"> — earlier attempts were rejected</span>
          )}
        </Fact>
        <Fact label="Grid">
          {model.fields.size} × {model.fields.size} cells,{" "}
          {formatCount(model.fields.size * model.fields.cellSizeLU)} LU across
        </Fact>

        <Fact label="Land fraction">
          {formatPercentQ(model.summary.landFractionQ)}{" "}
          <span className="eon-debug__dim">
            ({formatQ(model.summary.landFractionQ)} Q · {formatCount(model.summary.landCells)} land
            / {formatCount(model.summary.waterCells)} water cells)
          </span>
        </Fact>
        <Fact label="Mean temperature">
          {formatCentiC(model.summary.meanTemperatureCentiC)}{" "}
          <span className="eon-debug__dim">
            (range {formatCentiC(model.summary.minTemperatureCentiC)} …{" "}
            {formatCentiC(model.summary.maxTemperatureCentiC)})
          </span>
        </Fact>
        <Fact label="Mean fertility">
          {formatQ(model.summary.meanFertilityQ)}{" "}
          <span className="eon-debug__dim">
            ({formatPercentQ(model.summary.meanFertilityQ)} of maximum)
          </span>
        </Fact>
        <Fact label="Mean moisture">{formatQ(model.summary.meanMoistureQ)}</Fact>
        <Fact label="Mean elevation">{formatQ(model.summary.meanElevationQ)}</Fact>

        <Fact label="Plant capacity">
          {formatCount(model.summary.totalPlantCapacity)} units{" "}
          <span className="eon-debug__dim">
            (max {formatCount(model.summary.maxPlantCapacity)} per cell)
          </span>
        </Fact>
        <Fact label="Current biomass">
          {formatCount(model.summary.totalPlantBiomass)} units{" "}
          <span className="eon-debug__dim">
            ({formatPercentQ(model.summary.biomassFractionOfCapacityQ)} of capacity)
          </span>
        </Fact>
        <Fact label="Founder region">
          cell {formatCount(model.founderRegion.centerCellIndex)} at (
          {model.founderRegion.centerGridX}, {model.founderRegion.centerGridY}){" "}
          <span className="eon-debug__dim">
            in a {formatCount(model.founderRegion.componentCells)}-cell landmass
          </span>
        </Fact>
      </dl>

      <h2>Biomes</h2>
      <table className="eon-debug__table">
        <thead>
          <tr>
            <th scope="col">Biome</th>
            <th scope="col">Cells</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {model.summary.biomeCellCounts.map((cells, biome) => (
            <tr key={DEBUG_BIOME_NAMES[biome] ?? biome}>
              <th scope="row">{debugBiomeName(biome)}</th>
              <td>{formatCount(cells)}</td>
              <td>{((cells / model.summary.cellCount) * 100).toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
});

/** The one panel that legitimately follows the pointer. */
function HoveredCellFacts({
  fields,
  cellIndex,
}: {
  fields: EnvironmentDebugFields;
  cellIndex: number;
}) {
  return (
    <dl>
      <Fact label="Cell">
        {formatCount(cellIndex)} at ({cellIndex % fields.size},{" "}
        {Math.floor(cellIndex / fields.size)})
      </Fact>
      <Fact label="Biome">{debugBiomeName(fields.biome[cellIndex] as number)}</Fact>
      <Fact label="Elevation">{formatCellValue(fields, "elevation", cellIndex)}</Fact>
      <Fact label="Temperature">{formatCellValue(fields, "temperature", cellIndex)}</Fact>
      <Fact label="Moisture">{formatCellValue(fields, "moisture", cellIndex)}</Fact>
      <Fact label="Fertility">{formatCellValue(fields, "fertility", cellIndex)}</Fact>
      <Fact label="Plant capacity">{formatCellValue(fields, "plantCapacity", cellIndex)}</Fact>
      <Fact label="Current biomass">{formatCellValue(fields, "plantBiomass", cellIndex)}</Fact>
    </dl>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="eon-debug__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
