import { useMemo } from "react";
import type { TelemetryDto, WorldDisplayDto } from "@eon/protocol";
import { formatCompact, formatFixed, formatInt, formatSigned } from "../format";
import type { StatsHistory } from "../charts/StatsHistory";
import { CHART_SERIES_COLORS, TimeSeriesChart } from "../charts/TimeSeriesChart";

/**
 * Global statistics panel (task H04, docs/06 §15, docs/05 §10).
 *
 * Every chart draws from the bounded {@link StatsHistory} that accumulates the
 * 2 Hz telemetry stream — never from render snapshots, never from per-organism
 * arrays. The `revision` prop (the current tick) is what tells memoization the
 * history object's contents moved, since the object itself is deliberately
 * long-lived and mutable.
 *
 * Births and deaths are plotted as rates per 1 000 ticks derived from the
 * cumulative counters, so the chart stays meaningful across every speed —
 * including MAX, where one telemetry sample can span thousands of ticks.
 */

/** Births/deaths are normalized to events per this many ticks. */
const RATE_WINDOW_TICKS = 1000;

export interface StatsPanelProps {
  history: StatsHistory;
  /** Current tick — bumps memoized chart data when history has new content. */
  revision: number;
  telemetry: TelemetryDto | null;
  display: WorldDisplayDto | null;
  ticksPerSimYear: number;
}

export function StatsPanel(props: StatsPanelProps): React.JSX.Element {
  const { history, revision, ticksPerSimYear } = props;

  const data = useMemo(
    () => ({
      population: history.series("population"),
      plantBiomass: history.series("plantBiomass"),
      organismMass: history.series("organismMass"),
      births: history.rateSeries("totalBirths", RATE_WINDOW_TICKS),
      deaths: history.rateSeries("totalDeaths", RATE_WINDOW_TICKS),
      meanDiet: history.series("meanDiet"),
      meanSpeed: history.series("meanSpeedLUPerTick"),
      meanVision: history.series("meanVisionLU"),
      meanRadius: history.series("meanAdultRadiusLU"),
      meanEnergy: history.series("meanEnergyFraction"),
    }),
    // The history object mutates in place at telemetry cadence; revision is
    // its change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history, revision],
  );

  const telemetry = props.telemetry;
  const deathsByCause = telemetry?.deathsByCause ?? [];
  const causeLabels = props.display?.deathCauseLabels ?? [];

  return (
    <section className="stats-panel" aria-label="Global statistics">
      <div className="stats-summary">
        <span>
          Births <strong>{formatInt(telemetry?.totalBirths ?? 0)}</strong>
        </span>
        <span>
          Deaths <strong>{formatInt(telemetry?.totalDeaths ?? 0)}</strong>
        </span>
        <span>
          Carcasses <strong>{formatInt(telemetry?.carcassCount ?? 0)}</strong>
        </span>
        <span>
          Organism biomass <strong>{formatCompact(telemetry?.organismMass ?? 0)}</strong>
        </span>
        <span title="Deaths by cause, lifetime totals">
          {deathsByCause
            .map((count, index) => ({ count, label: causeLabels[index] ?? `cause ${index}` }))
            .filter((cause) => cause.count > 0 && cause.label !== "none")
            .map((cause) => `${cause.label} ${formatInt(cause.count)}`)
            .join(" · ")}
        </span>
      </div>

      <div className="chart-grid">
        <TimeSeriesChart
          title="Population"
          ticksPerSimYear={ticksPerSimYear}
          formatValue={formatInt}
          series={[
            {
              label: "population",
              color: CHART_SERIES_COLORS[0] as string,
              points: data.population,
            },
          ]}
        />
        <TimeSeriesChart
          title="Plant biomass"
          ticksPerSimYear={ticksPerSimYear}
          formatValue={formatCompact}
          series={[
            {
              label: "plant biomass",
              color: CHART_SERIES_COLORS[0] as string,
              points: data.plantBiomass,
            },
          ]}
        />
        <TimeSeriesChart
          title={`Births & deaths / ${formatInt(RATE_WINDOW_TICKS)} ticks`}
          ticksPerSimYear={ticksPerSimYear}
          formatValue={(value) => formatFixed(value, 1)}
          series={[
            { label: "births", color: CHART_SERIES_COLORS[0] as string, points: data.births },
            { label: "deaths", color: CHART_SERIES_COLORS[1] as string, points: data.deaths },
          ]}
        />
        <TimeSeriesChart
          title="Mean diet (herbivore − / carnivore +)"
          ticksPerSimYear={ticksPerSimYear}
          formatValue={(value) => formatSigned(value, 2)}
          yDomain={[-1, 1]}
          referenceY={0}
          series={[
            { label: "mean diet", color: CHART_SERIES_COLORS[2] as string, points: data.meanDiet },
          ]}
        />
        <TimeSeriesChart
          title="Mean top speed (LU/tick)"
          ticksPerSimYear={ticksPerSimYear}
          formatValue={(value) => formatFixed(value, 3)}
          series={[
            {
              label: "mean speed",
              color: CHART_SERIES_COLORS[0] as string,
              points: data.meanSpeed,
            },
          ]}
        />
        <TimeSeriesChart
          title="Mean vision range (LU)"
          ticksPerSimYear={ticksPerSimYear}
          formatValue={(value) => formatFixed(value, 1)}
          series={[
            {
              label: "mean vision",
              color: CHART_SERIES_COLORS[0] as string,
              points: data.meanVision,
            },
          ]}
        />
        <TimeSeriesChart
          title="Mean adult radius (LU)"
          ticksPerSimYear={ticksPerSimYear}
          formatValue={(value) => formatFixed(value, 2)}
          series={[
            {
              label: "mean radius",
              color: CHART_SERIES_COLORS[0] as string,
              points: data.meanRadius,
            },
          ]}
        />
        <TimeSeriesChart
          title="Mean energy reserve"
          ticksPerSimYear={ticksPerSimYear}
          formatValue={(value) => `${(value * 100).toFixed(0)}%`}
          yDomain={[0, 1]}
          series={[
            {
              label: "mean energy",
              color: CHART_SERIES_COLORS[0] as string,
              points: data.meanEnergy,
            },
          ]}
        />
      </div>
    </section>
  );
}
