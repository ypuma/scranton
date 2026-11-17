# Project dreaming

Dreaming has two separate mechanisms for registered Team and Pipeline projects: local **deterministic structural consolidation** (zero model calls), and optional **model reflection** producing a reviewed proposal. Both are off by default for background work. Ordinary runs and deterministic preview/sweep never initiate reflection. Single-hive/demo mode is not an evidence source.

## Two different source concepts

- [OpenClaw dreaming](https://docs.openclaw.ai/concepts/dreaming) motivates Light/REM/Deep consolidation: deduplicate sourced observations, group recurring structural outcomes, then apply explicit weighted promotion gates.
- [Dream-RSI](https://arxiv.org/html/2609.14858v1) motivates evaluating exploration policies against frozen observed outcomes. Scranton adapts this to bounded retry caps on actual autonomous attempt chains. Dependent milestones are not independent simulated discovery worlds.

These mechanisms complement one another; they are not synonyms or a reproduction of either upstream system. The structural mechanism is not generative. Optional reflection below is separate: neither mechanism is causal repair advice, executable policy evolution, a scientific benchmark or a measured runtime-speedup claim. Python procedural graphs/guidance remain separate and unchanged.

## Evidence and limits

`src/core/dreaming-sources.js` reads only bounded regular, nonlinked files beneath the selected registry project's data directory. External legacy Hive references, malformed/oversized/unterminated journals, ambiguous continuations, truncation and human-intervened chains are excluded or visibly marked unavailable. No fallback follows artifact-controlled paths.

Team uses recorded `cycle_result` chains and, for staged workflows, matching `gate_result` evidence. The evaluation cohort hashes ordered gate stages, audited gate definitions and prompt hashes. Unknown evaluator identity prevents policy replay/adoption. A completed autonomous milestone is required for its descriptive terminal observation.

Pipeline uses upgraded `dream_attempt` events containing `schema:1`, scope, ordinal, result, quality, plan revision and retry ceiling. Scope is the Python-emitted JSON string `[plan_revision,"step:<id>"|"rev:<round>",null|[wave,slot,stepId]]`, not a plain step string. The adapter validates revision/lane consistency, sequential ordinals, binary result/quality agreement and a consistent positive ceiling no greater than the configured budget (a revised scope can have less remaining allowance); ambiguous or malformed chains never become replay worlds. Independently valid terminal delivery facts remain available when attempt binding fails. `run.json.demo:true` excludes the entire run independently of resume handling. Clean approval resumes require explicit `run_resumed.data:{gate,decision:"approve",has_feedback:false}` from the upgraded runner; bare legacy/unknown resumes, feedback, rejection and suspension remain excluded from autonomous evidence. No feedback text is stored in this metadata. Old `check_finished` events cannot reliably bind checks to parallel step attempts: **legacy histories contribute only explicit terminal structural observations, never invented attempt worlds**. Failed attempts are not delivered changes. Without selected-check recipes per event, replay/adoption abstains when any required final-scope check exists or no required step check exists. Otherwise cohorts hash required step-check IDs, kinds, argv, timeouts and scopes; current runtime configuration must match exactly.

Collection is bounded to 128 entries per scanned directory, 512 emitted episodes, 10,000 events per journal, 2 MiB per journal, 256 KiB per metadata artifact and 16 MiB total artifact reads per collection. Over-limit histories degrade conservatively rather than reading arbitrary files. Idle detection is separate from evidence collection: it scans up to 10,000 chats and runs per directory, checks Team ownership/state (including imported legacy Hives) and Pipeline terminal statuses, and also honors live Registry controllers/recovery blockers. An inert imported Hive is not inherently busy, but remains excluded as evidence with a visible caveat. Unsafe, unreadable or over-limit liveness inventories defer with an explicit cannot-establish-idle error, never silently idle or permanently busy merely for exceeding the 128-entry evidence cap. The library separately bounds persisted episodes and returned lists.

Task diversity uses SHA-256 of original tasks; raw tasks, prompts, log/check outputs and agent prose never become durable **structural** Dreaming memory. Descriptions come from fixed allowlisted structural outcome templates, not diagnostic strings. Source references and digests remain visible. The original histories may still contain sensitive material; Dreaming does not sanitize or delete those originals. Local hashes/paths are provenance, not anonymization or a security boundary against another process with write access.

## Consolidation and replay

Light deduplicates by source identity/digest. Repeated sweeps do not add evidence. REM groups deterministic outcomes. Deep uses relevance .30, frequency .24, distinct-task diversity .15, recency .15, multi-day recurrence .10 and richness .06; defaults require score .65, two recalls and two distinct task digests.

Replay compares the incumbent and retry caps 1–5 within the existing operator ceiling on the **same** frozen cohort. Score is `Q - 0.05*N + 0.02*N/max(1,rounds)`; quality is the recorded binary evaluation, not model judgment. At least three complete eligible worlds, known continuations, strict objective improvement and no per-world quality regression are required. Ties keep the incumbent. Unobserved continuation remains unknown; it is never synthesized as success or failure.

Learning is not application. `applyPolicy:false` is independent of background `enabled:false`. Opt-in application fixes `min(operator ceiling, learned cap)` once at the next real run start, only for an exact engine/ceiling/evaluator cohort. It cannot increase limits, change tools/models, remove required steps/checks, grant permissions, approve plans/deliveries or waive gates. Team adjusts failed-cycle ceiling; Pipeline adjusts `max_step_attempts`. Explicit user ceilings remain upper bounds. Active/resumed runs are not retuned.

## Storage, scheduling and advisory context

Authority is bounded JSON at `<data>/projects/<id>/dreaming/state.json`; `MEMORY.md` and `DREAMS.md` are human-readable projections, not source evidence. Nothing writes a workspace `MEMORY.md`. The library uses atomic writes, an owner lock, a latest versioned preimage and rollback/audit trail; malformed authority fails closed, without silent repair. Read/status/preview do not save state. An empty initial sweep need not create files.

The Registry server polls once per minute with an unref'd timer. Enabled projects sweep when due (default 360 minutes; range 15–10080), only while all project chats are idle and no recovery blocker exists. Suspended/approval-waiting Pipeline runs and Team ownership files block sweeping. Busy operations return 409. Disable retains memory and stops automatic sweeps; server close clears the timer and closes Dreaming instances. Scheduling requires a running Registry server; `dreaming on` does not leave a CLI daemon running.

At next-run planning, sources are revalidated against live digests. Stale memory and policy proofs are excluded. Team's Dreaming source remains capped at 2000 characters before context packing. The context system places it in the advisory memory layer within the recipient model's estimated-token budget, using only space left after this chat and sibling context; the layer may be shortened or dropped. The legacy fallback retains the combined 8000-character thread-context bound and drops memory as a whole rather than cut the newest same-chat run. Pipeline preserves schema 1 and adds optional `project_memory:[{id,text,sources:[string]}]` (at most 16 entries, 400 characters per text, three references per entry, 2000 serialized characters overall). Memory-only history uses `runs:[]`, never fabricated past runs; without a wire `budget`, complete history stays within 32768 UTF-8 bytes. With `budget` (`H = history_bytes`, `C = context_bytes`), Node uses at most `max(32768, H + C)` bytes and Python accepts at most 262144 bytes; planner history allowance is `min(H, max_prompt_bytes // 4, room)` instead of the legacy `min(12000, max_prompt_bytes // 8, room)`. See [PIPELINE.md](PIPELINE.md#cross-run-continuity). Under pressure memory yields before historical plans/tasks/outcomes. Current task, fresh evidence, approvals and mandatory checks remain authoritative. Failure to load optional Dreaming context or policy (including corrupt/unsafe authority while disabled) does not prevent an ordinary new Team/Pipeline run: both memory and learned policy are discarded, configured retry ceilings and all gates remain intact, and a fixed safe warning is exposed as Team control `dreamingWarning` or Pipeline start-response `dreamingWarning`. Unrelated run/configuration errors still fail normally. Explicit Dreaming status/preview/sweep/settings/rollback operations continue to report corrupt authority fail-closed.

## CLI

```text
node bin/scranton.js dreaming status --data DIR --project ID --json
node bin/scranton.js dreaming preview --data DIR --project ID --json
node bin/scranton.js dreaming run --data DIR --project ID --json
node bin/scranton.js dreaming on --data DIR --project ID
node bin/scranton.js dreaming off --data DIR --project ID
node bin/scranton.js dreaming rollback --data DIR --project ID
```

`SCRANTON_DATA` may supply the data directory. Status/preview are nonmutating, run performs one explicit sweep, on/off only change scheduling, rollback restores the latest preimage. No policy/interval CLI flags are implemented; use the settings API/UI. JSON results share the HTTP payload, including phases, counts, candidates, memory provenance, replay comparisons, diary and limitations.

## Registry HTTP

All routes require the existing loopback peer, local Host, exact Origin when supplied and `X-Scranton-Client: 1` guards. POSTs require JSON objects <=262144 bytes and reject extra fields. Errors are safe `{error:string}` payloads; Single mode returns 409 `single_mode`.

| Route | Body | Result |
|---|---|---|
| `GET /api/projects/:id/dreaming` | none | status |
| `POST /api/projects/:id/dreaming/preview` | `{}` | read-only preview |
| `POST /api/projects/:id/dreaming/sweep` | `{}` | saved sweep |
| `POST /api/projects/:id/dreaming/settings` | `{enabled?,intervalMinutes?,applyPolicy?}` | saved status |
| `POST /api/projects/:id/dreaming/rollback` | `{}` | restored status |

All structural-route successes return 200 and the frozen version-1 status payload. Settings booleans are strict; intervals are integers 15–10080. There are no arbitrary-path or command-execution endpoints. Preview is a proposal, not saved memory.

## Integration checks

Focused Node tests cover source privacy/provenance, legacy abstention, exact cohorts, source revalidation, policy opt-in/ceilings, HTTP guards and busy states, CLI, runtime argument/config snapshots, memory-only history, idle scheduling and shutdown. These are synthetic filesystem/fake-process checks, not real-model continuation, native desktop lifecycle or measured coding-quality improvement. Run affected suites serialized under the project test lock before a full combined gate.

Known bounded-storage limits: under retention pressure, promotion timestamps, exclusion labels and diary promotion counts can be approximate. A nearly full legacy authority record can reject even settings/disable changes rather than discard the exact rollback preimage. A crash can leave an orphan Dreaming lock; stop all Scranton processes using that data directory, back up the project Dreaming directory, and verify that no owner remains before offline lock recovery. Do not remove a live owner's lock or silently repair corrupt authority. These are storage/operational limitations, not evidence of measured coding-quality improvement.

## Claude-inspired optional reflection

This is inspired by selective transcript-grounded consolidation, not a claim to implement a public Claude Code `/dream` command. Official Code docs document auto memory and `/memory`; the research snapshot found no documented public `/dream`. A third-party extracted consolidation prompt is not availability or trigger proof. Managed Agents Dreams is a **different product**, with an asynchronous billed output-store workflow. Sources and confidence boundaries: [CLAUDE_CODE_DREAMING_RESEARCH.md](CLAUDE_CODE_DREAMING_RESEARCH.md).

Reflection sends **redacted historical excerpts to the selected authenticated provider/model** and may consume paid tokens or subscription quota. Redaction is best effort, not anonymization. Review source histories before enabling this for sensitive projects. The adapter selects at most four recent completed non-demo/internal runs, at most eight signals and 1000 text characters per run (4000 overall). Human feedback/corrections precede original tasks; assistant replies are explicitly separate from recorded terminal/check/process outcomes. No raw tool bodies, check output, checkpoints or source code are collected. Pipeline gate comments are not present in the safe journal projection and are not recovered from checkpoints. Unsafe, redirected, missing, malformed and over-limit artifacts are excluded with fixed safe limitations. Provenance hashes describe original artifacts, not redacted strings; quotations must match the actual supplied redacted signals. A quote proves availability, **not truth or semantic support**. Unknown secret formats can remain.

Team reflection run/signal identities and attempt fingerprints do not change when the recorder archives the latest live journal. Provenance uses the canonical project/chat `hive/runs/<originalRunId>/events.jsonl` locator; the service resolves only that location or, while absent, the same chat's fixed live `hive/events.jsonl`. All rows must match the original run identity and terminal sequence, and the exact original SHA-256 is rechecked. A changed or unsafe existing archive invalidates the note without falling back or searching matching copies elsewhere. Links and hardlinks are refused. No original history is rewritten. Missing optional Pipeline reply files do not imply incomplete coverage; malformed replies do. The privacy disclosure above remains applicable even when adapter coverage is complete.

Settings add `reflectionEnabled:false`, `reflectionModel:null` (provider/model string), `reflectionMaxOutputTokens:2048` (256–4096), and `reflectionTimeoutSeconds:60` (10–60). Manual propose requires a selected authenticated catalog model even if automatic reflection is disabled. One fresh tool-less completion has at most 12000 input characters across system+user, 4096 output characters, the configured output-token cap and a hard maximum 60-second deadline. Characters are not tokens; usage/cost is reported only when known, never inferred as a dollar estimate.

The transport uses Pi's installed SDK `ModelRuntime.streamSimple({maxTokens})` in a dedicated child, not an agent session or an invented CLI flag. It disables tool/resource/session discovery by not constructing those services, removes Node preload variables, bounds streams and validates supported API payload token caps before inference. **Authenticated catalog selection alone does not imply transport compatibility**: the `google-antigravity` (Google Antigravity) native transport is rejected before runtime creation or streaming because its adapter does not invoke the pre-send `onPayload` validation hook; ChatGPT subscription requests omit `max_output_tokens` in installed Pi and are rejected before inference; `openai-codex-responses`, `pi-messages`, `mistral-conversations` and unknown APIs are rejected pending verified cap behavior. Existing custom provider/auth stores are reused; arbitrary endpoint compliance is not independently guaranteed. No real-provider round trip was used for these integration tests.

Automatic generation requires both scheduling `enabled` and `reflectionEnabled`, a configured authenticated model, project idle, new input fingerprint and no pending proposal. It **never applies automatically**. The service performs synchronous preflight, exposes running before returning its Promise, watches project activity and aborts immediately through the in-process service on explicit run starts. Shutdown awaits owned completion cleanup; ordinary runs never wait for optional reflection cleanup. Separate short commit locks and an owned reflection lease prevent overlapping writes/jobs; no state commit lock is held over a model request. Another process observes activity through the fallback busy watcher rather than a shared AbortController.

Known cross-process deletion limitation: same-process project deletion awaits owned reflection cleanup, but a separate CLI `dreaming propose` can race Registry project deletion and recreate part of the project's data directory. `removeProject` does not coordinate with the other process's `.reflection-job` lease. Cancel or wait for CLI reflection to finish before deleting the project. Cross-process deletion/lease locking is not implemented; same-process cleanup does not provide that guarantee.

Review typed `user|feedback|project|reference` notes with actual before/after, reasons and source quotations. Apply/reject names the exact proposal ID. Adds/replacements require evidence, user/feedback notes require user evidence; replacement/removal can target generated notes only. Invalid/stale/late/cancelled results cannot promote notes or alter deterministic replay. Limits: 12 operations, three expanded evidence references per new note, 16 accepted notes and 16 KiB stored. Original source digests, configuration and base are rechecked at persistence and application. Accepted notes remain advisory, revalidated at next-run injection within the existing combined 2000-character budget; same-chat history wins. This is **compact injection, not on-demand topic-file retrieval**.

Pending proposal is `proposal.json`; `state.json` remains authority for accepted memory and rollback. `MEMORY.md` indexes bounded `NOTES.md` projections, not new source evidence. No workspace `CLAUDE.md` or source files are written. Rollback restores the latest accepted-state/settings preimage, not historical provider spend. Attempt fingerprints survive rollback (including failed/no-op/cancelled requests; bounded to 64, then further generation refuses). Reject discards the proposal; cancel aborts generation without applying it. Crash-orphan reflection leases require the same exclusive offline recovery discipline as owner locks above.

Additional routes (same guards and strict JSON bodies as above):

| Route | Body | Result |
|---|---|---|
| `GET /api/projects/:id/dreaming/proposal` | none | reflection status |
| `POST /api/projects/:id/dreaming/propose` | `{provider?,model?}` | 202 complete status after synchronous preflight |
| `POST /api/projects/:id/dreaming/proposal/apply` | `{proposalId}` | 200 complete status |
| `POST /api/projects/:id/dreaming/proposal/reject` | `{proposalId}` | 200 complete status |
| `POST /api/projects/:id/dreaming/cancel` | `{}` | 200 complete status |

GET status includes `reflection:{state,jobId,startedAt,finishedAt,error,usage,proposal,memory,limitations}`. States are idle/running/ready/failed/cancelled. Settings also accepts the four reflection fields. Propose uses provider+model, a combined model string, or the configured model; invalid prerequisites return 400/409, never a misleading 202. A 202 means job accepted, not model compatibility, completion or memory adoption. Background rejection is caught; poll status for completion/failure.

CLI: `dreaming propose [--provider P --model M]` awaits the result; `dreaming apply --proposal ID`, `dreaming reject --proposal ID`, `dreaming cancel`, each with `--data DIR --project ID` and optional `--json`. Existing `dreaming run` stays deterministic. These offline integration tests do not establish live provider compatibility or improved coding quality.
