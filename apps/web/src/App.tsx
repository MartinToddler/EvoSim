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
  PerformancePanel,
  SpeciesPanel,
  StatsHistory,
  StatsPanel,
  TimelinePanel,
  ToolsPanel,
  TopBar,
  TreePanel,
  HistoryPanel,
  WorldsPanel,
  type RenderPerformanceView,
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
import { toggleViewHref } from "./app/route";
import { hasSeedInLocation, readSeedFromLocation } from "./app/seed";
import { APP_VERSION } from "./app/appVersion";
import { attachLifecycle } from "./app/lifecycle";
import { describeStoragePersistence } from "./app/storagePersistence";
import { StartScreen } from "./start/StartScreen";
import { NewWorldScreen, type AcceptedWorld } from "./start/NewWorldScreen";
import { listStartWorlds, type StartWorldView } from "./start/startWorlds";
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

/**
 * How often the performance HUD re-reads the renderer's counters.
 *
 * Matched to the Worker's telemetry cadence so every number on the panel comes
 * from roughly the same moment, and slow enough that reading them is not itself
 * a cost worth measuring.
 */
const PERFORMANCE_POLL_MS = 500;

/**
 * How this session's world came to exist (ADR 0025): accepted on the New World
 * screen, or reopened from storage. The distinction decides whether a tick-0
 * baseline is persisted and whether the preview-identity invariant applies.
 */
type WorldStart =
  | { kind: "new"; seed: number; name: string; environmentHash: string }
  | { kind: "load"; worldId: string };

/**
 * The app's top-level stage (docs/01 §9 states 1–3): the start screen, the New
 * World screen, or an open world. No engine, Worker or renderer exists before
 * the world stage — previewing and regenerating maps cannot advance
 * authoritative time because there is no authoritative time yet.
 */
type AppStage = { kind: "start" } | { kind: "new-world" } | { kind: "world"; start: WorldStart };

