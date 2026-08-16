import { useCallback, useState } from "react";
import { formatInt } from "../format";

/**
 * Historical navigation panel (Milestone 11, tasks K07–K10; docs/06 §§13, 29–30;
 * corrected by ADR 0025).
 *
 * Three states, and the panel has to make which one you are in unmistakable:
 * the present, a reconstruction in flight, and a read-only preview of an
 * earlier tick.
 *
 * ## Dragging selects; a button rewinds
 *
 * docs/06 §13: "Dragging timeline only selects time; explicit action starts
 * rewind." The scrubber keeps a local selection and does nothing else — no
 * pointer-up, key-up or blur ever launches a replay, because releasing a
 * slider handle is not an explicit action. The explicit action is the
 * "View this time" button, which names what it is about to do.
 *
 * ## The offered range is the reconstructable range
 *
 * A rewind needs a stored save at or before its target (ADR 0018 §7), so the
 * scrubber's lower bound is the EARLIEST STORED SAVE, not the world's logical
 * origin. A legacy world whose first save came late cannot reach the ticks
 * before it; those are stated as unavailable rather than offered and failed.
 * Worlds created through the New World flow always carry a tick-0 baseline
 * save, so for them the two bounds coincide.
 *
 * ## Dependency-free, like the other panels
 *
 * Plain view models and callbacks; no engine, protocol or storage types.
 */

export interface HistoryPanelProps {
  mode: "live" | "reconstructing" | "historical";
  /** Tick of the live world. The present, and the top of the scrubber's range. */
  presentTick: number;
  /** Earliest tick this world can reach: 0, or the branch point for a branch. */
  originTick: number;
  /** Tick being previewed, or null in the present. */
  historicalTick: number | null;
  progress: { ticksReplayed: number; ticksTotal: number } | null;
  /** Ticks with a stored save, ascending. Rewinds replay forward from these. */
  saveTicks: readonly number[];
  message: string;
  failed: boolean;
  /**
   * False when the world has never been saved. Rewinding needs a save to replay
   * from, so the panel explains that rather than offering a control that cannot
   * work.
   */
  canRewind: boolean;
  onRewind: (tick: number) => void;
  onReturnToPresent: () => void;
  onBranch: (name: string) => void;
}

function progressPercent(replayed: number, total: number): number {
  if (total <= 0) {
    return 100;
  }
  return Math.min(100, Math.max(0, (replayed / total) * 100));
}

/** How many save chips are shown before the rest collapse into a count. */
const MAX_SAVE_CHIPS = 10;

/**
 * The tick "View this time" would reconstruct, or null when there is nothing
 * to do.
 *
 * A selection is only ever offered inside the reconstructable range, and the
 * clamp is what makes that true across a WORLD SWITCH: the panel keeps its
 * local selection while it stays mounted, and a branch or a loaded world can
 * have a different floor and a different present. Unclamped, a selection made
 * in the previous world could offer a tick the new one cannot reach, and the
 * commit would fail with an error rather than never being offered.
 *
 * Exported because it is the panel's one piece of real logic; the component
 * itself is markup, and the static-markup tests cannot drive a slider.
 */
export function viewTargetFor(bounds: {
  selected: number | null;
  minTick: number;
  maxTick: number;
  /** The tick already on screen: the previewed one, or the present. */
  shownTick: number;
}): number | null {
  if (bounds.selected === null) {
    return null;
  }
  const clamped = Math.min(bounds.maxTick, Math.max(bounds.minTick, bounds.selected));
  return clamped === bounds.shownTick ? null : clamped;
}

