# Scranton dreaming — implementation contract (2026-11-15)

## Goal and source interpretation
Implement project-scoped dreaming for Registry/Desktop projects, serving BOTH Team and Pipeline chats. Sources read by Core: https://arxiv.org/html/2609.14858v1 (Dream-RSI) and https://docs.openclaw.ai/concepts/dreaming.

These are two mechanisms, not synonyms: Light/REM/Deep consolidates sourced observations; Dream-RSI evaluates alternative exploration policies on immutable historical outcomes. Scranton will use **bounded retry policies** on observed attempt chains, not invent independent discovery worlds from dependent milestones, modify executable policy code, or claim scientific benchmark improvements. No Python procedural-graph duplication or modification is needed for this design.

- Replay never runs agents, tools, models, code, checks or network. A generic replay library may support root/leaf branching, but actual adapters expose only genuinely observed chains/branches. Candidate decisions see revealed state only. Preserve recorded order; exhausted continuations are unknown, not failures/successes. Evaluate incumbent on the same frozen worlds; tie favors incumbent. Score Q - 0.05*N + 0.02*N/max(1,rounds), Q normalized observed evaluation result. No quality regressions on any usable world accepted. No claimed wall-time savings from hypothetical concurrency.
- Scope learned policy to engine, retry ceiling, and an explicit 64-hex `cohort` digest of the actual evaluation recipe (gate/workflow identity or required-check identities/configuration, NOT run/step IDs). Missing/unknown cohorts cannot enter replay or policy adoption; runtime must match the current cohort. Scope learned policy to this evidence cohort; minimum 3 complete eligible worlds before recommendation. Run cap candidates 1..5 plus incumbent within operator ceiling. Adoption is separately opt-in and can ONLY reduce retry limits, never increase configured limits, skip required steps/checks, change model/tools, grant permissions, or approve any gate. Fix the chosen value at next run start. An unseen longer continuation is unsupported. Human-intervened/truncated/ambiguous attempt chains are excluded with explicit counts/reasons. Do not call Pipeline failed attempts delivered changes.
- Light deduplicates eligible terminal-run observations by source identity/digest; REM deterministically groups recurring structured outcomes; Deep uses weights .30 relevance/.24 frequency/.15 task diversity/.15 recency/.10 multi-day recurrence/.06 richness, default minScore .65, minRecallCount 2, minUniqueQueries 2 (distinct original task digests, not sweep repeats). No LLM required; UI/docs explicitly call this deterministic, not model-generated. Sources are structured verified outcomes, NOT arbitrary model/tool/web prose or recalled/diary memory. Do not synthesize causal fix instructions from matching a diagnostic string. Keep observations descriptive and sourced. Apply revalidates live artifact digests. Repeated sweeps must not add reinforcement by themselves.
- Persistent state under <dataDir>/projects/<projectId>/dreaming only (no user workspace MEMORY.md). Bounded JSON authority + human-readable MEMORY.md/DREAMS.md projections; diary is never read as evidence. Versioned memory/policy preimages and rollback; unrelated entries retained. Atomic writes, owner lock, bounded files/collections, reject all symlink/reparse traversal, no silent repair of malformed state, fail closed on invalid UTF-8. No secrets/log/output/raw task text in derived memory; task digest for diversity. Cold empty sweep need not create MEMORY.md/DREAMS.md. Read/preview is nonmutating. Last sweep, phases, counts, limitations, source references visible.
- Background sweep opt-in (enabled:false by default), intervalMinutes:360 default (15..10080), only project-idle and no recovery blockers. Timer unref + stop on server close. No model cost. applyPolicy:false default is independent of enable. Disable retains memory/history and stops automatic sweeps. Busy operations refuse/defer; no concurrent project sweeps; settings/policy changes affect next run only.
- Project memory is bounded (16 KiB stored, <=2000 chars injected), explicitly advisory historical data, never evidence, never instructions superseding current task. At injection revalidate sources; stale references excluded. Existing same-chat history preserved; no fabrication of past runs to carry project memory.

