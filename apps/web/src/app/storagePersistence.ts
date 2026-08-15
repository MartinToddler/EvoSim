/**
 * Persistent-storage request (task M07, docs/02 §20 "storage validation").
 *
 * ## The mobile failure this exists for
 *
 * A saved world lives in IndexedDB, and IndexedDB is *evictable* by default.
 * Desktop browsers evict under storage pressure; mobile ones are far more
 * aggressive — Safari discards script-writable storage for origins the user has
 * not visited in about seven days. A user who saves a world, closes the tab and
 * comes back next month can find it gone, with nothing having failed and nothing
 * having warned them.
 *
 * The Storage Standard's answer is `navigator.storage.persist()`: an origin can
 * ask to be exempt. Browsers decide differently — Chromium grants it silently
 * based on engagement, Firefox prompts, Safari grants it for installed web apps
 * — so the answer is genuinely three-valued and the app must be able to say
 * which one it got rather than assume the good one.
 *
 * ## When it is asked
 *
 * Once, after the first successful save. Asking on page load would spend a
 * permission prompt on a user who has not yet chosen to keep anything, and
 * asking on every save would re-ask forever in browsers that answer "no".
 */

/** The slice of `navigator.storage` used here; injected so it can be tested. */
export interface StorageManagerHost {
  persist?(): Promise<boolean>;
  persisted?(): Promise<boolean>;
}

/**
 * Whether saved worlds are exempt from eviction.
 *
 * - `persisted` — the browser granted it; saves survive until deleted.
 * - `evictable` — the browser declined; saves are still real, and the browser
 *   may reclaim them under pressure or after a long absence.
 * - `unsupported` — no Storage API, so there is nothing to ask and no promise
 *   to relay. Not the same as declined, and the UI must not say it is.
 */
export type StoragePersistence = "persisted" | "evictable" | "unsupported";

/**
 * Ask for persistent storage, or report that it is already granted.
 *
 * Never throws: a browser that rejects the call, or implements one half of the
 * API and not the other, must not take a save down with it. A failure means the
 * same thing to the user as a refusal — the data is evictable — so it is
 * reported as such rather than as an error.
 */
export async function requestPersistentStorage(
  host: StorageManagerHost | undefined,
): Promise<StoragePersistence> {
  if (host === undefined || typeof host.persist !== "function") {
    return "unsupported";
  }
  try {
    if (typeof host.persisted === "function" && (await host.persisted())) {
      return "persisted";
    }
    return (await host.persist()) ? "persisted" : "evictable";
  } catch {
    return "evictable";
  }
}

/** One-line explanation of a {@link StoragePersistence}, for the worlds panel. */
export function describeStoragePersistence(state: StoragePersistence): string {
  switch (state) {
    case "persisted":
      return "Saved worlds are exempt from automatic eviction.";
    case "evictable":
      return "The browser may reclaim saved worlds under storage pressure or after a long absence.";
    case "unsupported":
      return "This browser does not say whether saved worlds can be evicted.";
  }
}
