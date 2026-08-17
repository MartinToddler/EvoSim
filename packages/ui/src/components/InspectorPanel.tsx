import { Fragment } from "react";
import { hueTint } from "@eon/renderer/palette";
import type { EntityDetailsDto, PhysicalPhenotypeDto, WorldDisplayDto } from "@eon/protocol";
import { formatFixed, formatInt, formatPercent, formatSigned } from "../format";

/**
 * Milestone 7 organism inspector (task H03, docs/06 §11).
 *
 * The docs' four sections, mapped to what the engine can already answer:
 * overview and history (identity, age, parent, lifetime tallies), phenotype in
 * human units, the current running costs, and a collapsible debug-style brain
 * view — the last tick's sensor inputs and intent outputs, never the 400 raw
 * weights (those stay behind an explicit future control, not a default dump).
 *
 * Values refresh at telemetry cadence while the world runs. When the organism
 * dies the panel says so and freezes its last known values rather than
 * pretending the query failed.
 */

export interface InspectorPanelProps {
  selectedEntityId: number | null;
  details: EntityDetailsDto | null;
  /** True when the last query came back with no living organism. */
  gone: boolean;
  /** True while the camera is following this organism. */
  following: boolean;
  /** Labels for the brain view; null before the world is ready. */
  display: WorldDisplayDto | null;
  onClear: () => void;
  onFocus: () => void;
  onToggleFollow: () => void;
  /** Open the species inspector for this organism's species (Milestone 8). */
  onSelectSpecies: (speciesId: number) => void;
}