## Shared API (freeze names; tell Core before changing)
New core module `src/core/dreaming/index.js` exports `createDreaming({ dataDir, projectId, collect, isBusy = () => false, now = () => Date.now() })`.
- `collect()` synchronously returns `{ episodes: [...], limitations: [...] }`; adapter owned by integration lane in `src/core/dreaming-sources.js`. See episode schema below. Adapter limitations use core-exported ADAPTER_LIMITATIONS fixed safe codes/text only; unknown arbitrary strings are represented by count, never exposed. May extend diagnostics with counts, but agree in writing.
- methods synchronous unless explicitly async implementation agreed: `status()`, `preview()`, `sweep()`, `configure({enabled?, intervalMinutes?, applyPolicy?})`, `rollback()`, `context()` (string <=2000 chars), `structuredContext()` (live-source-revalidated array of `{id,text,sources:[string]}`, <=16 entries, <=400 chars/text, <=3 refs/entry <=240 chars/ref, <=2000 chars serialized total; same provenance gates as context), `policy(engine, ceiling, cohort)` (returns null or validated <= ceiling cap only for exact current evaluator cohort; missing/unknown => null), `close()`.
- No internal timer in core; integration owns idle scheduler and shutdown. `sweep()` does collect, phases/replay, revalidation, persistence. `preview()` same computation but NO writes. `rollback()` restores latest preimage only, retains audit trail. Scope validated on factory creation.

Episode schema:
```
{ id, engine: 'team'|'pipeline', chatId, runId, taskHash, observedAt: ISO,
  outcome: 'success'|'partial'|'failed'|'aborted', complete: boolean, intervened: boolean, retryCeiling: integer, cohort?: '<64hex evaluator-recipe digest>',
  sources: [{ path: '<relative to dataDir>', sha256: '<64hex>' }],
  attempts: [{ id: string, scope: string, ordinal: positive integer,
               result:'passed'|'failed', quality: 0|1 }],
  observations: [{ key: string, text: string, verified: boolean }]
}
```
Episodes are a single autonomous retry chain (usually milestone/step; split if several). Unique id includes chat/run/scope. Sources MUST identify existing regular nonlinked artifacts; owner root and project boundaries validated. Observations are deterministic allowlisted descriptions of structured recorded results, not agent-authored text. An unavailable source or incomplete chain stays out of promotion/recommendation. No source acquisition from external legacy hives outside selected dataDir. taskHash hashes original task without exposing it. Unknown metadata prevents replay, not invention. More detailed source line coordinates optional.

Status/result payload (all methods return this unless noted):
```
{ v:1, projectId, enabled, applyPolicy, intervalMinutes, state:'idle'|'busy'|'error',
  lastSweepAt: ISO|null, nextSweepAt: ISO|null, canRollback:boolean,
  counts:{episodes,candidates,promoted,worlds},
  phases:[{name:'light'|'rem'|'deep',status:string,count:number}],
  memory:[{id,text,score,sources:[{path,sha256}],promotedAt}],
  candidates:[{id,text,score,eligible,reasons:[string],signals:{...},sources:[...]}],
  replay:{ objective:string, worlds:number, evaluations:[{engine,cohort,cap,score,quality,attempts,rounds,eligible,reasons:[string]}],
           recommendations:[{engine,cohort,cap,baselineCap,rationale}],limitations:[string]},
  diary:[{id,at,text,promoted:number}], limitations:[string],
  preview?:boolean
}
```
Empty arrays/zeros/null are explicit. Errors throw `.status` HTTP code and concise safe `.message` (no raw secrets). Bound returned lists. Memory/candidate/replay UI never renders HTML from strings. Pending previews marked read-only and not saved status.

Registry HTTP (integration owner):
- GET `/api/projects/:projectId/dreaming` -> status payload.
- POST `/api/projects/:projectId/dreaming/preview` `{}` -> preview payload, no write.
- POST `/api/projects/:projectId/dreaming/sweep` `{}` -> saved result.
- POST `/api/projects/:projectId/dreaming/settings` `{enabled?,intervalMinutes?,applyPolicy?}` -> saved status.
- POST `/api/projects/:projectId/dreaming/rollback` `{}` -> restored status.
Use existing loopback/Host/Origin/JSON/X-Scranton-Client guards and strict bodies. Reuse 409 busy behavior. No unsupported endpoints that run arbitrary paths/commands.
CLI: `scranton dreaming status|preview|run|on|off|rollback --data DIR --project ID [--json]`. Optional policy/interval CLI settings only if same validator; document exact flags. Registry projects only, helpful error in single/demo mode.

