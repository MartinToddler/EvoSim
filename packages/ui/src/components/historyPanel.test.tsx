import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HistoryPanel, type HistoryPanelProps } from "./HistoryPanel";

/**
 * The history panel rendered as static markup, like the other panel tests: the
 * states a user must be able to SEE — that this is a preview and read-only,
 * which tick it is, how far a replay has got, and why rewinding is unavailable —
 * have to be in the document, not only reachable through a click sequence.
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
    const html = renderToStaticMarkup(<HistoryPanel {...props({ canRewind: false })} />);
    expect(html).toContain("Save this world to explore its history");
    expect(html).toContain("disabled");
  });

  it("marks a branch's timeline as starting at its branch point", () => {
    const html = renderToStaticMarkup(
      <HistoryPanel {...props({ originTick: 5_000, presentTick: 8_000 })} />,
    );
    expect(html).toContain("tick 5,000");
    expect(html).toContain('min="5000"');
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
