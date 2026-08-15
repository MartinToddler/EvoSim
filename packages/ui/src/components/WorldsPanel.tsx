import { useCallback, useState } from "react";
import { formatInt } from "../format";

/**
 * Saved worlds panel (Milestone 10, tasks K04/K05; docs/06 §§8, 19–20).
 *
 * Save, load, list and delete, with the status line the milestone asks for:
 * what happened, when, and — when something failed — what failed and what that
 * means for the data. Storage errors are shown in the panel rather than
 * flashed as a toast, because "could not save" is a state the user needs to
 * keep seeing, not a notification that scrolls away.
 *
 * ## Deliberately dependency-free
 *
 * The props below are plain view models, not `@eon/persistence` types. This
 * package renders DTOs and raises callbacks (see the package doc comment); the
 * app maps stored records into these. That keeps the storage schema free to
 * change without touching a React component, and keeps IndexedDB types out of
 * a package that must never touch a database.
 *
 * ## Deleting asks first, in the panel
 *
 * Delete is the one irreversible action here, so it takes two clicks and shows
 * exactly which world is about to go. `window.confirm` was rejected for it: it
 * blocks the whole tab (the simulation included) and cannot be styled, tested
 * or dismissed by keyboard consistently across mobile browsers.
 */

/** One stored world, as this panel needs it. */
export interface SavedWorldView {
  worldId: string;
  worldName: string;
  seedHex: string;
  /** Tick of the newest save. */
  latestTick: number;
  /** ISO timestamp of the newest save; display metadata only. */
  savedAtIso: string;
  saveCount: number;
  engineVersion: string;
  /** Canonical state hash at `latestTick`. */
  stateHash: string;
  totalBytes: number;
  status: "ok" | "corrupt" | "legacy";
  statusDetail: string;
  /** True when this is the world the session is currently bound to. */
  isCurrent: boolean;
  /** False when this build cannot run the save (engine version mismatch). */
  loadable: boolean;
  /**
   * Lineage, for a world created as a branch (ADR 0025): the parent's display
   * name (null when the parent was deleted) and the tick it branched from.
   * Null for root worlds.
   */
  branch: { parentName: string | null; branchTick: number } | null;
}

/** Storage status, as the app's persistence controller reports it. */
export interface PersistenceStatusView {
  worldId: string | null;
  worldName: string | null;
  busy: boolean;
  autosaveArmed: boolean;
  lastSavedTick: number | null;
  message: string;
  failed: boolean;
  /**
   * One line about whether the browser will keep saved worlds (task M07), or
   * null before this session has saved anything and asked. The app owns the
   * wording; this panel only decides where it goes.
   */
  storageNote: string | null;
  /**
   * One line naming the open world's lineage when it is a branch (ADR 0025) —
   * "Branch of X from tick N" — or null for a root world. Makes "you are now
   * inside the branch" visible somewhere persistent, not only in a toast.
   */
  branchNote: string | null;
}

