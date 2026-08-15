import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CommandResultDto,
  EntityDetailsDto,
  HostRuntimeConfig,
  SimulationSpeed,
  SpeciesDetailsDto,
  TelemetryDto,
  TreeSnapshotDto,
  WorkerErrorDto,
  WorldEventDto,
  WorldSummaryDto,
} from "@eon/protocol";
import type { WorldLayerId } from "@eon/renderer/palette";
import {
  InspectorPanel,
  LayersPanel,
  SpeciesPanel,
  StatsHistory,
  StatsPanel,
  TimelinePanel,
  ToolsPanel,
  TopBar,
  TreePanel,
  HistoryPanel,
  WorldsPanel,
  type SavedWorldView,
  type ToolSelection,
} from "@eon/ui";
import { ENGINE_VERSION } from "@eon/engine";
import type { StoredWorld } from "@eon/persistence";
import { WorldSession } from "./app/WorldSession";
import {
  defaultWorldName,
  type HistoricalStatus,
  type PersistenceStatus,
} from "./app/WorldPersistence";
import { readSeedFromLocation } from "./app/seed";
import "./styles/app.css";

/**
 * Milestone 7 application shell: the observation UI (tasks H01-H06).
 *
 * ## What React holds, and what it does not
 *
 * State here is world metadata, 2 Hz telemetry, the selected entity ID and its
 * details, follow/layer/panel state — the list docs/10 §23 marks safe. No
 * organism coordinate ever enters React state, so a world of 8192 organisms
 * causes exactly the same number of renders as an empty one: two per second.
 * Chart history lives in a ref (a bounded {@link StatsHistory}), mutated at
 * telemetry cadence and *read* during those same 2 Hz renders — accumulation
 * never schedules extra renders of its own.
 *
 * ## Responsive rule (docs/06 §16)
 *
 * Desktop shows side/bottom panels alongside the world. On narrow viewports
 * the same panels become bottom sheets and only one major sheet is open at a
 * time — the world stays the primary focus on a phone.
 *
 * The canvas is not a React-managed element; see Milestone 6's note below the
 * session effect.
 */

/**
 * Build identifier recorded in every save manifest, so a stored world can be
 * traced to the app that wrote it. Vite substitutes it at build time; the
 * fallback keeps a dev server honest rather than pretending to know.
 */
const APP_VERSION: string = (import.meta.env["VITE_APP_VERSION"] as string | undefined) ?? "dev";

/** Panels that compete for the single mobile sheet slot. */
type PanelId = "stats" | "layers" | "species" | "tree" | "timeline" | "tools" | "worlds";

type PanelsOpen = Readonly<Record<PanelId, boolean>>;

const NO_PANELS: PanelsOpen = {
  stats: false,
  layers: false,
  species: false,
  tree: false,
  timeline: false,
  tools: false,
  worlds: false,
};

/**
 * Which panel survives entering a narrow viewport with several open. Charts
 * and running context (stats) first, then the M8 views, layers last — a
 * deterministic rule, applied without any click involved.
 */
const NARROW_KEEP_PRIORITY: readonly PanelId[] = [
  "worlds",
  "tools",
  "stats",
  "species",
  "tree",
  "timeline",
  "layers",
];

/** Close every panel except `keep`; identity-stable when nothing changes. */
function keepOnly(previous: PanelsOpen, keep: PanelId | null): PanelsOpen {
  let changed = false;
  const next = { ...NO_PANELS } as Record<PanelId, boolean>;
  for (const id of NARROW_KEEP_PRIORITY) {
    const want = id === keep && previous[id];
    next[id] = want;
    if (want !== previous[id]) {
      changed = true;
    }
  }
  return changed ? next : previous;
}

/**
 * Track the narrow-viewport media query and enforce the one-sheet rule
 * (docs/06 §16) on the way *into* narrow: a tablet rotating with several
 * panels open must end up with one sheet, not a stack. Toggle-time
 * exclusivity alone misses that path, because no click is involved.
 */
