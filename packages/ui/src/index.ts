/**
 * @eon/ui — React app chrome for the observation UI (Milestone 7, tasks
 * H01–H06; docs/10 §1).
 *
 * React receives only low-frequency telemetry, selected-entity details and
 * world metadata — never high-frequency organism positions (CLAUDE.md React
 * boundary). Components here render DTOs from `@eon/protocol` and raise plain
 * callbacks; the app (`apps/web`) owns the session and the Worker. Nothing in
 * this package can reach the engine: its only workspace dependencies are the
 * protocol and the renderer's colour palette.
 */

export { StatsHistory, type SeriesPoint, type StatsSample } from "./charts/StatsHistory";
export {
  CHART_SERIES_COLORS,
  TimeSeriesChart,
  type ChartSeries,
  type TimeSeriesChartProps,
} from "./charts/TimeSeriesChart";
export { InspectorPanel, type InspectorPanelProps } from "./components/InspectorPanel";
export { LayersPanel, type LayersPanelProps } from "./components/LayersPanel";
export { SpeciesPanel, speciesName, type SpeciesPanelProps } from "./components/SpeciesPanel";
export { StatsPanel, type StatsPanelProps } from "./components/StatsPanel";
export { TimelinePanel, type TimelinePanelProps } from "./components/TimelinePanel";
export { ToolsPanel, type ToolSelection, type ToolsPanelProps } from "./components/ToolsPanel";
export { TopBar, type TopBarProps } from "./components/TopBar";
export { TreePanel, type TreePanelProps } from "./components/TreePanel";
export {
  formatCompact,
  formatFixed,
  formatInt,
  formatPercent,
  formatSigned,
  formatYear,
} from "./format";
