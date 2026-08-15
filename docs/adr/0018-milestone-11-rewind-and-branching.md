# ADR 0018 — Milestone 11: rewind, historical mode and branching

Status: accepted · Date: 2026-08-15 · Protocol 6 → 7 · Tasks K07–K11

Milestone 11 makes a world's past reachable: any earlier tick can be reconstructed, previewed
read-only, and used as the origin of an independent branch. No engine behaviour changed, so
`ENGINE_VERSION` stays 0.7.0 and every golden hash is unmoved — this milestone reads history, it
does not rewrite it.

## 1. Tick semantics, restated because rewind is where they bite

Milestone 9 fixed the convention (ADR 0015): `step()` applies the commands targeting the current
tick, runs the phases, then increments. Rewind depends on it completely, so the consequences are
spelled out here:

| Question                            | Answer                                                 |
| ----------------------------------- | ------------------------------------------------------ |
| A save taken at tick S holds…       | the state **before** S's commands run                  |
| Replay from S to T is…              | exactly `T − S` steps                                  |
| Commands applied during that replay | those targeting `[S, T−1]`                             |
| A command targeting exactly T       | **not** applied — it belongs to the step that leaves T |
| A target that has its own save      | zero ticks replayed, zero commands applied             |

`SimulationEngine.fromSnapshot` already enforces the matching invariant on a restored log: applied
commands target ticks before the snapshot tick, pending ones target it or later. That single
invariant is what lets a branch be defined by _truncation_ rather than by filtering (§3).

## 2. Reconstruction model

```text
state at T = newest save at tick S <= T + the command log that save carries + (T − S) steps
```

Nothing stores full state per tick. This is only sound because authoritative state is a pure
function of (seed, config, commands, engine version).

`Reconstruction` is **resumable** rather than one-shot. Replaying tens of thousands of ticks in one
synchronous call would freeze the Worker, stall the message port and make progress reporting
impossible. The stepping stays inside the engine, so yielding between slices cannot change where a
replay lands — the host chooses _when_ ticks run, never _how_.

Save selection lives in `selectSaveForTick`: newest at or before the target, ties broken on the
lowest snapshot id. Ties are real (a manual save and an autosave can share a tick), and without an
explicit rule the choice would follow storage iteration order — two clients would replay from
different bytes. They would still reach the same state, but "correct by luck" is not a property
worth relying on.

## 3. Branch model

A branch is a **new world** (docs/06 §30): its own manifest, its own saves, its own future. It
stores one thing from its parent — a `branch` save holding the state at the branch tick — and
records `parentWorldId` and `branchTick` as provenance. `worldOriginTick` reads the one rule that
follows: a branch's timeline starts where it diverged, because it does not own its parent's earlier
saves.

`prepareBranchSnapshot` turns a save of tick B into that origin by **dropping the pending command
suffix**. Those commands target ticks at or after B — the restore invariant guarantees it — so they
are the parent's _future_, not the history the branch inherits. A player who queued a meteor for
B+100 and then branched at B did not ask for that meteor in the new world.

What is deliberately **kept** is the identity counters (`nextCommandId`, `nextSequence`). Continuing
them means a branch's own commands can never collide with an inherited id or sequence.

The applied prefix is untouched, which is what makes the equivalence exact: a branch with no
commands of its own replays precisely the history its parent replayed.

## 4. Why rewinding is split across the port

Neither side can rewind alone. The database lives on the main thread; the engine lives in the
Worker. So the main thread picks the save — it is the only side that can see the saves — and sends
the bytes with `REQUEST_REWIND`; the Worker restores them into a **second** engine and replays it,
reporting `REWIND_PROGRESS` per slice and finishing with `HISTORICAL_MODE_READY`. Protocol 7 adds
those, plus `RETURN_TO_PRESENT`, `CREATE_BRANCH` and the `"branch"` save reason.

`REQUEST_SAVE` refuses that reason: a branch origin needs the parent's queued future stripped first,
which only `CREATE_BRANCH` can do.

## 5. A preview can never touch the present

Four independent barriers, because one would be a comment and four are a design:

1. the reconstruction is a **second engine** built from save bytes; the live engine is never
   rewound, advanced or handed to historical code, which is why "return to present" is a mode
   switch rather than a reload;
2. read-only projections follow a **view engine** (`#viewEngine()`), so the inspector, tree, event
   feed and state-hash query describe the tick on screen — while everything that _changes_ state
   deliberately does not;
3. the **host** refuses interventions and saves while previewing and ignores time controls, so a UI
   bug that leaves a button enabled still cannot edit the present;
4. the live world is **paused** before reconstruction starts, so the target is not a goalpost that
   moves while you approach it.

## 6. Stale reconstructions

A scrubber asks for ticks far faster than a replay can answer. Two mechanisms, one per side:

- the **Worker** cancels any replay in flight when a new `REQUEST_REWIND` arrives, so two replays
  never interleave slices;
- the **main thread** issues every rewind under a token and records the request id it was sent
  with, so a slower older reconstruction cannot install itself over a newer one when it finally
  answers, and progress from an abandoned replay cannot move the newer one's bar.

Returning to the present invalidates the token too — otherwise a rewind that resolves just after
you left would drag you back into the past.

## 7. What a world must have before it can be rewound

A save. Reconstruction replays _from_ one, so a world that has never been saved has no earliest
point to replay from, and a tick older than the oldest save cannot be reached at all. Both are
refused explicitly and explained in the panel rather than approximated by landing somewhere near.

This is a real limitation of the checkpoint model, not an oversight: the alternative — regenerating
from the seed and replaying the whole command log — is unbounded work that grows with world age,
and it would still need the log, which is stored inside saves.

## 8. Verification

The acceptance property is proven on the **populated** world (organisms, species, carcasses,
events, PRNG stream), not a bare environment:

- control to 10 000 ticks ≡ branch taken at 5 000 with no new commands, run to 10 000 — identical
  canonical hash, population and species count;
- ≡ branch taken at **6 234**, a tick with no save of its own, reconstructed from the 5 000 save
  plus 1 234 replayed ticks;
- a branch-only command diverges the branch while the original's save still restores to its hash
  and still runs forward to the same 10 000 hash;
- two branches from one save stay independent.

Around it: reconstruction against uninterrupted runs at save ticks and between them, replay
idempotence, event non-duplication across repeated navigation, slice-size independence, host
behaviour through a real message port, session-level save selection and staleness, and the panel's
rendered states.