function useNarrowViewport(setPanels: React.Dispatch<React.SetStateAction<PanelsOpen>>): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = globalThis.matchMedia?.("(max-width: 760px)");
    if (query === undefined) {
      return;
    }
    const update = (): void => {
      setNarrow(query.matches);
      if (query.matches) {
        setPanels((previous) => {
          const keep = NARROW_KEEP_PRIORITY.find((id) => previous[id]) ?? null;
          return keepOnly(previous, keep);
        });
      }
    };
    update();
    query.addEventListener("change", update);
    return () => {
      query.removeEventListener("change", update);
    };
  }, [setPanels]);
  return narrow;
}

export function App(): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<WorldSession | null>(null);
  // One long-lived, bounded accumulator. `useState` (never re-set) rather than
  // a ref, because the object is read during render by the stats panel.
  const [history] = useState(() => new StatsHistory());
  // Resolved once: the URL cannot change under a mounted app, and the banner
  // must name the world actually being generated, not always the default.
  const [requestedSeed] = useState(() => readSeedFromLocation(globalThis.location?.search ?? ""));

  const [world, setWorld] = useState<WorldSummaryDto | null>(null);
  const [hostRuntime, setHostRuntime] = useState<HostRuntimeConfig | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryDto | null>(null);
  const [speed, setSpeed] = useState<SimulationSpeed>("x1");
  const lastRunSpeedRef = useRef<SimulationSpeed>("x1");
  const [selectedEntityId, setSelectedEntityId] = useState<number | null>(null);
  const [details, setDetails] = useState<EntityDetailsDto | null>(null);
  const [selectionGone, setSelectionGone] = useState(false);
  const [following, setFollowing] = useState(false);
  const [error, setError] = useState<WorkerErrorDto | null>(null);
  const [debugOverlay, setDebugOverlay] = useState(false);
  const [worldLayer, setWorldLayer] = useState<WorldLayerId>("terrain");
  const [layerOpacity, setLayerOpacity] = useState(0.85);
  // One state object for every panel, because the one-sheet rule is a joint
  // constraint: updating them together can never leave two sheets open.
  const [panels, setPanels] = useState<PanelsOpen>(NO_PANELS);
  const narrow = useNarrowViewport(setPanels);
  const statsOpen = panels.stats;
  const layersOpen = panels.layers;
  const speciesOpen = panels.species;
  const treeOpen = panels.tree;
  const timelineOpen = panels.timeline;
  const toolsOpen = panels.tools;
  const worldsOpen = panels.worlds;

  // --- Player tools state (Milestone 9) ----------------------------------------
  const [activeTool, setActiveTool] = useState<ToolSelection | null>(null);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const commandNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Persistence state (Milestone 10) ---------------------------------------
  const [storedWorlds, setStoredWorlds] = useState<readonly StoredWorld[]>([]);
  const [persistence, setPersistence] = useState<PersistenceStatus | null>(null);
  const [historical, setHistorical] = useState<HistoricalStatus | null>(null);

  // --- Species and history state (Milestone 8) --------------------------------
  const [tree, setTree] = useState<TreeSnapshotDto | null>(null);
  const [selectedSpeciesId, setSelectedSpeciesId] = useState<number | null>(null);
  const [speciesDetails, setSpeciesDetails] = useState<SpeciesDetailsDto | null>(null);
  const [events, setEvents] = useState<readonly WorldEventDto[]>([]);
  const [eventsDropped, setEventsDropped] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) {
      return;
    }
    // The canvas is created imperatively and removed on cleanup, which keeps
    // Pixi's WebGL context and React's reconciler out of each other's way —
    // and makes StrictMode's deliberate double-mount harmless instead of a
    // source of two simulations sharing one canvas.
    const canvas = document.createElement("canvas");
    viewport.appendChild(canvas);

    const session = WorldSession.start({
      canvas,
      viewport,
      seed: requestedSeed,
      // Worlds open running: open the page, watch organisms live.
      initialSpeed: "x1",
      callbacks: {
        onWorldReady: (readyWorld, runtime) => {
          // A fresh world's charts must not continue a previous world's lines.
          history.clear();
          setWorld(readyWorld);
          setHostRuntime(runtime);
        },
        // Speed state deliberately does NOT sync from telemetry: a frame
        // produced before a just-clicked speed change was processed would
        // flick the buttons back for half a second. The UI's speed is the
        // last requested one; the host honours it or reports an error.
        onTelemetry: (next) => {
          history.push(next);
          setTelemetry(next);
        },
        onSelectionChange: (entityId) => {
          setSelectedEntityId(entityId);
          setSelectionGone(false);
          if (entityId === null) {
            setDetails(null);
          }
        },
        onEntityDetails: (payload) => {
          setDetails(payload.details);
          setSelectionGone(payload.details === null);
        },
        onFollowChange: (entityId) => {
          setFollowing(entityId !== null);
        },
        onTree: (nextTree) => {
          setTree(nextTree);
        },
        onSpeciesDetails: (payload) => {
          setSpeciesDetails(payload.details);
        },
        onHistoryEvents: (nextEvents, droppedBeforeOldest) => {
          setEvents(nextEvents);
          setEventsDropped(droppedBeforeOldest);
        },
        onCommandResult: (result: CommandResultDto) => {
          setCommandNotice(
            result.accepted
              ? `Intervention queued for tick ${result.tick} (#${result.commandId})`
              : `Intervention rejected: ${result.detail}`,
          );
          if (commandNoticeTimer.current !== null) {
            clearTimeout(commandNoticeTimer.current);
          }
          commandNoticeTimer.current = setTimeout(() => {
            setCommandNotice(null);
            commandNoticeTimer.current = null;
          }, 4000);
        },
        onPersistenceStatus: (status) => {
          setPersistence(status);
        },
        onHistorical: (status) => {
          setHistorical(status);
        },
        onWorldsChanged: (worlds) => {
          setStoredWorlds(worlds);
        },
        onError: (workerError) => {
          setError(workerError);
        },
      },
      appVersion: APP_VERSION,
    });
    sessionRef.current = session;

    // Stop producing pictures nobody is looking at. The simulation keeps
    // ticking: a hidden tab should still evolve, it just should not paint.
    const onVisibility = (): void => {
      session.setRenderStream(!document.hidden);
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Esc clears the selection — the keyboard path to "deselect" (docs/06 §17).
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        // Esc leaves tool mode first; a second Esc clears the selection.
        if (session.activeTool !== null) {
          setActiveTool(null);
          return;
        }
        session.clearSelection();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("keydown", onKeyDown);
      if (commandNoticeTimer.current !== null) {
        clearTimeout(commandNoticeTimer.current);
        commandNoticeTimer.current = null;
      }
      session.destroy();
      sessionRef.current = null;
      canvas.remove();
    };
  }, [history, requestedSeed]);

  const changeSpeed = useCallback((next: SimulationSpeed) => {
    setSpeed(next);
    if (next !== "paused") {
      lastRunSpeedRef.current = next;
    }
    sessionRef.current?.setSpeed(next);
  }, []);

  const resume = useCallback(() => {
    changeSpeed(lastRunSpeedRef.current);
  }, [changeSpeed]);

  const toggleDebug = useCallback(() => {
    setDebugOverlay((previous) => {
      const next = !previous;
      sessionRef.current?.setDebugOverlay(next);
      return next;
    });
  }, []);

  const fitWorld = useCallback(() => {
    sessionRef.current?.fitWorld();
  }, []);

  const clearSelection = useCallback(() => {
    sessionRef.current?.clearSelection();
  }, []);

  const focusSelection = useCallback(() => {
    sessionRef.current?.focusSelected();
  }, []);

  const toggleFollow = useCallback(() => {
    const session = sessionRef.current;
    if (session === null) {
      return;
    }
    if (session.followedEntityId !== null) {
      session.stopFollow();
    } else {
      session.followSelected();
    }
  }, []);

  const selectLayer = useCallback((layer: WorldLayerId) => {
    setWorldLayer(layer);
    sessionRef.current?.setWorldLayer(layer);
  }, []);

  const changeLayerOpacity = useCallback((opacity: number) => {
    setLayerOpacity(opacity);
    sessionRef.current?.setLayerOpacity(opacity);
  }, []);

  // On a phone only one major sheet may be open at a time (docs/06 §16); on
  // desktop the panels are independent.
  const togglePanel = useCallback(
    (panel: PanelId) => {
      setPanels((previous) => {
        const opening = !previous[panel];
        if (opening && narrow) {
          const next = { ...NO_PANELS } as Record<PanelId, boolean>;
          next[panel] = true;
          return next;
        }
        return { ...previous, [panel]: opening };
      });
    },
    [narrow],
  );
  const toggleStats = useCallback(() => {
    togglePanel("stats");
  }, [togglePanel]);
  const toggleLayers = useCallback(() => {
    togglePanel("layers");
  }, [togglePanel]);
  const toggleSpecies = useCallback(() => {
    togglePanel("species");
  }, [togglePanel]);
  const toggleTree = useCallback(() => {
    togglePanel("tree");
  }, [togglePanel]);
  const toggleTimeline = useCallback(() => {
    togglePanel("timeline");
  }, [togglePanel]);
  const toggleTools = useCallback(() => {
    togglePanel("tools");
  }, [togglePanel]);
  const toggleWorlds = useCallback(() => {
    togglePanel("worlds");
  }, [togglePanel]);

  // Arm/disarm a canvas tool. React state is the source of truth; the session
  // is synchronized by the effect below.
  const selectTool = useCallback((tool: ToolSelection | null) => {
    setActiveTool(tool);
  }, []);

  const applyGlobalTemperature = useCallback((offsetCentiC: number) => {
    sessionRef.current?.applyGlobalTemperature(offsetCentiC);
  }, []);

  // The session's armed tool follows (panel open AND a tool chosen). Closing
  // the panel — by toggle or by the narrow-viewport one-sheet rule — disarms
  // capture without losing the choice: reopening re-arms the same tool. This
  // is an external-system sync, not derived state, so an effect is the right
  // place for it.
  useEffect(() => {
    const tool = toolsOpen ? activeTool : null;
    sessionRef.current?.setActiveTool(
      tool === null
        ? null
        : tool.kind === "meteor"
          ? { kind: "meteor", radiusLU: tool.radiusLU }
          : {
              kind: tool.kind,
              radiusLU: tool.radiusLU,
              strength: tool.strength,
              falloff: tool.falloff,
            },
    );
  }, [toolsOpen, activeTool]);

  // The stored-world list is read when the panel opens rather than polled: it
  // changes only when this tab saves or deletes, and both of those refresh it.
  useEffect(() => {
    if (worldsOpen) {
      sessionRef.current?.refreshWorlds();
    }
  }, [worldsOpen]);

  const saveWorld = useCallback((name: string) => {
    sessionRef.current?.saveWorld(name);
  }, []);

  const rewindTo = useCallback((tick: number) => {
    void sessionRef.current?.rewindTo(tick);
  }, []);

  const returnToPresent = useCallback(() => {
    sessionRef.current?.returnToPresent();
  }, []);

  const branchHere = useCallback((name: string) => {
    // The new world is written but NOT opened: the preview stays on screen so
    // the branch point is still visible, and the worlds list is where a world
    // gets opened. Switching automatically would also discard the charts of the
    // world you were looking at without asking.
    void sessionRef.current?.branchHere(name);
  }, []);

  const loadWorld = useCallback(
    (worldId: string) => {
      // A load replaces the world the charts were describing.
      history.clear();
      sessionRef.current?.loadWorld(worldId);
    },
    [history],
  );

  const deleteWorld = useCallback((worldId: string) => {
    sessionRef.current?.deleteWorld(worldId);
  }, []);

  // Live tree refresh only while someone is looking at species data; otherwise
  // the session refreshes it only when the species set itself changes.
  useEffect(() => {
    sessionRef.current?.setTreeWatching(speciesOpen || treeOpen);
  }, [speciesOpen, treeOpen]);

  // Selecting a species (from any panel or the organism inspector) opens the
  // species panel so the selection is immediately visible somewhere.
  const selectSpecies = useCallback(
    (speciesId: number | null) => {
      setSelectedSpeciesId(speciesId);
      if (speciesId === null) {
        setSpeciesDetails(null);
        sessionRef.current?.selectSpecies(null);
        return;
      }
      setSpeciesDetails(null);
      sessionRef.current?.selectSpecies(speciesId);
      setPanels((previous) => {
        if (previous.species) {
          return previous;
        }
        if (narrow) {
          const next = { ...NO_PANELS } as Record<PanelId, boolean>;
          next.species = true;
          return next;
        }
        return { ...previous, species: true };
      });
    },
    [narrow],
  );

  const refreshWorlds = useCallback(() => {
    sessionRef.current?.refreshWorlds();
  }, []);

  // Derived from world state rather than read off the session during render:
  // a ref holds no value React is allowed to read while rendering.
  /** Ticks with a stored save for the bound world, and where its timeline starts. */
  const currentStored = useMemo(
    () => storedWorlds.find((stored) => stored.manifest.worldId === persistence?.worldId),
    [storedWorlds, persistence?.worldId],
  );
  const currentSaveTicks = useMemo(
    () => (currentStored?.saves ?? []).map((save) => save.tick).sort((a, b) => a - b),
    [currentStored],
  );
  const currentBranchTick = currentStored?.manifest.branchTick ?? 0;

  const suggestedWorldName = world === null ? "New world" : defaultWorldName(world.seed);

  // Stored records mapped into the plain view model the panel renders. The UI
  // package never sees a persistence type (see its package doc comment).
  const savedWorldViews: SavedWorldView[] = useMemo(
    () =>
      storedWorlds.map((stored) => {
        const newest = stored.saves[0];
        return {
          worldId: stored.manifest.worldId,
          worldName: stored.manifest.worldName,
          seedHex: `0x${stored.manifest.seed.toString(16).toUpperCase().padStart(8, "0")}`,
          latestTick: stored.manifest.latestTick,
          savedAtIso: newest?.savedAtIso ?? stored.manifest.lastOpenedAtIso,
          saveCount: stored.saves.length,
          engineVersion: stored.manifest.engineVersion,
          stateHash: stored.manifest.latestStateHash,
          totalBytes: stored.saves.reduce((sum, save) => sum + save.byteLength, 0),
          status: stored.manifest.status,
          statusDetail: stored.manifest.statusDetail,
          isCurrent: stored.manifest.worldId === persistence?.worldId,
          // A save from another engine build would run a different history, so
          // the button is disabled rather than allowed to fail on click.
          loadable: stored.manifest.engineVersion === ENGINE_VERSION,
        };
      }),
    [storedWorlds, persistence?.worldId],
  );

  const persistenceStatusView = useMemo(
    () => ({
      worldId: persistence?.worldId ?? null,
      worldName: persistence?.worldName ?? null,
      busy: persistence?.busy ?? false,
      autosaveArmed: persistence?.autosaveArmed ?? false,
      lastSavedTick: persistence?.lastSavedTick ?? null,
      message: persistence?.message ?? "Not saved yet",
      failed: persistence?.failed ?? false,
    }),
    [persistence],
  );

  /** Compact save state for the top bar (docs/06 §9). */
  const saveStateLabel =
    persistence === null || persistence.lastSavedTick === null
      ? persistence?.failed === true
        ? "failed"
        : "unsaved"
      : persistence.busy
        ? "saving…"
        : persistence.failed
          ? "failed"
          : `saved @ ${persistence.lastSavedTick.toLocaleString()}`;

  // On narrow viewports an open sheet takes the inspector's slot; selection
  // survives underneath and the inspector returns when the sheet closes.
  const anySheetOpen =
    statsOpen || layersOpen || speciesOpen || treeOpen || timelineOpen || toolsOpen || worldsOpen;
  const inspectorVisible = !narrow || !anySheetOpen;

  return (
    <div className="app">
      <div className="viewport" ref={viewportRef} />

      <TopBar
        world={world}
        hostRuntime={hostRuntime}
        telemetry={telemetry}
        speed={speed}
        debugOverlay={debugOverlay}
        statsOpen={statsOpen}
        layersOpen={layersOpen}
        speciesOpen={speciesOpen}
        treeOpen={treeOpen}
        timelineOpen={timelineOpen}
        toolsOpen={toolsOpen}
        worldsOpen={worldsOpen}
        saveState={saveStateLabel}
        onSpeedChange={changeSpeed}
        onResume={resume}
        onToggleDebug={toggleDebug}
        onFitWorld={fitWorld}
        onToggleStats={toggleStats}
        onToggleLayers={toggleLayers}
        onToggleSpecies={toggleSpecies}
        onToggleTree={toggleTree}
        onToggleTimeline={toggleTimeline}
        onToggleTools={toggleTools}
        onToggleWorlds={toggleWorlds}
      />

      {world === null && error === null ? (
        <div className="banner">
          <strong>
            Generating world 0x{requestedSeed.toString(16).toUpperCase().padStart(8, "0")}…
          </strong>
          <p className="hint">Procedural terrain, plants and the founder population.</p>
        </div>
      ) : null}

      {layersOpen ? (
        <LayersPanel
          active={worldLayer}
          opacity={layerOpacity}
          display={world?.display ?? null}
          onSelect={selectLayer}
          onOpacity={changeLayerOpacity}
        />
      ) : null}

      {statsOpen ? (
        <StatsPanel
          history={history}
          revision={telemetry?.tick ?? 0}
          telemetry={telemetry}
          display={world?.display ?? null}
          ticksPerSimYear={hostRuntime?.ticksPerSimYear ?? 2000}
        />
      ) : null}

      {speciesOpen ? (
        <SpeciesPanel
          tree={tree}
          selectedSpeciesId={selectedSpeciesId}
          details={speciesDetails}
          display={world?.display ?? null}
          ticksPerSimYear={hostRuntime?.ticksPerSimYear ?? 2000}
          onSelectSpecies={selectSpecies}
          onOpenTree={toggleTree}
          onClose={toggleSpecies}
        />
      ) : null}

      {treeOpen ? (
        <TreePanel
          tree={tree}
          currentTick={telemetry?.tick ?? 0}
          ticksPerSimYear={hostRuntime?.ticksPerSimYear ?? 2000}
          selectedSpeciesId={selectedSpeciesId}
          display={world?.display ?? null}
          onSelectSpecies={selectSpecies}
          onClose={toggleTree}
        />
      ) : null}

      {toolsOpen ? (
        <ToolsPanel
          display={world?.display ?? null}
          active={activeTool}
          pendingCommandCount={telemetry?.pendingCommandCount ?? 0}
          onSelect={selectTool}
          onApplyGlobalTemperature={applyGlobalTemperature}
          onClose={toggleTools}
        />
      ) : null}

      {worldsOpen ? (
        <WorldsPanel
          worlds={savedWorldViews}
          status={persistenceStatusView}
          tick={telemetry?.tick ?? 0}
          suggestedName={suggestedWorldName}
          autosaveIntervalTicks={hostRuntime?.autosaveCheckInterval ?? 0}
          unavailableReason={null}
          onSave={saveWorld}
          onLoad={loadWorld}
          onDelete={deleteWorld}
          onRefresh={refreshWorlds}
        />
      ) : null}

      {worldsOpen ? (
        <HistoryPanel
          mode={historical?.mode ?? "live"}
          presentTick={telemetry?.tick ?? 0}
          originTick={currentBranchTick}
          historicalTick={historical?.tick ?? null}
          progress={historical?.progress ?? null}
          saveTicks={currentSaveTicks}
          message={historical?.message ?? ""}
          failed={historical?.failed ?? false}
          canRewind={persistence?.worldId !== null && persistence?.worldId !== undefined}
          onRewind={rewindTo}
          onReturnToPresent={returnToPresent}
          onBranch={branchHere}
        />
      ) : null}

      {commandNotice !== null ? (
        <div className="command-notice" role="status">
          {commandNotice}
        </div>
      ) : null}

      {timelineOpen ? (
        <TimelinePanel
          events={events}
          droppedBeforeOldest={eventsDropped}
          currentTick={telemetry?.tick ?? 0}
          ticksPerSimYear={hostRuntime?.ticksPerSimYear ?? 2000}
          display={world?.display ?? null}
          onSelectSpecies={selectSpecies}
          onClose={toggleTimeline}
        />
      ) : null}

      {inspectorVisible ? (
        <InspectorPanel
          selectedEntityId={selectedEntityId}
          details={details}
          gone={selectionGone}
          following={following}
          display={world?.display ?? null}
          onClear={clearSelection}
          onFocus={focusSelection}
          onToggleFollow={toggleFollow}
          onSelectSpecies={selectSpecies}
        />
      ) : null}

      {error !== null ? (
        <div className="error-banner" role="alert">
          <strong>{error.fatal ? "Simulation stopped" : "Worker warning"}</strong>
          <div>{error.message}</div>
          <div className="hint">
            engine {error.engineVersion}
            {error.tick === null ? "" : ` · tick ${error.tick}`}
            {error.whileHandling === null ? "" : ` · handling ${error.whileHandling}`}
          </div>
        </div>
      ) : null}
    </div>
  );
}
