import { describe, expect, it } from "vitest";
import {
  RenderHeader,
  createRenderSnapshotBuffer,
  viewRenderSnapshot,
  type RenderSnapshotView,
} from "@eon/protocol";
import { findOrganismIndex, pickOrganism } from "./pickOrganism";

/**
 * Selection hit-testing (task G09, docs/06 §6).
 *
 * The tie-break rule is the one worth guarding: two organisms at the same
 * distance must resolve by lowest entity ID, not by whichever the loop reached
 * first. Storage order changes as slots are reused, so an order-dependent pick
 * would make clicking the same spot select different animals over time.
 */

interface Organism {
  id: number;
  x: number;
  y: number;
  radius: number;
}

function snapshot(organisms: readonly Organism[]): { view: RenderSnapshotView; count: number } {
  const view = viewRenderSnapshot(createRenderSnapshotBuffer(Math.max(1, organisms.length), 1));
  organisms.forEach((organism, index) => {
    view.organismId[index] = organism.id;
    view.organismX[index] = organism.x;
    view.organismY[index] = organism.y;
    view.organismRadiusLU[index] = organism.radius;
  });
  view.header[RenderHeader.OrganismCount] = organisms.length;
  return { view, count: organisms.length };
}

describe("pickOrganism", () => {
  it("finds an organism under the point", () => {
    const { view, count } = snapshot([{ id: 5, x: 100, y: 100, radius: 2 }]);
    const hit = pickOrganism(view, count, 101, 100, 0);
    expect(hit?.entityId).toBe(5);
    expect(hit?.index).toBe(0);
    expect(hit?.distanceLU).toBeCloseTo(1, 6);
  });

  it("misses when the point is outside body plus tolerance", () => {
    const { view, count } = snapshot([{ id: 5, x: 100, y: 100, radius: 2 }]);
    expect(pickOrganism(view, count, 105, 100, 1)).toBeNull();
    // …and hits once tolerance covers the gap.
    expect(pickOrganism(view, count, 105, 100, 3)?.entityId).toBe(5);
  });

  it("prefers the nearest of several candidates", () => {
    const { view, count } = snapshot([
      { id: 1, x: 100, y: 100, radius: 5 },
      { id: 2, x: 102, y: 100, radius: 5 },
      { id: 3, x: 110, y: 100, radius: 5 },
    ]);
    expect(pickOrganism(view, count, 102.4, 100, 0)?.entityId).toBe(2);
  });

  it("breaks an exact tie by lowest entity id, whatever the storage order", () => {
    const ascending = snapshot([
      { id: 7, x: 100, y: 100, radius: 3 },
      { id: 4, x: 100, y: 100, radius: 3 },
      { id: 9, x: 100, y: 100, radius: 3 },
    ]);
    expect(pickOrganism(ascending.view, ascending.count, 100, 100, 0)?.entityId).toBe(4);

    const reordered = snapshot([
      { id: 4, x: 100, y: 100, radius: 3 },
      { id: 9, x: 100, y: 100, radius: 3 },
      { id: 7, x: 100, y: 100, radius: 3 },
    ]);
    expect(pickOrganism(reordered.view, reordered.count, 100, 100, 0)?.entityId).toBe(4);
  });

  it("only considers the live prefix, not stale columns beyond the count", () => {
    // A snapshot buffer is recycled, so the tail still holds the previous
    // frame's organisms. Reading past the count would select the dead.
    const view = viewRenderSnapshot(createRenderSnapshotBuffer(8, 1));
    view.organismId[0] = 1;
    view.organismX[0] = 0;
    view.organismY[0] = 0;
    view.organismRadiusLU[0] = 1;
    view.organismId[5] = 99;
    view.organismX[5] = 200;
    view.organismY[5] = 200;
    view.organismRadiusLU[5] = 10;

    expect(pickOrganism(view, 1, 200, 200, 5)).toBeNull();
    expect(findOrganismIndex(view, 1, 99)).toBe(-1);
  });

  it("returns null for an empty world", () => {
    const { view } = snapshot([]);
    expect(pickOrganism(view, 0, 0, 0, 100)).toBeNull();
  });

  it("never reads past the column length", () => {
    const { view } = snapshot([{ id: 1, x: 0, y: 0, radius: 1 }]);
    // A count larger than the buffer would be a protocol fault; it must clamp
    // rather than read undefined.
    expect(() => pickOrganism(view, 9999, 0, 0, 1)).not.toThrow();
    expect(pickOrganism(view, 9999, 0, 0, 1)?.entityId).toBe(1);
  });
});

describe("findOrganismIndex", () => {
  it("locates an entity present in the frame", () => {
    const { view, count } = snapshot([
      { id: 11, x: 0, y: 0, radius: 1 },
      { id: 22, x: 5, y: 5, radius: 1 },
    ]);
    expect(findOrganismIndex(view, count, 22)).toBe(1);
  });

  it("reports -1 for an entity that is not in this frame", () => {
    const { view, count } = snapshot([{ id: 11, x: 0, y: 0, radius: 1 }]);
    // The selected organism died, or the snapshot was truncated. Callers use
    // this to stop drawing a ring, not to clear the selection.
    expect(findOrganismIndex(view, count, 12345)).toBe(-1);
  });
});
