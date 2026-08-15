import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WorldsPanel,
  type PersistenceStatusView,
  type SavedWorldView,
  type WorldsPanelProps,
} from "./WorldsPanel";

/**
 * The saved-worlds panel renders as static markup here, like the other panel
 * tests: what matters is that the state a user must be able to see is actually
 * in the document — a failure, a legacy save, an unloadable one — rather than
 * only reachable through a click sequence.
 */

function world(overrides: Partial<SavedWorldView> = {}): SavedWorldView {
  return {
    worldId: "w1",
    worldName: "Eden",
    seedHex: "0xE0A12026",
    latestTick: 12_500,
    savedAtIso: "2026-08-14T10:00:00.000Z",
    saveCount: 3,
    engineVersion: "0.9.0",
    stateHash: "4deffe4b6f223a2b",
    totalBytes: 3_145_728,
    status: "ok",
    statusDetail: "",
    isCurrent: false,
    loadable: true,
    branch: null,
    ...overrides,
  };
}

function status(overrides: Partial<PersistenceStatusView> = {}): PersistenceStatusView {
  return {
    worldId: null,
    worldName: null,
    busy: false,
    autosaveArmed: false,
    lastSavedTick: null,
    message: "Not saved yet",
    failed: false,
    storageNote: null,
    branchNote: null,
    ...overrides,
  };
}

function render(overrides: Partial<WorldsPanelProps> = {}): string {
  const noop = (): void => {};
  return renderToStaticMarkup(
    <WorldsPanel
      worlds={[world()]}
      status={status()}
      tick={12_500}
      suggestedName="World 0xE0A12026"
      autosaveIntervalTicks={2000}
      unavailableReason={null}
      onSave={noop}
      onLoad={noop}
      onDelete={noop}
      onRefresh={noop}
      {...overrides}
    />,
  );
}

describe("WorldsPanel", () => {
  it("lists a stored world with its tick, hash and size", () => {
    const html = render();
    expect(html).toContain("Eden");
    expect(html).toContain("12,500");
    expect(html).toContain("4deffe4b6f223a2b");
    expect(html).toContain("3.0 MB");
    expect(html).toContain("3 saves");
  });

  it("offers Save, Load and Delete", () => {
    const html = render();
    expect(html).toContain(">Save<");
    expect(html).toContain(">Load<");
    expect(html).toContain(">Delete<");
  });

  it("says the world has never been saved, and that autosave waits for that", () => {
    const html = render({ worlds: [] });
    expect(html).toContain("No saved worlds yet");
    expect(html).toContain("Autosave starts once this world has been saved once");
  });

  it("reports autosave cadence once a world is bound", () => {
    const html = render({
      status: status({ worldId: "w1", worldName: "Eden", autosaveArmed: true }),
    });
    expect(html).toContain("every 2,000 ticks");
  });

  it("shows a failure prominently instead of hiding it", () => {
    const html = render({
      status: status({
        message: "Save failed: the browser's storage quota is full.",
        failed: true,
      }),
    });
    expect(html).toContain("worlds-status failed");
    expect(html).toContain("storage quota is full");
  });

  it("explains a legacy save and disables loading it", () => {
    const html = render({
      worlds: [world({ status: "legacy", engineVersion: "0.4.0", loadable: false })],
    });
    expect(html).toContain("kept but cannot be loaded");
    expect(html).toContain("disabled");
  });

  it("explains a corrupt world without offering to delete the evidence silently", () => {
    const html = render({
      worlds: [world({ status: "corrupt", statusDetail: "payload checksum mismatch" })],
    });
    expect(html).toContain("could not be read");
    expect(html).toContain("payload checksum mismatch");
    // Still listed, still loadable-in-principle: older saves may be fine.
    expect(html).toContain(">Load<");
  });

  it("marks the world that is currently open", () => {
    const html = render({
      worlds: [world({ isCurrent: true })],
      status: status({ worldId: "w1", worldName: "Eden" }),
    });
    expect(html).toContain("world-row current");
    expect(html).toContain("• open");
  });

  it("says plainly when storage is unavailable at all", () => {
    const html = render({
      unavailableReason: "IndexedDB is not available in this browser context",
    });
    expect(html).toContain("IndexedDB is not available");
    expect(html).not.toContain(">Save<");
  });

  it("disables its buttons while a save is in flight", () => {
    const html = render({ status: status({ busy: true }) });
    expect(html).toContain("Working…");
    expect(html).toContain("disabled");
  });

  it("names a branch's parent and branch tick on its row (ADR 0025)", () => {
    const html = render({
      worlds: [world({ branch: { parentName: "Eden", branchTick: 5_000 } })],
    });
    expect(html).toContain("branched from");
    expect(html).toContain("Eden");
    expect(html).toContain("5,000");
  });

  it("says when a branch's parent no longer exists", () => {
    const html = render({
      worlds: [world({ branch: { parentName: null, branchTick: 42 } })],
    });
    expect(html).toContain("a deleted world");
  });

  it("shows the standing branch note while the open world is a branch", () => {
    const html = render({
      status: status({
        worldId: "w2",
        worldName: "Fork",
        branchNote: "This is a branch of “Eden”, diverging from tick 5,000.",
      }),
    });
    expect(html).toContain("This is a branch of");
    expect(html).toContain("diverging from tick 5,000");
  });
});