function ratio(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/** See the M6 note: one decimal keeps "99.7% (juvenile)" self-consistent. */
function developmentLabel(development: number): string {
  const percent = `${(development * 100).toFixed(1)}%`;
  return development < 1 ? `${percent} (juvenile)` : percent;
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

/** Horizontal 0..1 meter; the number is always shown too (docs/06 §17). */
function Meter(props: { value: number; tone?: "energy" | "health" | "stress" }): React.JSX.Element {
  const clamped = Math.min(1, Math.max(0, props.value));
  return (
    <span className={`meter meter-${props.tone ?? "energy"}`} aria-hidden="true">
      <span className="meter-fill" style={{ width: `${(clamped * 100).toFixed(1)}%` }} />
    </span>
  );
}

/** Signed -1..1 meter growing from a centred zero, for turn and diet. */
function SignedMeter(props: { value: number }): React.JSX.Element {
  const clamped = Math.min(1, Math.max(-1, props.value));
  const half = Math.abs(clamped) * 50;
  return (
    <span className="meter meter-signed" aria-hidden="true">
      <span
        className="meter-fill"
        style={
          clamped >= 0
            ? { left: "50%", width: `${half.toFixed(1)}%` }
            : { left: `${(50 - half).toFixed(1)}%`, width: `${half.toFixed(1)}%` }
        }
      />
    </span>
  );
}

export function InspectorPanel(props: InspectorPanelProps): React.JSX.Element {
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
  const inputLabels = props.display?.brainInputLabels ?? [];
  const intentLabels = props.display?.brainIntentLabels ?? [];

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

      {details === null && !props.gone ? <p className="hint">Loading…</p> : null}
      {props.gone ? (
        <p className="hint">This organism is no longer alive. Its story stops here.</p>
      ) : null}

      {details !== null ? (
        <>
          {!props.gone ? (
            <div className="inspector-actions">
              <button
                type="button"
                aria-pressed={props.following}
                onClick={props.onToggleFollow}
                title="Keep the camera on this organism"
              >
                {props.following ? "Following ✓" : "Follow"}
              </button>
              <button type="button" onClick={props.onFocus} title="Centre the camera once">
                Centre
              </button>
            </div>
          ) : null}

          <dl>
            <dt>Species</dt>
            <dd>
              <button
                type="button"
                className="link-button"
                title="Open this species in the species inspector"
                onClick={() => {
                  props.onSelectSpecies(details.speciesId);
                }}
              >
                Species {String(details.speciesId).padStart(4, "0")}
              </button>
            </dd>
            <dt>Generation</dt>
            <dd>{formatInt(details.generation)}</dd>
            <dt>Parent</dt>
            <dd>{details.parentEntityId === 0 ? "founder" : `#${details.parentEntityId}`}</dd>
            <dt>Age</dt>
            <dd>
              {formatInt(details.ageTicks)} / {formatInt(details.maxAgeTicks)} ticks
            </dd>
            <dt>Kills</dt>
            <dd>{formatInt(details.kills)}</dd>
          </dl>

          <div className="section">
            <div className="section-title">Vitals</div>
            <dl>
              <dt>Energy</dt>
              <dd>
                <Meter
                  value={details.maxEnergy > 0 ? details.energy / details.maxEnergy : 0}
                  tone="energy"
                />
                {formatInt(Math.round(details.energy))} (
                {ratio(details.maxEnergy > 0 ? details.energy / details.maxEnergy : 0)})
              </dd>
              <dt>Health</dt>
              <dd>
                <Meter value={details.health} tone="health" />
                {ratio(details.health)}
              </dd>
              <dt>Development</dt>
              <dd>{developmentLabel(details.development)}</dd>
              <dt>Mass</dt>
              <dd>{formatInt(Math.round(details.mass))}</dd>
              <dt>Reproduction</dt>
              <dd>
                {details.reproductionCooldownTicks === 0
                  ? "ready"
                  : `cooldown ${formatInt(details.reproductionCooldownTicks)} ticks`}
              </dd>
            </dl>
          </div>

          <div className="section">
            <div className="section-title">Inherited traits</div>
            <dl>
              <dt>Diet</dt>
              <dd>{dietLabel(details.diet)}</dd>
              <dt>Body radius</dt>
              <dd>{formatFixed(details.radiusLU, 2)} LU</dd>
              <dt>Max speed</dt>
              <dd>{formatFixed(details.maxSpeedLUPerTick, 3)} LU/tick</dd>
              <dt>Vision</dt>
              <dd>
                {formatFixed(details.visionRangeLU, 1)} LU / {details.visionFovDegrees.toFixed(0)}°
              </dd>
              <dt>Attack / armor</dt>
              <dd>
                {ratio(details.attack)} / {ratio(details.armor)}
              </dd>
              <dt>Metabolic pace</dt>
              <dd>{ratio(details.metabolicPace)}</dd>
              <dt>Thermal optimum</dt>
              <dd>
                {formatFixed(details.thermalOptimumC, 1)} °C ±
                {formatFixed(details.thermalToleranceC, 1)}
              </dd>
              <dt>Maturity / lifespan</dt>
              <dd>
                {formatInt(details.maturityAgeTicks)} / {formatInt(details.maxAgeTicks)} ticks
              </dd>
            </dl>
          </div>

          <details className="section">
            <summary className="section-title">Body plan (× founder body)</summary>
            <dl>
              {PHYSICAL_ROWS.map(([label, key]) => (
                <Fragment key={key}>
                  <dt>{label}</dt>
                  <dd>{formatFactor(details.physical[key])}</dd>
                </Fragment>
              ))}
            </dl>
          </details>

          <div className="section">
            <div className="section-title">Running costs (energy/tick)</div>
            <dl>
              <dt>Basal upkeep</dt>
              <dd>{formatFixed(details.costBasalPerTick, 1)}</dd>
              <dt>Movement</dt>
              <dd>{formatFixed(details.costMovementPerTick, 1)}</dd>
              <dt>Thermal stress</dt>
              <dd>
                <Meter value={details.thermalStress} tone="stress" />
                {ratio(details.thermalStress)}
              </dd>
              <dt>Current speed</dt>
              <dd>{formatFixed(details.speedLUPerTick, 3)} LU/tick</dd>
            </dl>
          </div>

          <details className="section brain">
            <summary className="section-title">Brain (last tick)</summary>
            <div className="section-title">Intents</div>
            <dl className="brain-list">
              {details.brainIntents.map((value, index) => (
                <FragmentRow
                  key={intentLabels[index] ?? index}
                  label={intentLabels[index] ?? `output ${index}`}
                  value={value}
                  signed={index === 1}
                />
              ))}
            </dl>
            <div className="section-title">Senses</div>
            <dl className="brain-list">
              {details.brainInputs.map((value, index) => (
                <FragmentRow
                  key={inputLabels[index] ?? index}
                  label={inputLabels[index] ?? `input ${index}`}
                  value={value}
                  signed
                />
              ))}
            </dl>
          </details>

          <div className="section">
            <div className="section-title">Lifetime &amp; surroundings</div>
            <dl>
              <dt>Plant energy</dt>
              <dd>{formatInt(Math.round(details.plantEnergyEaten))}</dd>
              <dt>Meat energy</dt>
              <dd>{formatInt(Math.round(details.meatEnergyEaten))}</dd>
              <dt>Position</dt>
              <dd>
                {details.xLU.toFixed(0)}, {details.yLU.toFixed(0)}
              </dd>
              <dt>Biome</dt>
              <dd>{details.biomeName}</dd>
              <dt>Local climate</dt>
              <dd>{formatFixed(details.cellTemperatureC, 1)} °C</dd>
              <dt>Local plants</dt>
              <dd>{formatInt(Math.round(details.cellPlantBiomass))}</dd>
            </dl>
          </div>
        </>
      ) : null}
    </aside>
  );
}

/** One labelled brain value: name, signed/positive meter, exact number. */
/**
 * The physical phenotype rows, in the order a reader builds a mental picture:
 * how big the body is, what it costs, what it can do, and what it costs to
 * make another one. Labels name the *consequence*, not the morphological gene —
 * the genes are visible in the drawing.
 */
const PHYSICAL_ROWS: readonly (readonly [string, keyof PhysicalPhenotypeDto])[] = [
  ["Mass", "mass"],
  ["Energy store", "energyStore"],
  ["Basal upkeep", "basalUpkeep"],
  ["Movement cost", "movementCost"],
  ["Growth cost", "growthCost"],
  ["Top speed", "maxSpeed"],
  ["Acceleration", "acceleration"],
  ["Turn rate", "turnRate"],
  ["Speed in water", "waterSpeed"],
  ["Armor value", "armor"],
  ["Attack power", "attack"],
  ["Bite size", "biteSize"],
  ["Vision range", "visionRange"],
  ["Vision arc", "visionArc"],
  ["Thermal tolerance", "thermalTolerance"],
  ["Contact extent", "contactExtent"],
  ["Offspring cost", "offspringCost"],
];

/**
 * A body-plan multiplier.
 *
 * Shown with an explicit sign against 1.0 rather than as a bare number, because
 * the only question worth asking of these is which way the body has moved: a
 * lineage reading "1.42x (+42%)" for armor and "0.71x (-29%)" for top speed is
 * a trade-off a reader can see at a glance.
 */
function formatFactor(value: number): string {
  const percent = Math.round((value - 1) * 100);
  const sign = percent > 0 ? "+" : "";
  return `${formatFixed(value, 2)}\u00d7 (${sign}${percent}%)`;
}

function FragmentRow(props: { label: string; value: number; signed: boolean }): React.JSX.Element {
  return (
    <>
      <dt>{props.label}</dt>
      <dd>
        {props.signed ? <SignedMeter value={props.value} /> : <Meter value={props.value} />}
        <span className="brain-value">
          {props.signed ? formatSigned(props.value, 2) : formatPercent(props.value)}
        </span>
      </dd>
    </>
  );
}
