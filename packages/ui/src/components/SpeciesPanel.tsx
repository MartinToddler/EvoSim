import type { SpeciesDetailsDto, TreeSnapshotDto, WorldDisplayDto } from "@eon/protocol";
import { CHART_SERIES_COLORS, TimeSeriesChart } from "../charts/TimeSeriesChart";
import { formatCompact, formatInt, formatYear } from "../format";

/**
 * Milestone 8 species panel (task I08, docs/06 §12): the living species list
 * and the species inspector.
 *
 * Naming honesty (docs/05 §2): these are automatically detected evolutionary
 * lineages — morphospecies clustered by persistent phenotype divergence — not
 * reproductive-isolation species, and the header tooltip says so.
 */

export interface SpeciesPanelProps {
  /** Latest registry snapshot; null before the first tree arrives. */
  tree: TreeSnapshotDto | null;
  selectedSpeciesId: number | null;
  /** Inspector detail for the selected species; null while loading. */
  details: SpeciesDetailsDto | null;
  /** Labels; null before the world is ready. */
  display: WorldDisplayDto | null;
  ticksPerSimYear: number;
  onSelectSpecies: (speciesId: number | null) => void;
  onOpenTree: () => void;
  onClose: () => void;
}

/** MVP fallback naming (docs/05 §9): "Species 0007". */
export function speciesName(id: number): string {
  return `Species ${String(id).padStart(4, "0")}`;
}

/** Observed diet split as a label, from lifetime intake (docs/06 §12). */
function dietFractionLabel(plant: number, meat: number): string {
  const total = plant + meat;
  if (total <= 0) {
    return "no intake observed";
  }
  const meatShare = meat / total;
  return `${((1 - meatShare) * 100).toFixed(0)}% plants / ${(meatShare * 100).toFixed(0)}% meat`;
}

function statusLabel(endReason: number, display: WorldDisplayDto | null): string {
  return display?.speciesEndReasonLabels[endReason] ?? String(endReason);
}

/** One row of the species list. */
function SpeciesRow(props: {
  id: number;
  population: number;
  endReason: number;
  carnivore: boolean;
  selected: boolean;
  display: WorldDisplayDto | null;
  onSelect: (id: number) => void;
}): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        className={`species-row${props.selected ? " is-selected" : ""}`}
        aria-pressed={props.selected}
        onClick={() => {
          props.onSelect(props.id);
        }}
      >
        <span className="species-row-name">
          {speciesName(props.id)}
          {props.carnivore ? (
            <span className="species-badge" title="Detected carnivore lineage">
              🥩
            </span>
          ) : null}
        </span>
        <span className="species-row-population">
          {props.endReason === 0
            ? formatInt(props.population)
            : statusLabel(props.endReason, props.display)}
        </span>
      </button>
    </li>
  );
}

/** Horizontal normalized trait bar with its label and value. */
function TraitBar(props: { label: string; value: number; origin: number }): React.JSX.Element {
  const width = Math.min(1, Math.max(0, props.value)) * 100;
  const originLeft = Math.min(1, Math.max(0, props.origin)) * 100;
  return (
    <div className="trait-bar-row">
      <span className="trait-bar-label">{props.label}</span>
      <span className="trait-bar" aria-hidden="true">
        <span className="trait-bar-fill" style={{ width: `${width.toFixed(1)}%` }} />
        <span
          className="trait-bar-origin"
          title="Value at the species' origin"
          style={{ left: `${originLeft.toFixed(1)}%` }}
        />
      </span>
      <span className="trait-bar-value">{props.value.toFixed(2)}</span>
    </div>
  );
}