export interface WorldsPanelProps {
  worlds: readonly SavedWorldView[];
  status: PersistenceStatusView;
  /** Current simulation tick, so the user can see what a save would capture. */
  tick: number;
  /** Name proposed for a world that has never been saved. */
  suggestedName: string;
  /** Autosave cadence in ticks; 0 when disabled. */
  autosaveIntervalTicks: number;
  /** Non-null when storage is unusable at all (private mode, no IndexedDB). */
  unavailableReason: string | null;
  onSave: (name: string) => void;
  onLoad: (worldId: string) => void;
  onDelete: (worldId: string) => void;
  onRefresh: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${formatInt(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Wall-clock metadata, rendered in the viewer's locale. */
function formatSavedAt(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return "unknown time";
  }
  return parsed.toLocaleString();
}

export function WorldsPanel(props: WorldsPanelProps): React.JSX.Element {
  const { status, worlds, unavailableReason } = props;
  const [name, setName] = useState(props.suggestedName);
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  // The bound world's name is the one the next save will use, so the field
  // follows it when the session binds to a stored world — otherwise it would
  // lie about what Save is going to overwrite. Adjusting state during render
  // rather than in an effect: React re-renders before painting, so the input
  // never shows the stale name for a frame.
  const [syncedName, setSyncedName] = useState(status.worldName);
  if (status.worldName !== null && status.worldName !== syncedName) {
    setSyncedName(status.worldName);
    setName(status.worldName);
  }

  // A world that disappeared — deleted here or in another tab — must not leave
  // a confirm button armed against nothing. Derived rather than reset, so
  // there is no state to get out of step in the first place.
  const confirmingDelete =
    armedDelete !== null && worlds.some((world) => world.worldId === armedDelete)
      ? armedDelete
      : null;

  const save = useCallback(() => {
    const trimmed = name.trim();
    props.onSave(trimmed === "" ? props.suggestedName : trimmed);
  }, [name, props]);

  if (unavailableReason !== null) {
    return (
      <section className="worlds-panel" aria-label="Saved worlds">
        <h2>Worlds</h2>
        <p className="worlds-status failed" role="status">
          {unavailableReason}
        </p>
      </section>
    );
  }

  return (
    <section className="worlds-panel" aria-label="Saved worlds">
      <h2>Worlds</h2>

      <div className="worlds-save">
        <label className="worlds-name">
          <span>Name</span>
          <input
            type="text"
            value={name}
            maxLength={80}
            onChange={(event) => {
              setName(event.target.value);
            }}
            aria-label="World name"
          />
        </label>
        <button type="button" onClick={save} disabled={status.busy}>
          {status.busy ? "Working…" : "Save"}
        </button>
        <button type="button" onClick={props.onRefresh} disabled={status.busy}>
          Refresh
        </button>
      </div>

      <p className={status.failed ? "worlds-status failed" : "worlds-status"} role="status">
        {status.message}
      </p>

      <p className="worlds-hint">
        Saving captures tick {formatInt(props.tick)} exactly: the same world reloaded continues into
        the same future.{" "}
        {status.autosaveArmed && props.autosaveIntervalTicks > 0
          ? `Autosave on, every ${formatInt(props.autosaveIntervalTicks)} ticks.`
          : "Autosave starts once this world has been saved once."}
        {status.storageNote === null ? null : ` ${status.storageNote}`}
      </p>

      {status.branchNote === null ? null : (
        <p className="worlds-branch-note" role="status" data-testid="branch-note">
          {status.branchNote}
        </p>
      )}

      {worlds.length === 0 ? (
        <p className="worlds-empty">No saved worlds yet.</p>
      ) : (
        <ul className="worlds-list">
          {worlds.map((world) => (
            <li key={world.worldId} className={world.isCurrent ? "world-row current" : "world-row"}>
              <div className="world-head">
                <span className="world-name">
                  {world.worldName}
                  {world.isCurrent ? " • open" : ""}
                </span>
                <span className="world-tick">tick {formatInt(world.latestTick)}</span>
              </div>
              <div className="world-meta">
                <span title="World seed">{world.seedHex}</span>
                <span title="Canonical state hash at the saved tick">{world.stateHash}</span>
                <span>
                  {world.saveCount} save{world.saveCount === 1 ? "" : "s"} ·{" "}
                  {formatBytes(world.totalBytes)}
                </span>
                <span>{formatSavedAt(world.savedAtIso)}</span>
              </div>
              {world.branch === null ? null : (
                <div className="world-branch" title="This world is a branch: an alternative history">
                  branched from{" "}
                  {world.branch.parentName === null ? "a deleted world" : world.branch.parentName} at
                  tick {formatInt(world.branch.branchTick)}
                </div>
              )}
              {world.status === "ok" ? null : (
                <p className="world-problem">
                  {world.status === "legacy"
                    ? `Saved by engine ${world.engineVersion}; this build runs a different one, so it is kept but cannot be loaded.`
                    : `This world's newest save could not be read: ${world.statusDetail}`}
                </p>
              )}
              <div className="world-actions">
                <button
                  type="button"
                  onClick={() => {
                    props.onLoad(world.worldId);
                  }}
                  disabled={status.busy || !world.loadable}
                  title={
                    world.loadable
                      ? "Replace the running world with this save"
                      : `Needs engine ${world.engineVersion}`
                  }
                >
                  Load
                </button>
                {confirmingDelete === world.worldId ? (
                  <>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        setArmedDelete(null);
                        props.onDelete(world.worldId);
                      }}
                    >
                      Delete “{world.worldName}” permanently
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setArmedDelete(null);
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setArmedDelete(world.worldId);
                    }}
                    disabled={status.busy}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
