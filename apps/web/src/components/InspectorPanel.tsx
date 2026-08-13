import { hueTint } from "@eon/renderer";
import type { EntityDetailsDto } from "@eon/protocol";

/**
 * Minimal selected-organism readout (task G09).
 *
 * This is the "basic selected entity query" M6 asks for, not the Milestone 7
 * inspector: no gene bars, no cost breakdown, no brain view, no history. It
 * exists to prove the query path end to end — click a moving organism, get its
 * authoritative state back from the Worker — and to make the world legible
 * enough to watch.
 *
 * Values refresh at telemetry cadence while the world runs, so a selected
 * organism visibly ages, eats and loses energy.
 */

export interface InspectorPanelProps {
  selectedEntityId: number | null;
  details: EntityDetailsDto | null;
  /** True when the last query came back with no living organism. */
  gone: boolean;
  onClear: () => void;
  onFocus: () => void;
}

function ratio(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function dietLabel(diet: number): string {
  if (diet <= -0.33) {
    return `herbivore (${diet.toFixed(2)})`;
  }
  if (diet >= 0.33) {
    return `carnivore (+${diet.toFixed(2)})`;
  }
  return `omnivore (${diet >= 0 ? "+" : ""}${diet.toFixed(2)})`;
}

export function InspectorPanel(props: InspectorPanelProps): React.JSX.Element | null {
  if (props.selectedEntityId === null) {
    return (
      <aside className="inspector">
        <h2>Selection</h2>
        <p className="hint">
          Click an organism to inspect it. Drag to pan, scroll or pinch to zoom.
        </p>
      </aside>
    );
  }

  const details = props.details;
  return (
    <aside className="inspector">
      <h2>
        <span>
          {details !== null ? (
            <span
              className="swatch"
              style={{
                background: `#${hueTint(details.hueDegrees).toString(16).padStart(6, "0")}`,
              }}
              aria-hidden="true"
            />
          ) : null}
          Organism #{props.selectedEntityId}
        </span>
        <button type="button" onClick={props.onClear} title="Clear the selection">
          ✕
        </button>
      </h2>

      {props.gone || details === null ? (
        <p className="hint">
          {props.gone ? "This organism is no longer alive. Its history stops here." : "Loading…"}
        </p>
      ) : (
        <>
          <dl>
            <dt>Species</dt>
            <dd>{details.speciesId}</dd>
            <dt>Generation</dt>
            <dd>{details.generation}</dd>
            <dt>Parent</dt>
            <dd>{details.parentEntityId === 0 ? "founder" : `#${details.parentEntityId}`}</dd>
            <dt>Age</dt>
            <dd>
              {details.ageTicks.toLocaleString("en-US")} /{" "}
              {details.maxAgeTicks.toLocaleString("en-US")} ticks
            </dd>
            <dt>Energy</dt>
            <dd>
              {Math.round(details.energy).toLocaleString("en-US")} (
              {ratio(details.maxEnergy > 0 ? details.energy / details.maxEnergy : 0)})
            </dd>
            <dt>Health</dt>
            <dd>{ratio(details.health)}</dd>
            <dt>Development</dt>
            <dd>
              {ratio(details.development)}
              {details.development < 1 ? " (juvenile)" : ""}
            </dd>
          </dl>

          <div className="section">
            <div className="section-title">Inherited traits</div>
            <dl>
              <dt>Diet</dt>
              <dd>{dietLabel(details.diet)}</dd>
              <dt>Body radius</dt>
              <dd>{details.radiusLU.toFixed(2)} LU</dd>
              <dt>Max speed</dt>
              <dd>{details.maxSpeedLUPerTick.toFixed(3)} LU/tick</dd>
              <dt>Vision</dt>
              <dd>
                {details.visionRangeLU.toFixed(1)} LU / {details.visionFovDegrees.toFixed(0)}°
              </dd>
              <dt>Attack / armor</dt>
              <dd>
                {ratio(details.attack)} / {ratio(details.armor)}
              </dd>
              <dt>Thermal optimum</dt>
              <dd>
                {details.thermalOptimumC.toFixed(1)} °C ±{details.thermalToleranceC.toFixed(1)}
              </dd>
            </dl>
          </div>

          <div className="section">
            <div className="section-title">Lifetime &amp; surroundings</div>
            <dl>
              <dt>Plant energy</dt>
              <dd>{Math.round(details.plantEnergyEaten).toLocaleString("en-US")}</dd>
              <dt>Meat energy</dt>
              <dd>{Math.round(details.meatEnergyEaten).toLocaleString("en-US")}</dd>
              <dt>Kills</dt>
              <dd>{details.kills}</dd>
              <dt>Position</dt>
              <dd>
                {details.xLU.toFixed(0)}, {details.yLU.toFixed(0)}
              </dd>
              <dt>Biome</dt>
              <dd>{details.biomeName}</dd>
              <dt>Local climate</dt>
              <dd>{details.cellTemperatureC.toFixed(1)} °C</dd>
            </dl>
          </div>

          <div className="section">
            <button type="button" onClick={props.onFocus}>
              Centre camera
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
