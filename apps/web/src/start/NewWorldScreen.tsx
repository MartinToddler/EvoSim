import {
  DEBUG_BIOME_NAMES,
  ENVIRONMENT_DEBUG_LAYERS,
  Q_SCALE,
  debugBiomeName,
  describeLayerLegend,
  formatCentiC,
  type EnvironmentDebugLayerId,
} from "@eon/renderer";
import { memo, useState } from "react";
import { EnvironmentFieldCanvas } from "../dev/EnvironmentFieldCanvas";
import { createDebugWorld, readDebugWorldModel, type DebugWorldModel } from "../dev/debugWorld";
import { formatSeedHex, parseSeedInput } from "../dev/seedInput";
import "../dev/devView.css";

/**
 * The New World screen (ADR 0025; docs/01 §3 "Enter/randomize seed", §9 state 2).
 *
 * Explicit seed, random seed, regenerate, a real map preview with the
 * environment layers, and a summary — all BEFORE authoritative time exists.
 * The preview constructs a full engine at tick 0 on the main thread (~100 ms, a
 * pure function of seed + config) and only reads it; nothing here ever steps
 * it. Create World hands the accepted seed to the Worker, which constructs the
 * same engine from the same seed and config — the preview's environment hash is
 * carried along so the app can PROVE the two worlds are the same map.
 *
 * Discarded previews leave no trace: no session, no Worker, no save.
 */

export interface AcceptedWorld {
  seed: number;
  name: string;
  /** The previewed map's digest; must equal the authoritative world's. */
  environmentHash: string;
}

export interface NewWorldScreenProps {
  initialSeed: number;
  onCreate: (accepted: AcceptedWorld) => void;
  onBack: () => void;
}

type PreviewState =
  { status: "ready"; model: DebugWorldModel } | { status: "failed"; seed: number; message: string };

function generatePreview(seed: number): PreviewState {
  const result = createDebugWorld(seed);
  if (!result.ok) {
    return { status: "failed", seed, message: result.error };
  }
  // The engine handle is read once and dropped: the preview is the immutable
  // model, and the authoritative world will be built fresh by the Worker.
  return { status: "ready", model: readDebugWorldModel(result.value) };
}

/** `Math.random` CHOOSES a seed; the world stays a pure function of it. */
function randomSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000);
}

/** The preview map has no hovered-cell inspector; a stable no-op keeps it memoized. */
function noHover(): void {}

