# Adaptive milestone cycles (progress check) - contract

Binding for the team runtime, the terminal dashboard, the server control API, the visualizer and the docs. Set by Core on 2026-11-22 at the user's request, verbatim:

> "Milestones shouldnt continue without the previous one being fixed, remove the stale 3 tries, make it more adaptive or something. It should do it till its fixed, but not just spending tokens without getting things done, like a check for htis should be there"

Today `#runMilestone` → `failCycle` in `src/core/orchestrator.js` counts failed cycles and trips the circuit breaker at `maxFailedCycles` (`DEFAULT_MAX_FAILED_CYCLES = 3` in `src/core/config.js`), then asks the human (feedback / retry / skip / abort).

In the user's run this went wrong:
- m1 failed 3 cycles, but every cycle fixed the previous security finding and Hank then found a narrower one. That was real progress, and the fixed breaker stopped it anyway.
- Every failure reason in that run read `Hank reported [SECURITY_ISSUES]: Security audit`, so summary lines say nothing about progress.
- Cycle 4 passed after the human wrote "Continue till the bug is fixed".

## Rule
A milestone keeps cycling while it makes progress. It stops to ask the human only when it is stuck or has used its budget.

## Progress check (after every failed cycle)
Per failed cycle, the orchestrator records:
- the cycle number
- the full failure text: the failing gates' full reports, or Angela's full report, or "finished without [TASK_COMPLETE]"; never just the summary line
- `changed`: whether Dwight's delivered snapshot differs from the previous cycle's (for cycle 1, from the milestone's starting state)
- the tokens used by the cycle's invocations

The check runs in this order:
1. **Rule checks.** Deterministic, no model call. Each yields verdict `stalled`, source `rule`:
   - `no_change`: Dwight's snapshot is identical to the previous one.
   - `repeat`: the full failure text equals the previous failed cycle's after lowercasing and collapsing whitespace. Digits are kept, because "5 tests failed" → "3 tests failed" is progress.
2. **Michael's judgement.** Only if no rule fired:
   - Purpose `progress`, invocation key `<milestone>/cycle-N/michael/progress/attempt-N`.
   - Input: the milestone title and acceptance criteria, plus the failure history since the last human decision. Use at most the last 4 cycles, each failure text cut to about 1500 chars, each with `changed`.
   - Output: exactly one keyword, `[PROGRESS]` or `[STALLED]`, and one reason line.
   - **Progress:** the previous failure is resolved or clearly narrowed, and the new failure is a different or smaller problem.
   - **Stalled:** the same problem keeps coming back, even reworded; the work oscillates between two states; or it does not move toward the acceptance criteria.
   - A missing keyword, an error or a timeout counts as `stalled`, source `michael`, with reason `progress check failed: ...`.
3. **Counter.** `stalledCycles` is the number of consecutive stalled verdicts since the last human decision. A progress verdict resets it to 0.

## Trip: ask the human, whichever comes first
| Cause | Trips when | Default | Keys (flags > env > file > default) |
|---|---|---|---|
| `stalled` | `stalledCycles >= maxStalledCycles` | 2 | `--max-stalled N`, `SCRANTON_MAX_STALLED_CYCLES`, `maxStalledCycles` (1..10) |
| `budget` | tokens of this milestone's invocations since the last human decision >= `milestoneTokenBudget` | 500000 | `--milestone-tokens N`, `SCRANTON_MILESTONE_TOKEN_BUDGET`, `milestoneTokenBudget` (0 = off) |
| `limit` | failed cycles since the last human decision >= `maxFailedCycles` | 12 | unchanged: `--max-cycles`, `SCRANTON_MAX_FAILED_CYCLES`, `maxFailedCycles` |

- `maxFailedCycles` is now a safety cap only. Its default moves from 3 to 12, and the server / UI range is 1..50.
- Dreaming no longer lowers the Team cycle limit. Team runs stop applying the learned dreaming cycle cap (`dreamingCap` in `src/core/cli.js` and `src/server/control.js`), because a learned low cap would bring back a fixed early trip. Pipeline-side dreaming caps stay unchanged.
- After a human decision (feedback or retry), the stall counter, the failed-cycle count and the token window all reset.
- Skip and abort behave as today.

**Human-input card texts:**
| Cause | Title |
|---|---|
| `stalled` | `No progress on <m>: <reason>` |
| `budget` | `<m> used <N> tokens without passing` |
| `limit` | `<m> reached the cycle limit (<N>)` |

The reason text contains the last failure.

## Milestone order
- A milestone is never left unfinished automatically. The dependents of a non-passed milestone stay blocked, as today (`src/core/scheduler.js` `runDag`).
- **NEW:** while any milestone waits for a human decision, the scheduler starts no new milestone. Running milestones keep running. Once the decision is made, scheduling resumes at once; do not wait for another milestone to finish.
- "Skip milestone" stays as an explicit human choice; its dependents are blocked as today. The automatic `onBreaker: 'skip'` policy stays opt-in only.

## Events (Contract v1, additive)
- **New `progress_check`:** `{ milestoneId, cycle, verdict: 'progress'|'stalled', source: 'rule'|'michael', rule: 'no_change'|'repeat'|null, reason (<= 300 chars), changed, stalledCycles, maxStalledCycles, tokens, tokenBudget }`. `tokens` is the milestone's tokens since the last human decision.
- **`circuit_breaker` with state `tripped`** gains `cause: 'stalled'|'budget'|'limit'`, `stalledCycles`, `maxStalledCycles`, `tokens`, `tokenBudget`. Existing fields are unchanged; `failedCycles` / `maxFailedCycles` stay.
- **`run_started`** gains `maxStalledCycles` and `milestoneTokenBudget`; `maxFailedCycles` now means the safety cap.
- **Unchanged:** `cycle_result` and `milestone_finished`.
- **Recovery:** `run-recovery.js` uses the new default constants instead of the literal 3.

## Server control API (`src/server/control.js`, run start body)
- `maxCycles`: 1..50.
- **New `maxStalledCycles`:** 1..10.
- **New `milestoneTokenBudget`:** integer 0..20000000.
- Invalid values give 400, as today.

## UI (visualizer and terminal dashboard)
- **Current milestone:** show the cycle number, the last progress verdict and its reason, stalled X of maxStalled, and the tokens used against the budget. The meter's "failed cycles X/3" wording goes away.
- **Breaker card:** uses the titles above.
- **Run settings:**
  - the cycle control becomes "Cycle limit (safety)", 1..50, default 12
  - plus "Stop after N cycles without progress", 1..10, default 2
  - plus an optional token budget field, default 500000, 0 = off
- **Old servers:** tolerate events without the new fields (no progress info, old meter text).

## Ownership (2026-11-22 lanes)
- **Runtime (coder):** `src/**` (orchestrator, scheduler, config, cli, messages / prompts for Michael's `progress` purpose, keywords, agent/scripted.js scripted answers, state.js, log.js, run-recovery.js, dreaming caps, server control, dashboard) and `test/core/**`, `test/server/**`, `test/dashboard/**` with their fixtures.
- **UI (frontend):** `visualizer/**`, `test/visualizer/**`.
- **Docs (coder):** `README.md` (German), `docs/**`, `.env.example`, `.enma/live-activity-inventory.md`.