export function SpeciesPanel(props: SpeciesPanelProps): React.JSX.Element {
  const tree = props.tree;
  const details = props.details;
  const living = tree?.species.filter((species) => species.endReason === 0) ?? [];
  const ended = tree?.species.filter((species) => species.endReason !== 0) ?? [];

  return (
    <aside className="species-panel" aria-label="Species">
      <div className="panel-title-row">
        <h2 title="Automatically detected evolutionary lineages: clusters of persistent phenotype divergence, not reproductive isolation">
          Species
        </h2>
        <div className="panel-title-actions">
          <button type="button" onClick={props.onOpenTree} title="Open the Tree of Life">
            Tree
          </button>
          <button type="button" onClick={props.onClose} aria-label="Close species panel">
            ✕
          </button>
        </div>
      </div>

      {tree === null ? (
        <p className="hint">Waiting for the first species snapshot…</p>
      ) : (
        <>
          <div className="section-title">
            Living ({living.length}) · ended ({ended.length})
          </div>
          <ul className="species-list">
            {living.map((species) => (
              <SpeciesRow
                key={species.id}
                id={species.id}
                population={species.population}
                endReason={species.endReason}
                carnivore={species.carnivoreDetected}
                selected={props.selectedSpeciesId === species.id}
                display={props.display}
                onSelect={props.onSelectSpecies}
              />
            ))}
            {ended.map((species) => (
              <SpeciesRow
                key={species.id}
                id={species.id}
                population={species.population}
                endReason={species.endReason}
                carnivore={species.carnivoreDetected}
                selected={props.selectedSpeciesId === species.id}
                display={props.display}
                onSelect={props.onSelectSpecies}
              />
            ))}
          </ul>
        </>
      )}

      {props.selectedSpeciesId !== null ? (
        details === null ? (
          <p className="hint">Loading {speciesName(props.selectedSpeciesId)}…</p>
        ) : (
          <div className="species-detail">
            <div className="section-title-row">
              <div className="section-title">
                {speciesName(details.id)}
                {details.carnivoreDetected ? (
                  <span className="species-badge" title="Detected carnivore lineage">
                    🥩
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => {
                  props.onSelectSpecies(null);
                }}
                aria-label="Clear species selection"
              >
                ✕
              </button>
            </div>

            <dl>
              <dt>Status</dt>
              <dd>
                {statusLabel(details.endReason, props.display)}
                {details.endReason !== 0
                  ? ` at ${formatYear(details.endTick, props.ticksPerSimYear)}`
                  : ""}
              </dd>
              <dt>Origin</dt>
              <dd>
                {formatYear(details.originTick, props.ticksPerSimYear)}
                {details.parentSpeciesId === 0 ? " (founder lineage)" : ""}
              </dd>
              {details.parentSpeciesId !== 0 ? (
                <>
                  <dt>Parent</dt>
                  <dd>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        props.onSelectSpecies(details.parentSpeciesId);
                      }}
                    >
                      {speciesName(details.parentSpeciesId)}
                    </button>
                  </dd>
                </>
              ) : null}
              {details.childIds.length > 0 ? (
                <>
                  <dt>Daughters</dt>
                  <dd>
                    {details.childIds.map((childId, index) => (
                      <span key={childId}>
                        {index > 0 ? ", " : ""}
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => {
                            props.onSelectSpecies(childId);
                          }}
                        >
                          {speciesName(childId)}
                        </button>
                      </span>
                    ))}
                  </dd>
                </>
              ) : null}
              <dt>Population</dt>
              <dd>{formatInt(details.population)}</dd>
              <dt>Founder</dt>
              <dd>
                #{details.founderEntityId} (gen {formatInt(details.generationAtOrigin)})
              </dd>
              <dt>Births / deaths</dt>
              <dd>
                {formatCompact(details.totalBirths)} / {formatCompact(details.totalDeaths)}
              </dd>
              <dt>Kills</dt>
              <dd>{formatCompact(details.totalKills)}</dd>
              <dt>Observed diet</dt>
              <dd>{dietFractionLabel(details.plantEnergyConsumed, details.meatEnergyConsumed)}</dd>
              {details.endReason === 0 ? (
                <>
                  <dt>Mean age</dt>
                  <dd>{formatInt(details.meanAgeTicks)} ticks</dd>
                  <dt>Mean energy</dt>
                  <dd>{`${(details.meanEnergyFraction * 100).toFixed(0)}%`}</dd>
                </>
              ) : null}
              {details.candidatePasses > 0 ? (
                <>
                  <dt>Split forming</dt>
                  <dd title="Consecutive analyses the pending bifurcation has survived">
                    {details.candidatePasses} / {details.stabilityIntervalsRequired} analyses
                  </dd>
                </>
              ) : null}
            </dl>

            {details.series.ticks.length >= 2 ? (
              <div className="species-charts">
                <TimeSeriesChart
                  title="Population"
                  ticksPerSimYear={props.ticksPerSimYear}
                  formatValue={formatInt}
                  series={[
                    {
                      label: speciesName(details.id),
                      color: CHART_SERIES_COLORS[0] as string,
                      points: details.series.ticks.map((tick, index) => ({
                        x: tick,
                        y: details.series.population[index] as number,
                      })),
                    },
                  ]}
                />
                <TimeSeriesChart
                  title="Mean size / speed"
                  ticksPerSimYear={props.ticksPerSimYear}
                  formatValue={(value) => value.toFixed(2)}
                  yDomain={[0, 1]}
                  series={[
                    {
                      label: "size",
                      color: CHART_SERIES_COLORS[1] as string,
                      points: details.series.ticks.map((tick, index) => ({
                        x: tick,
                        y: details.series.meanSize[index] as number,
                      })),
                    },
                    {
                      label: "speed",
                      color: CHART_SERIES_COLORS[2] as string,
                      points: details.series.ticks.map((tick, index) => ({
                        x: tick,
                        y: details.series.meanSpeed[index] as number,
                      })),
                    },
                  ]}
                />
                <TimeSeriesChart
                  title="Mean diet"
                  ticksPerSimYear={props.ticksPerSimYear}
                  formatValue={(value) => value.toFixed(2)}
                  yDomain={[-1, 1]}
                  referenceY={0}
                  series={[
                    {
                      label: "diet",
                      color: CHART_SERIES_COLORS[3] as string,
                      points: details.series.ticks.map((tick, index) => ({
                        x: tick,
                        y: details.series.meanDiet[index] as number,
                      })),
                    },
                  ]}
                />
              </div>
            ) : (
              <p className="hint">Charts appear after two statistics samples.</p>
            )}

            {props.display !== null ? (
              <div className="section">
                <div
                  className="section-title"
                  title="Mean member phenotype, normalized per dimension; the notch marks the origin value"
                >
                  Trait centroid
                </div>
                {details.centroidTraits.map((value, dimension) => (
                  <TraitBar
                    key={props.display?.traitDimensionLabels[dimension] ?? dimension}
                    label={props.display?.traitDimensionLabels[dimension] ?? String(dimension)}
                    value={value}
                    origin={details.originCentroid[dimension] as number}
                  />
                ))}
              </div>
            ) : null}
          </div>
        )
      ) : (
        <p className="hint">Select a species to inspect it.</p>
      )}
    </aside>
  );
}
