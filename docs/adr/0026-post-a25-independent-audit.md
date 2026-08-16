# ADR 0026 — Independent adversarial audit of the post-A25 product

Status: accepted · Date: 2026-08-16 · Engine 0.8.0 unchanged · Protocol 9 unchanged ·
Snapshot schema 8 unchanged · Config schema 7 unchanged

ADR 0025 declared the post-A25 integrity gate PASS. This pass re-audited that claim
from the outside: no ADR conclusion, TASKS checkbox, test name or comment was taken as
evidence, and every claim was either traced in code or reproduced by running it.

The verdict is that ADR 0025's **ecological** work stands up completely — the
calibration table reproduces byte-exactly on an independent run — and that its
**history/branching** work shipped with a real defect in the one place nobody had
measured: what a rewind actually replays.

## 1. What was reproduced rather than believed

### 1a. The calibration table is honest (ADR 0025 §2d)

`pnpm sweep` was re-run independently over the documented seed family
(`FIXTURE_SEED + i × 7919`, i = 0…11), 10 000 ticks, plain `DEFAULT_CONFIG` on engine
0.8.0. Every published number reproduced **exactly**:

| Measure                          | ADR 0025 §2d claim   | Independently measured |
| -------------------------------- | -------------------- | ---------------------- |
| Survival                         | 12/12                | 12/12                  |
| Seeds refusing births at the cap | 0/12, max peak 6 677 | 0/12, max peak 6 677   |
| Seeds eating meat                | 12/12                | 12/12                  |
| Median meat eaten                | 1 580 620            | 1 580 620              |
| Carcass store under the cap      | 7/12, 3 zero-skip    | 7/12, 3 zero-skip      |
| Median carcasses skipped         | 3 082                | 3 082                  |
| Median final population          | 2 699                | 2 699                  |
| Median per-gene trait sd         | 0.0347               | 0.0347                 |
| Kills                            | 0                    | 0                      |

The seed family is derived and documented rather than hand-picked, and the whole
distribution — not a summary — is what the table reports. There is no cherry-picking
here. `kills = 0` is reproduced too, and remains an honestly stated limitation: what
ADR 0025 demonstrates is scavenging reachability, not active predation.

### 1b. The engine changes A22–A25 made were diagnostic-only

`git diff 427b12a..474d926 -- packages/engine/src` touches only `memoryReport`,
`hashEnvironment`, `StatisticsStore.approximateBytes`, `queryEntity`, fixtures and
tests. Nothing on the authoritative tick path moved, which is why those milestones
correctly shipped without an `ENGINE_VERSION` bump, and why the 0.7.0 hashes held
until ADR 0025's deliberate 0.8.0 change.

### 1c. The browser flows work on the production bundle

The full Playwright suite was run against `vite preview` of the production build with
real IndexedDB: 21 of 22 scenarios pass, including New World → preview → Create → tick 0
paused → Play, save → reload → load, drag-selects-then-View-this-time → return to
present, and branch → auto-open → parent untouched. The one failure is a pre-existing
test-harness timeout unrelated to this work (see §4).

## 2. The defect this audit found: a rewind replayed a history that never happened

**docs/06 §24 step 3 — "load commands after S through T" — was not implemented.**

A save taken at tick S embeds the command log _as it stood at S_. `WorldPersistence`
picked the newest save at or before the target and handed those bytes to the Worker;
`SimulationHost.#beginRewind` built the `Reconstruction` from that snapshot alone. Any
intervention accepted **after** that save but targeting a tick inside the replay window
was therefore absent from the replay.

Reproduced: a world saved at tick 40, given a `setGlobalTemperature` command at tick 40+,
run to 120, then rewound to 100 produced a state hash that differs from the live world's
own history at tick 100.

Why it mattered more than a cosmetic preview error:

- the preview claims "Viewing tick 1,500" while showing a world where the player's
  meteor was never dropped;
- **Branch From Here persists that reconstruction as a new world**, with a manifest
  naming the parent and the divergence tick — so a fiction is stored as the parent's
  history;
- default autosave cadence is 2 000 ticks and retention keeps 5 autosaves, so the window
  is not exotic: any target tick between a command and the next save hits it, and every
  old tick hits it once retention has pruned the saves that carried the commands.

The gate suite missed it because `branchEquivalence.test.ts` branches at a save tick and
replays a command-free window — it proves the replay machinery, never the command graft.

