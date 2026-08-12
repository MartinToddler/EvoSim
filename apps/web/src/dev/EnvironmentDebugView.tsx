import type { SimulationEngine } from "@eon/engine";
import {
  DEBUG_BIOME_NAMES,
  ENVIRONMENT_DEBUG_LAYERS,
  type EnvironmentDebugLayerId,
  Q_SCALE,
  debugBiomeName,
  describeLayerLegend,
  formatCellValue,
  formatCentiC,
  formatQ,
} from "@eon/renderer";
import { useCallback, useState } from "react";
import { EnvironmentFieldCanvas } from "./EnvironmentFieldCanvas";
import {
  type DebugWorldModel,
  advanceDebugWorld,
  createDebugWorld,
  readDebugWorldModel,
} from "./debugWorld";
import { FIXTURE_SEED, PRESET_SEEDS } from "./presetSeeds";
import { formatSeedHex, parseSeedInput } from "./seedInput";
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
        <h1>EON — environment debug view</h1>
        <p>
          Development tool for Milestone 2.5. It projects the authoritative environment grid to
          pixels and decides nothing: no organisms, no worker, no Pixi renderer. Those arrive in
          Milestones 3 and 6.
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
              markerGridX={world.model.founderRegion.centerGridX}
              markerGridY={world.model.founderRegion.centerGridY}
              markerRadiusCells={world.model.founderRadiusCells}
              recenterToken={recenterToken}
              onHoverCellChange={handleHover}
            />

            <div className="eon-debug__legend" aria-label="Legend">
              {describeLayerLegend(world.model.fields, layer).map((entry) => (
                <span key={entry.caption} className="eon-debug__legendEntry">
                  <i className="eon-debug__swatch" style={{ background: entry.css }} aria-hidden />
                  {entry.caption}
                </span>
              ))}
            </div>

            <p className="eon-debug__hint">
              Drag to pan, wheel to zoom, hover for cell values. The yellow ring marks the founder
              spawn region; cell gridlines appear when zoomed in.
            </p>
          </section>

          <aside className="eon-debug__facts">
            <h2>World</h2>
            <dl>
              <Fact label="Seed">
                {formatSeedHex(world.model.seed)}{" "}
                <span className="eon-debug__dim">({world.model.seed})</span>
              </Fact>
              <Fact label="Environment hash">
                <code>{world.model.environmentHash}</code>
              </Fact>
              <Fact label="World state hash">
                <code>{world.model.stateHash}</code>
              </Fact>
              <Fact label="Config hash">
                <code>{world.model.configHash}</code>
              </Fact>
              <Fact label="Engine">
                {world.model.engineVersion}{" "}
                <span className="eon-debug__dim">
                  config schema {world.model.configSchemaVersion}
                </span>
              </Fact>
              <Fact label="Tick">{formatCount(world.model.tick)}</Fact>
              <Fact label="Generation attempt">
                {world.model.generationAttempt}
                {world.model.generationAttempt > 0 && (
                  <span className="eon-debug__dim"> — earlier attempts were rejected</span>
                )}
              </Fact>
              <Fact label="Grid">
                {world.model.fields.size} × {world.model.fields.size} cells,{" "}
                {formatCount(world.model.fields.size * world.model.fields.cellSizeLU)} LU across
              </Fact>

              <Fact label="Land fraction">
                {formatPercentQ(world.model.summary.landFractionQ)}{" "}
                <span className="eon-debug__dim">
                  ({formatQ(world.model.summary.landFractionQ)} Q ·{" "}
                  {formatCount(world.model.summary.landCells)} land /{" "}
                  {formatCount(world.model.summary.waterCells)} water cells)
                </span>
              </Fact>
              <Fact label="Mean temperature">
                {formatCentiC(world.model.summary.meanTemperatureCentiC)}{" "}
                <span className="eon-debug__dim">
                  (range {formatCentiC(world.model.summary.minTemperatureCentiC)} …{" "}
                  {formatCentiC(world.model.summary.maxTemperatureCentiC)})
                </span>
              </Fact>
              <Fact label="Mean fertility">
                {formatQ(world.model.summary.meanFertilityQ)}{" "}
                <span className="eon-debug__dim">
                  ({formatPercentQ(world.model.summary.meanFertilityQ)} of maximum)
                </span>
              </Fact>
              <Fact label="Mean moisture">{formatQ(world.model.summary.meanMoistureQ)}</Fact>
              <Fact label="Mean elevation">{formatQ(world.model.summary.meanElevationQ)}</Fact>

              <Fact label="Plant capacity">
                {formatCount(world.model.summary.totalPlantCapacity)} units{" "}
                <span className="eon-debug__dim">
                  (max {formatCount(world.model.summary.maxPlantCapacity)} per cell)
                </span>
              </Fact>
              <Fact label="Current biomass">
                {formatCount(world.model.summary.totalPlantBiomass)} units{" "}
                <span className="eon-debug__dim">
                  ({formatPercentQ(world.model.summary.biomassFractionOfCapacityQ)} of capacity)
                </span>
              </Fact>
              <Fact label="Founder region">
                cell {formatCount(world.model.founderRegion.centerCellIndex)} at (
                {world.model.founderRegion.centerGridX}, {world.model.founderRegion.centerGridY}){" "}
                <span className="eon-debug__dim">
                  in a {formatCount(world.model.founderRegion.componentCells)}-cell landmass
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
                {world.model.summary.biomeCellCounts.map((cells, biome) => (
                  <tr key={DEBUG_BIOME_NAMES[biome] ?? biome}>
                    <th scope="row">{debugBiomeName(biome)}</th>
                    <td>{formatCount(cells)}</td>
                    <td>{((cells / world.model.summary.cellCount) * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h2>Hovered cell</h2>
            {hoveredCell === null ? (
              <p className="eon-debug__dim">Point at the map.</p>
            ) : (
              <dl>
                <Fact label="Cell">
                  {formatCount(hoveredCell)} at ({hoveredCell % world.model.fields.size},{" "}
                  {Math.floor(hoveredCell / world.model.fields.size)})
                </Fact>
                <Fact label="Biome">
                  {debugBiomeName(world.model.fields.biome[hoveredCell] as number)}
                </Fact>
                <Fact label="Elevation">
                  {formatCellValue(world.model.fields, "elevation", hoveredCell)}
                </Fact>
                <Fact label="Temperature">
                  {formatCellValue(world.model.fields, "temperature", hoveredCell)}
                </Fact>
                <Fact label="Moisture">
                  {formatCellValue(world.model.fields, "moisture", hoveredCell)}
                </Fact>
                <Fact label="Fertility">
                  {formatCellValue(world.model.fields, "fertility", hoveredCell)}
                </Fact>
                <Fact label="Plant capacity">
                  {formatCellValue(world.model.fields, "plantCapacity", hoveredCell)}
                </Fact>
                <Fact label="Current biomass">
                  {formatCellValue(world.model.fields, "plantBiomass", hoveredCell)}
                </Fact>
              </dl>
            )}
          </aside>
        </div>
      )}
    </div>
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
