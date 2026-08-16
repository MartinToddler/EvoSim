import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HistoryPanel, viewTargetFor, type HistoryPanelProps } from "./HistoryPanel";

/**
 * The history panel rendered as static markup, like the other panel tests: the
 * states a user must be able to SEE — that this is a preview and read-only,
 * which tick it is, how far a replay has got, and why rewinding is unavailable —
 * have to be in the document, not only reachable through a click sequence.
 *
 * Interaction semantics (dragging never launches a rewind; only the explicit
 * "View this time" button does) are covered by the browser E2E suite, which is
 * where pointer events actually exist.
 */

function props(overrides: Partial<HistoryPanelProps> = {}): HistoryPanelProps {
  return {
    mode: "live",
    presentTick: 12_500,
    originTick: 0,
    historicalTick: null,
    progress: null,
    saveTicks: [0, 2_500, 10_000],
    message: "",
    failed: false,
    canRewind: true,
    onRewind: () => {},
    onReturnToPresent: () => {},
    onBranch: () => {},
    ...overrides,
  };
}

describe("HistoryPanel", () => {
  it("says it is live, and offers no branch control, in the present", () => {
    const html = renderToStaticMarkup(<HistoryPanel {...props()} />);
    expect(html).toContain("Live");
    expect(html).not.toContain("read only");
    expect(html).not.toContain("Branch from this tick");
  });

  it("is unmistakably read-only while previewing, and names both ticks", () => {
    const html = renderToStaticMarkup(
      <HistoryPanel {...props({ mode: "historical", historicalTick: 3_548 })} />,
    );
    expect(html).toContain("Historical preview — read only");
    expect(html).toContain("3,548");
    expect(html).toContain("12,500");
    expect(html).toContain("interventions are disabled");
    expect(html).toContain("Branch from this tick");
  });

  it("shows replay progress with an accessible value", () => {
    const html = renderToStaticMarkup(
      <HistoryPanel
        {...props({
          mode: "reconstructing",
          progress: { ticksReplayed: 750, ticksTotal: 1_000 },
          message: "Reconstructing tick 5 000…",
        })}
      />,
    );
    expect(html).toContain("Replaying 750 of 1,000 ticks");
    expect(html).toContain('aria-valuenow="75"');
  });

  it("explains why an unsaved world cannot be rewound, instead of offering it", () => {
    const html = renderToStaticMarkup(
      <HistoryPanel {...props({ canRewind: false, saveTicks: [] })} />,
    );
    expect(html).toContain("Save this world to explore its history");
    expect(html).toContain("disabled");
  });

  it("treats a bound world with zero stored saves as not rewindable", () => {
    // canRewind only says the world is bound to storage; with no saves there is
    // nothing to replay from, and the panel must not offer a range that would
    // fail on use.
    const html = renderToStaticMarkup(<HistoryPanel {...props({ saveTicks: [] })} />);
    expect(html).toContain("Save this world to explore its history");
  });

  it("offers exactly the reconstructable range: the scrubber floor is the earliest save", () => {
    // A legacy world saved for the first time at tick 2 500: ticks 0…2 499
    // exist but cannot be rebuilt (ADR 0018 §7), so they are not offered.
    const html = renderToStaticMarkup(<HistoryPanel {...props({ saveTicks: [2_500, 10_000] })} />);
    expect(html).toContain('min="2500"');
    expect(html).toContain("History before tick 2,500 was not stored");
  });

  it("does not show the unavailable-history note when the origin is reachable", () => {
    const html = renderToStaticMarkup(<HistoryPanel {...props()} />);
    expect(html).not.toContain("was not stored");
    expect(html).toContain('min="0"');
  });

  it("surfaces stored checkpoint ticks as visible, selectable chips", () => {
    const html = renderToStaticMarkup(<HistoryPanel {...props()} />);
    expect(html).toContain("Saved checkpoints:");
    expect(html).toContain('aria-label="select saved tick 2,500"');
    expect(html).toContain('aria-label="select saved tick 10,000"');
  });

  it("renders an explicit View this time action, idle until a time is selected", () => {
    const html = renderToStaticMarkup(<HistoryPanel {...props()} />);
    expect(html).toContain('data-testid="view-this-time"');
    expect(html).toContain("View this time");
    // No selection yet: the button is disabled — releasing the scrubber handle
    // must never be what starts a replay (docs/06 §13).
    expect(html).toMatch(
      /data-testid="view-this-time"[^>]*disabled|disabled[^>]*data-testid="view-this-time"/,
    );
  });

  it("marks a branch's timeline as starting at its branch point", () => {
    // A branch's earliest save is its origin save at the branch tick; nothing
    // earlier belongs to it.
    const html = renderToStaticMarkup(
      <HistoryPanel
        {...props({ originTick: 5_000, presentTick: 8_000, saveTicks: [5_000, 7_000] })}
      />,
    );
    expect(html).toContain("earliest 5,000");
    expect(html).toContain('min="5000"');
    expect(html).not.toContain("was not stored");
  });

  it("shows a failure without hiding the rest of the panel", () => {
    const html = renderToStaticMarkup(
      <HistoryPanel
        {...props({ message: "Rewind failed: no save at or before tick 100", failed: true })}
      />,
    );
    expect(html).toContain("history-panel__message--failed");
    expect(html).toContain("no save at or before tick 100");
  });
});

describe("viewTargetFor", () => {
  const bounds = { minTick: 2_000, maxTick: 12_500, shownTick: 12_500 };

  it("offers nothing until a time is selected", () => {
    expect(viewTargetFor({ ...bounds, selected: null })).toBeNull();
  });

  it("offers a selected tick inside the reconstructable range", () => {
    expect(viewTargetFor({ ...bounds, selected: 5_000 })).toBe(5_000);
  });

  it("offers nothing when the selection is already the tick on screen", () => {
    expect(viewTargetFor({ ...bounds, selected: 12_500 })).toBeNull();
    expect(viewTargetFor({ ...bounds, shownTick: 5_000, selected: 5_000 })).toBeNull();
  });

  it("never offers a tick below the floor, however the selection got there", () => {
    // A selection made in the previous world survives a switch to a branch or
    // a loaded world with a later floor. Offering it would produce a rewind the
    // new world cannot serve — an error where the control should simply never
    // have pointed there.
    expect(viewTargetFor({ ...bounds, selected: 0 })).toBe(2_000);
    expect(viewTargetFor({ ...bounds, minTick: 8_000, selected: 3_000 })).toBe(8_000);
  });

  it("never offers a tick after the present", () => {
    expect(viewTargetFor({ ...bounds, selected: 99_000 })).toBeNull();
    expect(viewTargetFor({ ...bounds, maxTick: 4_000, selected: 99_000 })).toBe(4_000);
  });
});