function defaultName(seed: number): string {
  return `World ${formatSeedHex(seed)}`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatPercentQ(valueQ: number): string {
  return `${((valueQ * 100) / Q_SCALE).toFixed(1)}%`;
}

export function NewWorldScreen(props: NewWorldScreenProps): React.JSX.Element {
  const [preview, setPreview] = useState<PreviewState>(() => generatePreview(props.initialSeed));
  const [seedText, setSeedText] = useState(() => formatSeedHex(props.initialSeed));
  const [inputError, setInputError] = useState<string | null>(null);
  const [layer, setLayer] = useState<EnvironmentDebugLayerId>("biome");
  const [name, setName] = useState(() => defaultName(props.initialSeed));
  const [nameEdited, setNameEdited] = useState(false);

  const model = preview.status === "ready" ? preview.model : null;

  const generate = (seed: number): void => {
    setSeedText(formatSeedHex(seed));
    setInputError(null);
    setPreview(generatePreview(seed));
    if (!nameEdited) {
      setName(defaultName(seed));
    }
  };

  const regenerate = (event?: React.FormEvent<HTMLFormElement>): void => {
    event?.preventDefault();
    const parsed = parseSeedInput(seedText);
    if (!parsed.ok) {
      setInputError(parsed.error);
      return;
    }
    generate(parsed.value);
  };

  const create = (): void => {
    if (model === null) {
      return;
    }
    props.onCreate({
      seed: model.seed,
      name: name.trim() === "" ? defaultName(model.seed) : name.trim(),
      environmentHash: model.environmentHash,
    });
  };

  return (
    <div className="start-screen new-world" data-testid="new-world-screen">
      <header className="start-screen__header">
        <h1>New World</h1>
        <p>
          Inspect the world a seed produces before starting it. Nothing runs yet: time begins only
          after you create the world and press Play.
        </p>
      </header>

      <section className="new-world__controls" aria-label="Seed">
        <form className="new-world__row" onSubmit={regenerate}>
          <label htmlFor="new-world-seed">Seed</label>
          <input
            id="new-world-seed"
            data-testid="new-world-seed"
            value={seedText}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setSeedText(event.target.value);
            }}
          />
          <button type="submit" data-testid="new-world-regenerate">
            Regenerate
          </button>
          <button
            type="button"
            data-testid="new-world-random"
            onClick={() => {
              generate(randomSeed());
            }}
          >
            Random seed
          </button>
          <span className="start-screen__hint">
            Decimal or 0x-hex, uint32. Same seed, config and engine always give the same world.
          </span>
        </form>

        <div className="new-world__row">
          <label htmlFor="new-world-name">Name</label>
          <input
            id="new-world-name"
            data-testid="new-world-name"
            value={name}
            maxLength={80}
            onChange={(event) => {
              setName(event.target.value);
              setNameEdited(true);
            }}
          />
          <button
            type="button"
            className="start-screen__primary"
            disabled={model === null}
            onClick={create}
            data-testid="new-world-create"
          >
            Create World
          </button>
          <button type="button" onClick={props.onBack} data-testid="new-world-back">
            Back
          </button>
        </div>
      </section>

      {inputError !== null ? (
        <p className="start-screen__error" role="alert">
          {inputError}
        </p>
      ) : null}

      {preview.status === "failed" ? (
        <section className="start-screen__error" role="alert">
          <strong>
            No valid world for seed {formatSeedHex(preview.seed)}. Nothing was generated — try
            another seed.
          </strong>
          <pre>{preview.message}</pre>
        </section>
      ) : model === null ? null : (
        <div className="new-world__body">
          <section className="new-world__map" aria-label="Map preview">
            <fieldset className="eon-debug__layers">
              <legend>Layer</legend>
              {ENVIRONMENT_DEBUG_LAYERS.map((descriptor) => (
                <label key={descriptor.id} className="eon-debug__layerOption">
                  <input
                    type="radio"
                    name="new-world-layer"
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

            <EnvironmentFieldCanvas
              fields={model.fields}
              layer={layer}
              worldKey={model.worldKey}
              markerGridX={model.founderRegion.centerGridX}
              markerGridY={model.founderRegion.centerGridY}
              markerRadiusCells={model.founderRadiusCells}
              recenterToken={0}
              onHoverCellChange={noHover}
            />

            <div className="eon-debug__legend" aria-label="Legend">
              {describeLayerLegend(model.fields, layer).map((entry) => (
                <span key={entry.caption} className="eon-debug__legendEntry">
                  <i className="eon-debug__swatch" style={{ background: entry.css }} aria-hidden />
                  {entry.caption}
                </span>
              ))}
            </div>
          </section>

          <PreviewSummary model={model} />
        </div>
      )}
    </div>
  );
}

/** Environment summary: the facts a player weighs before accepting a map. */
const PreviewSummary = memo(function PreviewSummary({ model }: { model: DebugWorldModel }) {
  return (
    <aside className="new-world__facts" aria-label="Environment summary">
      <h2>Environment</h2>
      <dl>
        <div className="eon-debug__fact">
          <dt>Seed</dt>
          <dd data-testid="new-world-seed-hex">{formatSeedHex(model.seed)}</dd>
        </div>
        <div className="eon-debug__fact">
          <dt>Map digest</dt>
          <dd>
            <code data-testid="new-world-env-hash">{model.environmentHash}</code>
          </dd>
        </div>
        <div className="eon-debug__fact">
          <dt>Engine</dt>
          <dd>{model.engineVersion}</dd>
        </div>
        <div className="eon-debug__fact">
          <dt>Land</dt>
          <dd>
            {formatPercentQ(model.summary.landFractionQ)} ({formatCount(model.summary.landCells)}{" "}
            cells)
          </dd>
        </div>
        <div className="eon-debug__fact">
          <dt>Temperature</dt>
          <dd>
            {formatCentiC(model.summary.minTemperatureCentiC)} …{" "}
            {formatCentiC(model.summary.maxTemperatureCentiC)}
          </dd>
        </div>
        <div className="eon-debug__fact">
          <dt>Plant capacity</dt>
          <dd>{formatCount(model.summary.totalPlantCapacity)} units</dd>
        </div>
        <div className="eon-debug__fact">
          <dt>Founder region</dt>
          <dd>{formatCount(model.founderRegion.componentCells)}-cell landmass</dd>
        </div>
      </dl>

      <h2>Biomes</h2>
      <table className="eon-debug__table">
        <tbody>
          {model.summary.biomeCellCounts.map((cells, biome) =>
            cells === 0 ? null : (
              <tr key={DEBUG_BIOME_NAMES[biome] ?? biome}>
                <th scope="row">{debugBiomeName(biome)}</th>
                <td>{((cells / model.summary.cellCount) * 100).toFixed(1)}%</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </aside>
  );
});
