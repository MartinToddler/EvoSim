import { describe, expect, it } from "vitest";
import {
  describeStoragePersistence,
  requestPersistentStorage,
  type StorageManagerHost,
} from "./storagePersistence";

/**
 * Persistent-storage request (task M07). The cases that matter are the ones
 * where the app must not lie to the user about whether their worlds are safe.
 */
describe("requestPersistentStorage", () => {
  it("reports a grant", async () => {
    const host: StorageManagerHost = {
      persisted: () => Promise.resolve(false),
      persist: () => Promise.resolve(true),
    };
    expect(await requestPersistentStorage(host)).toBe("persisted");
  });

  it("does not re-ask when it is already granted", async () => {
    let asked = 0;
    const host: StorageManagerHost = {
      persisted: () => Promise.resolve(true),
      persist: () => {
        asked += 1;
        return Promise.resolve(true);
      },
    };
    expect(await requestPersistentStorage(host)).toBe("persisted");
    expect(asked).toBe(0);
  });

  it("reports a refusal as evictable rather than as failure", async () => {
    const host: StorageManagerHost = {
      persisted: () => Promise.resolve(false),
      persist: () => Promise.resolve(false),
    };
    expect(await requestPersistentStorage(host)).toBe("evictable");
  });

  it("distinguishes 'no API' from 'declined'", async () => {
    expect(await requestPersistentStorage(undefined)).toBe("unsupported");
    expect(await requestPersistentStorage({})).toBe("unsupported");
  });

  it("works where persist() exists but persisted() does not", async () => {
    const host: StorageManagerHost = { persist: () => Promise.resolve(true) };
    expect(await requestPersistentStorage(host)).toBe("persisted");
  });

  it("treats a thrown API as evictable and never propagates", async () => {
    const host: StorageManagerHost = {
      persisted: () => Promise.reject(new Error("blocked")),
      persist: () => Promise.resolve(true),
    };
    await expect(requestPersistentStorage(host)).resolves.toBe("evictable");
  });

  it("describes every state, and never calls 'unsupported' a refusal", () => {
    expect(describeStoragePersistence("persisted")).toMatch(/exempt/);
    expect(describeStoragePersistence("evictable")).toMatch(/reclaim/);
    const unsupported = describeStoragePersistence("unsupported");
    expect(unsupported).toMatch(/does not say/);
    expect(unsupported).not.toMatch(/reclaim/);
  });
});