## Pipeline-specific bridge (Python owner and integration owner coordinate)
Existing `check_finished` only emits id/status/duration, not sufficient to retroactively bind all old parallel attempts: DO NOT infer old per-attempt scores from final status/GroundEval summaries. New Python event `dream_attempt` emits schema:1 plus `scope`, `ordinal`, `result` ('passed'/'failed'), `quality` (0/1), `plan_revision`, and `retry_ceiling` at authoritative applied/rejected attempt evaluation points. Include only identifiable ordinary step/revision chains; lanes must retain unique scope. Pipeline `run_resumed` additionally emits typed `data:{gate,decision,has_feedback:boolean}` from the validated resume decision (true iff nonempty user feedback/comment, false only if absent/empty, never raw feedback); Node treats only explicitly proven clean approvals as non-intervention and excludes legacy/missing/unknown resume metadata. No baseline/integration check or approval outcome counts as a coding attempt. No check outputs/prompt/secret values. Missing/no required checks => not eligible, emit explicit reason or omit with adapter coverage caveat. Node reads this event on completed future runs; legacy Pipeline histories can contribute valid final structured observations but have no attempt replay until upgraded evidence exists. Without per-event selected-check recipes, Pipeline replay/adoption additionally abstains if any required final-scope check exists or no required step check exists; eligible cohorts hash required step-check id/kind/argv/timeout_s/scope and require the same current recipe.

Python history adds OPTIONAL `project_memory` to existing schema:1: array <=16 of `{id,text,sources:[string]}` text<=400, refs<=240, <=3 sources each. Old 3-key payload preserved/accepted unchanged. runs may be [] ONLY when project_memory nonempty. Total bytes stays 32768. Node passes this field; do not disguise memory as a fabricated history run. history_block trims project memory before existing priority plan/task/outcome under pressure; memory-only context works. Mark not current evidence/advisory, redact, strip false E/K/H citation-like tokens. No new graph routes/guidance graph/writes to source.

## Ownership
- Core library worker: `src/core/dreaming/**`, `test/core/dreaming/**` only.
- Node integration worker: `src/core/dreaming-sources.js`, `src/core/projects.js`, `src/core/cli.js`, `src/core/thread.js`, `src/core/pipeline-history.js`, `src/core/pipeline-supervisor.js`, `src/server/registry-router.js`, `src/server/control.js`, `src/server/visualizer-server.js`; matching test files or new `test/core/dreaming-integration.test.js`, `test/server/dreaming.test.js`; README.md, docs/DREAMING.md, docs/CONTROL.md. No library files or Python/UI.
- Python worker: `engine/src/scranton_pipeline/dreaming.py`, `engine/src/scranton_pipeline/history.py`, `engine/src/scranton_pipeline/nodes/workflow.py`, `engine/src/scranton_pipeline/agents/prompts.py`, new dreaming tests plus existing history tests if needed; `engine/docs/ARCHITECTURE.md`. No Node/UI.
- Frontend worker: `visualizer/public/**`, `test/visualizer/**`. No server/library/docs. Add a project Dreams control/panel following nav + Agents drawer conventions. No global scope stealing or forced chat selection; stale project responses cannot repopulate another project. Show scheduling toggle, independent policy opt-in, preview/sweep/rollback, phase progress/result, memory/candidate gates + provenance, replay baselines/comparisons/limits, narrative diary, empty/busy/error/unsupported single-mode states. Strictly monochrome, accessible controls, responsive/scrollable, textContent.

## Verification and constraints
Read existing contracts/conventions, no new runtime deps. Tests serialized with shared run_shell lock `scranton-tests`; no live models/Docker installs/releases/commits/push. Scratch .scratch/dreaming-<lane> or .scratch/pipeline/dreaming-<lane>. Node full gate after all work: `node --test "test/**/*.test.js"`. Core/browser preview owned by Core. Python venv `.scratch/pipeline/venv/Scripts/python.exe`; reuse actual existing test/config commands after checking. New regressions must fail against removed guard/fix (mutation negative control or exact tested reversion), record concise evidence. Independent reviewer at final meaningful boundary.