export function App(): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<WorldSession | null>(null);
  // One long-lived, bounded accumulator. `useState` (never re-set) rather than
  // a ref, because the object is read during render by the stats panel.
  const [history] = useState(() => new StatsHistory());
  // Resolved once: the URL cannot change under a mounted app, and the banner
  // must name the world actually being generated, not always the default.
  const [generatorHref] = useState(() =>
    toggleViewHref(globalThis.location?.search ?? "", "generator"),
  );
  const [requestedSeed] = useState(() => readSeedFromLocation(globalThis.location?.search ?? ""));

  // A `?seed=` link deep-links into the New World screen with that seed
  // previewed; otherwise the app opens on the start screen. Creating or loading
  // a world is always an explicit action (ADR 0025).
  const [stage, setStage] = useState<AppStage>(() =>
    hasSeedInLocation(globalThis.location?.search ?? "")
      ? { kind: "new-world" }
      : { kind: "start" },
  );
  const [startWorlds, setStartWorlds] = useState<readonly StartWorldView[] | null>(null);
  const [startWorldsError, setStartWorldsError] = useState<string | null>(null);

  const [world, setWorld] = useState<WorldSummaryDto | null>(null);
  const [hostRuntime, setHostRuntime] = useState<HostRuntimeConfig | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryDto | null>(null);
  // Worlds open PAUSED: the user starts time by pressing Play (ADR 0025).
  const [speed, setSpeed] = useState<SimulationSpeed>("paused");
  const lastRunSpeedRef = useRef<SimulationSpeed>("x1");
  const [selectedEntityId, setSelectedEntityId] = useState<number | null>(null);
  const [details, setDetails] = useState<EntityDetailsDto | null>(null);
  const [selectionGone, setSelectionGone] = useState(false);
  const [following, setFollowing] = useState(false);
  const [error, setError] = useState<WorkerErrorDto | null>(null);
  const [debugOverlay, setDebugOverlay] = useState(false);
  // Renderer counters are pulled, never pushed: frame rate changes 60 times a
  // second and React must never see that stream (CLAUDE.md React boundary).
  // Polled only while the performance HUD is open, at telemetry cadence.
  const [renderStats, setRenderStats] = useState<RenderPerformanceView | null>(null);
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
  /** "You are now inside the branch" banner; cleared by pressing Play (ADR 0025). */
  const [branchNotice, setBranchNotice] = useState<string | null>(null);

  // --- Species and history state (Milestone 8) --------------------------------
  const [tree, setTree] = useState<TreeSnapshotDto | null>(null);
  const [selectedSpeciesId, setSelectedSpeciesId] = useState<number | null>(null);
  const [speciesDetails, setSpeciesDetails] = useState<SpeciesDetailsDto | null>(null);
  const [events, setEvents] = useState<readonly WorldEventDto[]>([]);
  const [eventsDropped, setEventsDropped] = useState(0);

  // Read the stored-world list while the start screen is up. A one-shot,
  // short-lived database connection: no session exists yet.
  useEffect(() => {
    if (stage.kind !== "start") {
      return;
    }
    let cancelled = false;
    void listStartWorlds().then((result) => {
      if (!cancelled) {
        setStartWorlds(result.worlds);
        setStartWorldsError(result.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [stage]);

  useEffect(() => {
    if (stage.kind !== "world") {
      return;
    }
    const start = stage.start;
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
      seed: start.kind === "new" ? start.seed : requestedSeed,
      // A newly created world begins at exact tick 0, PAUSED; a loaded world
      // reopens paused at its restored tick. Play is the user's act (ADR 0025).
      initialSpeed: "paused",
      ...(start.kind === "load" ? { startFrom: { worldId: start.worldId } } : {}),
      ...(start.kind === "new"
        ? {
            persistBaseline: {
              name: start.name,
              // The preview-identity invariant (ADR 0025) is checked by the
              // session, against the CREATED world only. Checking it here
              // against every WORLD_READY was wrong: a later load or branch
              // replaces the world with a different map (and a world that has
              // run carries grown plants), so the digest legitimately differs
              // and the check fired on healthy worlds.
              expectedEnvironmentHash: start.environmentHash,
            },
          }
        : {}),
      callbacks: {
        onWorldReady: (readyWorld, runtime) => {
          // A world arrived, so whatever the previous one failed with no longer
          // describes what is on screen.
          setError(null);
          // A fresh world's charts must not continue a previous world's lines.
          history.clear();
          setWorld(readyWorld);
          setHostRuntime(runtime);
          // Nor may any other panel keep describing the replaced world: a stale
          // tree, species inspector or selection would attribute the previous
          // world's data to this one (ADR 0025).
          setTree(null);
          setSelectedSpeciesId(null);
          setSpeciesDetails(null);
          setSelectedEntityId(null);
          setDetails(null);
          setSelectionGone(false);
          setFollowing(false);
          setEvents([]);
          setEventsDropped(0);
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
  }, [history, stage, requestedSeed]);

  const changeSpeed = useCallback((next: SimulationSpeed) => {
    setSpeed(next);
    if (next !== "paused") {
      lastRunSpeedRef.current = next;
      // Pressing Play answers the branch banner's invitation; retire it.
      setBranchNotice(null);
    }
    sessionRef.current?.setSpeed(next);
  }, []);

  const resume = useCallback(() => {
    changeSpeed(lastRunSpeedRef.current);
  }, [changeSpeed]);

  /**
   * Page lifecycle: pause when the page is hidden, resume when it comes back,
   * and save on the way out (task M03, docs/02 §20).
   *
   * The session is the authority on whether the world is paused, not this
   * component's `speed` state: they agree, but reading the session keeps the
   * effect out of the speed dependency chain, so it attaches once for the life
   * of the app rather than re-attaching on every speed change.
   */
  useEffect(
    () =>
      attachLifecycle(
        {
          isHidden: () => globalThis.document.visibilityState === "hidden",
          isPaused: () => sessionRef.current?.paused ?? true,
          pause: () => {
            changeSpeed("paused");
          },
          resume,
          saveOnHide: () => {
            sessionRef.current?.saveOnHide();
          },
        },
        globalThis.document,
        globalThis,
      ),
    [changeSpeed, resume],
  );

  const toggleDebug = useCallback(() => {
    setDebugOverlay((previous) => {
      const next = !previous;
      sessionRef.current?.setDebugOverlay(next);
      return next;
    });
  }, []);

  // Poll the renderer's own counters while the HUD is open, and only then. The
  // interval is torn down when the overlay closes, so a closed HUD costs
  // nothing at all — which is the point of measuring at all.
  useEffect(() => {
    if (!debugOverlay) {
      return;
    }
    // The first sample arrives with the first interval rather than
    // synchronously: a setState in an effect body would re-render before the
    // browser had painted, for a panel that updates twice a second anyway.
    const handle = globalThis.setInterval(() => {
      const stats = sessionRef.current?.rendererStats() ?? null;
      setRenderStats(
        stats === null
          ? null
          : {
              fps: stats.fps,
              drawnOrganisms: stats.drawnOrganisms,
              drawnCarcasses: stats.drawnCarcasses,
              detailedOrganisms: stats.detailedOrganisms,
              zoom: stats.zoom,
            },
      );
    }, PERFORMANCE_POLL_MS);
    return () => {
      globalThis.clearInterval(handle);
      setRenderStats(null);
    };
  }, [debugOverlay]);

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

  const rewindTo = useCallback(
    (tick: number) => {
      // The session pauses the live world before reconstructing; mirror that in
      // the UI's speed state so the time controls tell the truth (ADR 0025).
      changeSpeed("paused");
      void sessionRef.current?.rewindTo(tick);
    },
    [changeSpeed],
  );

  const returnToPresent = useCallback(() => {
    sessionRef.current?.returnToPresent();
  }, []);

  const branchHere = useCallback(
    (name: string) => {
      // Capture the parent's identity now: once the branch opens, the
      // persistence status describes the branch itself.
      const parentName = persistence?.worldName ?? "the original world";
      const branchTick = historical?.tick ?? 0;
      void (async () => {
        const result = await sessionRef.current?.branchHere(name);
        if (result == null || result.worldId === null) {
          // The branch was never written; the persistence status says why.
          return;
        }
        if (!result.opened) {
          // Written but not switched into. Saying nothing would send the user
          // back to create a second copy of a branch that already exists.
          setBranchNotice(
            `Branch “${name}” was created from “${parentName}” at tick ` +
              `${branchTick.toLocaleString()}, but could not be opened just now. ` +
              `It is in the Worlds list — open it from there.`,
          );
          return;
        }
        // The branch is now the open world, paused at the branch tick
        // (ADR 0025). Reflect the pause in the UI's speed state and say
        // plainly where the user is; Play is what starts the new history.
        setSpeed("paused");
        setBranchNotice(
          `Now in branch “${name}” — created from “${parentName}” at tick ` +
            `${branchTick.toLocaleString()}. The world is paused; press Play to grow ` +
            `an alternative history.`,
        );
      })();
    },
    [persistence?.worldName, historical?.tick],
  );

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
        const parentId = stored.manifest.parentWorldId;
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
          // Lineage (ADR 0025): name the parent when it still exists.
          branch:
            parentId === undefined
              ? null
              : {
                  parentName:
                    storedWorlds.find((candidate) => candidate.manifest.worldId === parentId)
                      ?.manifest.worldName ?? null,
                  branchTick: stored.manifest.branchTick ?? 0,
                },
        };
      }),
    [storedWorlds, persistence?.worldId],
  );

  const persistenceStatusView = useMemo(() => {
    const parentId = currentStored?.manifest.parentWorldId;
    const parentName =
      parentId === undefined
        ? null
        : (storedWorlds.find((candidate) => candidate.manifest.worldId === parentId)?.manifest
            .worldName ?? "a deleted world");
    return {
      worldId: persistence?.worldId ?? null,
      worldName: persistence?.worldName ?? null,
      busy: persistence?.busy ?? false,
      autosaveArmed: persistence?.autosaveArmed ?? false,
      storageNote:
        persistence?.storagePersistence == null
          ? null
          : describeStoragePersistence(persistence.storagePersistence),
      lastSavedTick: persistence?.lastSavedTick ?? null,
      message: persistence?.message ?? "Not saved yet",
      failed: persistence?.failed ?? false,
      // "You are inside a branch" stays visible for as long as that is true.
      branchNote:
        parentId === undefined
          ? null
          : `This is a branch of “${parentName}”, diverging from tick ` +
            `${(currentStored?.manifest.branchTick ?? 0).toLocaleString()}.`,
    };
  }, [persistence, currentStored, storedWorlds]);

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

  // --- The start flow (ADR 0025; docs/01 §9 states 1-2) -----------------------
  // No world exists in these stages: no Worker, no engine, no autosave, and
  // regenerating previews cannot advance authoritative time.
  if (stage.kind === "start") {
    return (
      <StartScreen
        worlds={startWorlds}
        error={startWorldsError}
        onNewWorld={() => {
          setStage({ kind: "new-world" });
        }}
        onLoadWorld={(worldId) => {
          setStage({ kind: "world", start: { kind: "load", worldId } });
        }}
      />
    );
  }

  if (stage.kind === "new-world") {
    return (
      <NewWorldScreen
        initialSeed={requestedSeed}
        onCreate={(accepted: AcceptedWorld) => {
          setStage({ kind: "world", start: { kind: "new", ...accepted } });
        }}
        onBack={() => {
          // Show the fresh read, not the list from the last visit.
          setStartWorlds(null);
          setStage({ kind: "start" });
        }}
      />
    );
  }

  return (
    <div className="app" data-environment-hash={world?.environmentHash ?? ""}>
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
        generatorHref={generatorHref}
      />

      {world === null && error === null ? (
        <div className="banner">
          <strong>
            {stage.start.kind === "new"
              ? `Creating world 0x${stage.start.seed.toString(16).toUpperCase().padStart(8, "0")}…`
              : "Loading world…"}
          </strong>
          <p className="hint">
            {stage.start.kind === "new"
              ? "The authoritative world from the seed you accepted; it opens paused at tick 0."
              : "Restoring the saved world; it opens paused at its saved tick."}
          </p>
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

      {debugOverlay ? (
        <PerformancePanel
          telemetry={telemetry}
          render={renderStats}
          display={world?.display ?? null}
          chartSamples={history.length}
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
          // While previewing, telemetry describes the historical engine, so the
          // present's tick comes from the historical status (ADR 0025).
          presentTick={historical?.presentTick ?? telemetry?.tick ?? 0}
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

      {branchNotice !== null ? (
        <div className="branch-notice" role="status" data-testid="branch-opened-notice">
          {branchNotice}
          <button
            type="button"
            onClick={() => {
              setBranchNotice(null);
            }}
            aria-label="Dismiss branch notice"
          >
            ×
          </button>
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