**Fix.** `Reconstruction` accepts the world line's full command log
(`ReconstructionOptions.authoritativeLog`) and re-cursors it to the restored engine's
tick: commands targeting earlier ticks become applied history, the rest stay pending.
The host passes the live engine's own log, which is append-only and therefore a superset
of every save's embedded prefix; the adoption validates that containment (same id, tick
and sequence for every command the save carried) and refuses a log from another world
line rather than fabricating history from it.

This is not an authoritative behaviour change: for a given (seed, config, command
stream) the engine produces exactly what it produced before, and every golden hash is
unchanged. What changed is _which command stream a rewind replays_ — previously an
incomplete one. `ENGINE_VERSION` therefore stays 0.8.0, deliberately.

## 3. The other findings, and what was done about them

| #   | Severity | Defect                                                                                                                                                                                        | Fix                                                                                                                                     |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P0       | Rewind/branch replayed without commands accepted after the base save (§2)                                                                                                                     | `authoritativeLog` graft; host passes the live log                                                                                      |
| 2   | P1       | A load the Worker REFUSES left the session bound to the refused world, so the next autosave wrote the still-running world's state into that world's manifest                                  | Loads bind provisionally; saving is suspended until the WORLD_READY that confirms adoption, and a refusal restores the previous binding |
| 3   | P1       | False fatal "world identity mismatch" banner on any in-session load or branch: a tick-0 preview digest was compared against every later WORLD_READY                                           | The invariant is checked by the session, against the created world only, and a mismatch now pauses the world and persists nothing       |
| 4   | P2       | A load during an open preview left the history panel describing the replaced world's past                                                                                                     | A load retires the rewind token and returns the status to live                                                                          |
| 5   | P2       | Autosave fired on historical telemetry (a past tick), producing a "Save failed" the user did not cause and resetting the cadence clock backwards; `saveOnHide` during a preview always failed | Both gated on live mode                                                                                                                 |
| 6   | P2       | `HistoryPanel`'s local selection survived a world switch, so "View tick N" could offer a tick below a branch's floor                                                                          | Selection clamped to the reconstructable range (`viewTargetFor`)                                                                        |
| 7   | P3       | `QUERY_STATE_HASH` with a target tick stepped the PREVIEW engine — the one mutating message with no historical guard                                                                          | Refused while previewing when it would advance; hashing the tick on screen still answers                                                |
| 8   | P3       | A branch that was written but could not be opened reported nothing, inviting a duplicate                                                                                                      | `branchHere` returns `{worldId, opened}`; the UI names the branch and says where to find it                                             |

Two findings were assessed and deliberately **not** changed:

- **`HISTORICAL_MODE_READY.earliestTick` is hardcoded to 0**, which is wrong for a branch
  world. No code reads the field — the panel's floor comes from the stored save list —
  so the honest options are a protocol change to remove it or a new engine concept to
  fill it. Recorded here as a known trap rather than papered over.
- **`?view=generator`** still builds a main-thread engine at mount and can step it
  10 000 ticks. It is a developer view, it is never persisted, and no Worker runs beside
  it; the product flow it would bypass is not reachable from it.

One documentation claim was corrected rather than coded around: ADR 0025 §5's row saying
"no cap-order filtering remains" overstates what the code guarantees. Ascending-slot cap
refusal still exists in `reproduction.ts`; the 0.6× calibration is what keeps the twelve
measured seeds away from it. The row now says that.

## 4. The pre-existing E2E failure

`world.spec.ts` scenario 4 ("selects an organism and shows its inspector detail") times
out at 300 s. It sweeps a 31×31 grid of canvas clicks looking for an organism to select.
The 0.8.0 calibration deliberately made worlds leaner — median population 2 699 against
5 156 — so the same sweep now finds a hit far less often on the same viewport. This is a
test-fidelity problem created by a _correct_ ecological change, not a product defect:
selection itself works (scenarios 7 and 10 select and inspect through other paths, and
the same click path passes on the mobile project). Left failing and stated rather than
quietly retuned, because the honest fix is to seed the sweep from a known organism
position and that is a test change this audit did not want to make under its own
deadline.

## 5. Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm build` — green.
- Golden fixture: all six canonical hashes unchanged (the fix adds an optional parameter
  and no default path uses it).
- `packages/engine/src/replay` — reconstruction, branch equivalence and the four new
  command-graft regression tests green.
- `apps/web` + `packages/ui` — 145 tests green, including nine new regression tests for
  findings 1–8.
- Playwright on the production bundle — 21/22 (see §4).
- Twelve-seed calibration sweep — reproduced exactly (§1a).