export function HistoryPanel(props: HistoryPanelProps): React.JSX.Element {
  const { mode, presentTick, originTick, historicalTick, progress, saveTicks } = props;
  const busy = mode === "reconstructing";
  const previewing = mode === "historical";

  const [selected, setSelected] = useState<number | null>(null);
  const [branchName, setBranchName] = useState("");

  // The reconstructable floor: the earliest stored save. Ticks between the
  // world's logical origin and this save exist but cannot be rebuilt, and are
  // therefore not offered (ADR 0018 §7).
  const earliestSaveTick = saveTicks.length > 0 ? (saveTicks[0] as number) : null;
  const minTick = earliestSaveTick ?? originTick;
  const maxTick = Math.max(minTick, presentTick);
  const rewindable = props.canRewind && earliestSaveTick !== null;

  // What the handle points at: the tick being dragged, else the previewed tick,
  // else the present.
  const position = Math.min(maxTick, Math.max(minTick, selected ?? historicalTick ?? presentTick));

  // The tick "View this time" would reconstruct. Nothing to do when it already
  // is the tick on screen (the previewed tick, or the present in live mode).
  const shownTick = historicalTick ?? presentTick;
  const viewTarget = viewTargetFor({ selected, minTick, maxTick, shownTick });

  const viewSelected = useCallback(() => {
    if (viewTarget === null) {
      return;
    }
    setSelected(null);
    props.onRewind(viewTarget);
  }, [viewTarget, props]);

  const span = maxTick - minTick;

  return (
    <section className="panel history-panel" aria-label="History">
      <header className="panel__header">
        <h2>History</h2>
        <span className={previewing ? "history-panel__badge" : "history-panel__badge--live"}>
          {previewing ? "Historical preview — read only" : busy ? "Reconstructing…" : "Live"}
        </span>
      </header>

      {previewing ? (
        <p className="history-panel__notice" role="status">
          Viewing tick {formatInt(historicalTick ?? 0)} of {formatInt(presentTick)}. The world is
          paused and interventions are disabled. Branch from this tick to change what happens next.
        </p>
      ) : null}

      {!rewindable ? (
        <p className="history-panel__notice">
          Save this world to explore its history: a rewind replays from the nearest save.
        </p>
      ) : null}

      {rewindable && earliestSaveTick !== null && earliestSaveTick > originTick ? (
        <p className="history-panel__notice" data-testid="history-unavailable-note">
          History before tick {formatInt(earliestSaveTick)} was not stored for this world and cannot
          be viewed. The earliest stored save is the earliest reachable time.
        </p>
      ) : null}

      <label className="history-panel__scrubber">
        <span className="visually-hidden">Timeline — drag to select a time</span>
        <input
          type="range"
          min={minTick}
          max={maxTick}
          step={1}
          value={position}
          disabled={busy || !rewindable || span <= 0}
          list="history-panel-saves"
          onChange={(event) => {
            // Selection only. The explicit action is the button below
            // (docs/06 §13) — no pointer or key release ever starts a replay.
            setSelected(Number(event.target.value));
          }}
          aria-valuetext={`tick ${formatInt(position)}`}
          data-testid="history-scrubber"
        />
        <datalist id="history-panel-saves">
          {saveTicks.map((tick) => (
            <option key={tick} value={tick} />
          ))}
        </datalist>
      </label>

      <div className="history-panel__range">
        <span>earliest {formatInt(minTick)}</span>
        <span data-testid="history-position">tick {formatInt(position)}</span>
        <span>now {formatInt(presentTick)}</span>
      </div>

      {rewindable && saveTicks.length > 0 ? (
        <div className="history-panel__saves" data-testid="history-save-ticks">
          <span className="history-panel__saves-label">Saved checkpoints:</span>
          {saveTicks.slice(-MAX_SAVE_CHIPS).map((tick) => (
            <button
              key={tick}
              type="button"
              className="history-panel__save-chip"
              disabled={busy}
              onClick={() => {
                setSelected(tick);
              }}
              aria-label={`select saved tick ${formatInt(tick)}`}
            >
              {formatInt(tick)}
            </button>
          ))}
          {saveTicks.length > MAX_SAVE_CHIPS ? (
            <span className="history-panel__saves-more">
              +{formatInt(saveTicks.length - MAX_SAVE_CHIPS)} earlier
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="history-panel__actions">
        <button
          type="button"
          disabled={busy || !rewindable || viewTarget === null}
          onClick={viewSelected}
          data-testid="view-this-time"
        >
          {viewTarget === null ? "View this time" : `View tick ${formatInt(viewTarget)}`}
        </button>
        <button
          type="button"
          disabled={busy || !previewing}
          onClick={props.onReturnToPresent}
          data-testid="return-to-present"
        >
          Return to present
        </button>
      </div>

      {progress !== null ? (
        <div className="history-panel__progress" role="status">
          <div
            className="history-panel__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progressPercent(progress.ticksReplayed, progress.ticksTotal))}
          >
            <div
              className="history-panel__fill"
              style={{ width: `${progressPercent(progress.ticksReplayed, progress.ticksTotal)}%` }}
            />
          </div>
          <span>
            Replaying {formatInt(progress.ticksReplayed)} of {formatInt(progress.ticksTotal)} ticks
          </span>
        </div>
      ) : null}

      {previewing ? (
        <div className="history-panel__branch">
          <label>
            <span className="visually-hidden">Branch name</span>
            <input
              type="text"
              value={branchName}
              placeholder={`Branch at ${formatInt(historicalTick ?? 0)}`}
              onChange={(event) => {
                setBranchName(event.target.value);
              }}
              data-testid="branch-name"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              props.onBranch(
                branchName.trim() === ""
                  ? `Branch at ${formatInt(historicalTick ?? 0)}`
                  : branchName.trim(),
              );
              setBranchName("");
            }}
            data-testid="create-branch"
          >
            Branch from this tick
          </button>
        </div>
      ) : null}

      <p className={props.failed ? "history-panel__message--failed" : "history-panel__message"}>
        {props.message}
      </p>
    </section>
  );
}
