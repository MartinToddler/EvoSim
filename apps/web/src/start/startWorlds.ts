import { ENGINE_VERSION } from "@eon/engine";
import {
  WorldStore,
  describePersistenceError,
  type StoredWorld,
  type WorldStore as WorldStoreType,
} from "@eon/persistence";

/**
 * Stored-world listing for the start screen (ADR 0025).
 *
 * The start screen exists BEFORE any session or Worker does, so it reads the
 * database through its own short-lived connection: open, list, close. Nothing
 * here can touch a simulation — there is none yet.
 */

/** One saved world, reduced to what the start screen needs to offer it. */
export interface StartWorldView {
  readonly worldId: string;
  readonly worldName: string;
  readonly seedHex: string;
  readonly latestTick: number;
  readonly savedAtIso: string;
  readonly saveCount: number;
  readonly engineVersion: string;
  /** False when this build cannot run the save (engine version mismatch). */
  readonly loadable: boolean;
  readonly status: "ok" | "corrupt" | "legacy";
  /** Lineage for branches: parent name (null if deleted) and branch tick. */
  readonly branch: { readonly parentName: string | null; readonly branchTick: number } | null;
}

export interface StartWorldsResult {
  readonly worlds: readonly StartWorldView[];
  /** Human-readable failure, or null. An empty list with no error means "none yet". */
  readonly error: string | null;
}

function toView(stored: StoredWorld, all: readonly StoredWorld[]): StartWorldView {
  const manifest = stored.manifest;
  const parentId = manifest.parentWorldId;
  return {
    worldId: manifest.worldId,
    worldName: manifest.worldName,
    seedHex: `0x${manifest.seed.toString(16).toUpperCase().padStart(8, "0")}`,
    latestTick: manifest.latestTick,
    savedAtIso: stored.saves[0]?.savedAtIso ?? manifest.lastOpenedAtIso,
    saveCount: stored.saves.length,
    engineVersion: manifest.engineVersion,
    loadable: manifest.engineVersion === ENGINE_VERSION,
    status: manifest.status,
    branch:
      parentId === undefined
        ? null
        : {
            parentName:
              all.find((candidate) => candidate.manifest.worldId === parentId)?.manifest
                .worldName ?? null,
            branchTick: manifest.branchTick ?? 0,
          },
  };
}

/** List every stored world, newest-opened first, through a one-shot connection. */
export async function listStartWorlds(
  createStore: () => WorldStoreType = () => new WorldStore(),
): Promise<StartWorldsResult> {
  let store: WorldStoreType;
  try {
    store = createStore();
  } catch (error) {
    return { worlds: [], error: describePersistenceError(error) };
  }
  try {
    const stored = await store.listWorlds();
    return { worlds: stored.map((world) => toView(world, stored)), error: null };
  } catch (error) {
    return { worlds: [], error: describePersistenceError(error) };
  } finally {
    store.close();
  }
}
