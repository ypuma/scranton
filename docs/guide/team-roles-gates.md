# Team roles and gates

Configure the Team workflow and understand what gets reviewed, retried, and integrated.

[Back to the README](../../README.md)

## Parallelism, verification, and integration

Team defaults to Scranton's durable agent loop, up to three active milestone pipelines, private Git worktrees, and the Scranton OS sandbox. Instances are named `michael`, `dwight-m1`, `angela-m1`, and so on. Role names alone do not identify a chat recipient when work is parallel. Markdown mailboxes in the Hive and controlled instance chat connect the roles; final status keywords drive handoffs.

A plan declares `dependsOn`. Omitting it makes the milestone depend on its predecessor; `[]` means independent. Unknown, self, or cyclic dependencies are rejected. A dependency is satisfied only by successful verification **and safe integration**. Skipped or failed prerequisites do not release successors.

Scranton makes a private shadow repository even for dirty, uncommitted, or non-Git workspaces. `<hive>/isolation/` records the run's isolation location; on Windows the repository and worktrees normally live under `%LOCALAPPDATA%\Scranton\iso\<token>`, not in the Hive. On POSIX the Hive-local location is preferred when the path budget permits. See [isolation storage and cleanup](../ISOLATION.md#dateistände-und-sichere-übernahme). The user's repository is not used for internal branches or commits; HEAD, index, and history stay intact. Ignored dependencies/build outputs and known credential files are excluded. Install needed dependencies inside the private checkout. These exclusions are not a complete secret scanner.

After `[TASK_COMPLETE]`, Angela verifies a separate worktree made from exactly Dwight's developer snapshot. Only the developer snapshot that passed every gate can be integrated. Integration is serialized and compares target files with the original baseline; overlapping user edits are reported as conflicts rather than overwritten. Diagnostic worktrees are retained. Back up the workspace before real tasks; a worktree is not a backup.

**Retry is not a rebase.** The developer worktree keeps its immutable baseline, so the same conflict may recur. Abort, resolve the conflict deliberately outside the run and start fresh, or skip the milestone. Do not automatically delete user work or diagnostic artifacts. See [restore points and undo](restore-points.md).

## Built-in roles, gates, and system prompts

Michael plans, Dwight implements, Oscar reviews code, Hank reviews security, and Angela verifies acceptance criteria. Gate roles are instructed not to modify files; their shell can still write and their private checkouts are never integrated. The engine defaults to Angela alone for compatibility. To add code and security review before QA:

```powershell
node bin/scranton.js run "Review and implement the change" --gates "oscar+hank,angela"
node bin/scranton.js demo --scenario changes_once --gates "oscar,hank,angela" --delay 0
```

Equivalent config: `"workflow": {"gates": [["oscar", "hank"], ["angela"]]}`. A comma separates sequential stages; a plus joins concurrent gates. Each role may appear once; empty stages are invalid. Parallel results are evaluated in list order. One failed stage produces a combined report for Dwight and counts as one failed cycle. `[BLOCKED]` or infrastructure failures pause after the whole stage finishes; Retry repeats only that stage. Integration follows only after every gate passes. Automatic also applies in Docker. Oscar and Hank accept `SCRANTON_OSCAR_PROVIDER`, `SCRANTON_OSCAR_MODEL`, `SCRANTON_OSCAR_THINKING` and their `SCRANTON_HANK_*` counterparts.

Custom prompts are scoped to the data directory: `<hive>/prompts/<role>.md` or `<data>/prompts/<role>.md` in Registry mode. Precedence is explicit `agents.<role>.skill`, saved prompt, then built-in prompt. Frontmatter is removed. The workflow receives the resolved run snapshot; Docker gets no prompt mount. Edits apply to subsequent runs. Events record source and SHA-256, not prompt text. See [Control API §9](../CONTROL.md#9-roles-gate-workflow-and-custom-prompts).

## Custom agents and models

Under **Agents**, create up to twelve custom reviewers with a name, title, handoff instruction, allowed read tools, and unique success/failure keywords. Each agent has an editable system prompt. Without a saved prompt, Scranton generates a starter from its current definition; resetting restores the starter. Michael and Dwight remain fixed roles with configurable models and prompts. Custom agents are gates, not additional developers.

Model and Thinking are saved per agent in `agents.json` under `--data` or `--hive`. In every Team sandbox mode precedence is run selection, environment, `scranton.config.json`, `agents.json`, then Automatic. Environment- or config-pinned fields are locked in the editor. Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

```powershell
node bin/scranton.js agents --data .scranton-data
node bin/scranton.js agent set-model seclint --provider openai --model MODEL_ID --thinking high --data .scranton-data
node bin/scranton.js agent remove-model seclint --data .scranton-data
node bin/scranton.js run "Review the changes" --gates "oscar+seclint,angela" --hive hive
```

Create `seclint` first via **Agents** or `POST /api/agents` in the same data scope as the command. The last example uses Single-Hive mode, so define it in `hive` to use that example; the preceding model commands use `.scranton-data`. For a Registry run, also select the project/thread. Custom IDs contain 2–20 lowercase letters or digits, start with a letter, and have no hyphens. Updates affect the next run only. Invalid manual entries are skipped and reported under **Agents** and by `doctor`. See [Control API §10](../CONTROL.md#10-custom-agents-and-persistent-agent-settings).

## Circuit breaker and human decisions

A milestone keeps cycling while it makes progress. After a failed cycle, Scranton first checks without a model call: did Dwight deliver the same file state (`no_change`), or did the complete failure report repeat (`repeat`, ignoring case and whitespace)? Digits are preserved: “5 tests failed” differs from “3 tests failed.” Either rule counts as a stall. Otherwise Michael compares up to the last four cycles with the acceptance criteria and assesses whether the previous issue is resolved or clearly narrowed. Rewording or alternating variants of the same problem, or a failed progress check, also count as stalls.

Scranton asks for feedback, retry, skip, or abort once any threshold is reached:

| Trigger | Flag | Environment | Config | Default |
| --- | --- | --- | --- | --- |
| Consecutive cycles without progress | `--max-stalled N` | `SCRANTON_MAX_STALLED_CYCLES` | `maxStalledCycles` | `2` |
| Milestone agent tokens since the last human decision | `--milestone-tokens N` | `SCRANTON_MILESTONE_TOKEN_BUDGET` | `milestoneTokenBudget` | `500000` (`0` disables) |
| Failed cycles since the last human decision, as a safety cap | `--max-cycles N` | `SCRANTON_MAX_FAILED_CYCLES` | `maxFailedCycles` | `12` |

Flags override environment, then `scranton.config.json`, then defaults. HTTP fields are integer `maxStalledCycles` (1–10), `milestoneTokenBudget` (0–20000000), and `maxCycles` (1–50). See [Control API](../CONTROL.md).

A progress verdict resets the stall count; feedback or retry resets stalls, failed attempts, and the token window. While any milestone waits, no new milestone starts; active pipelines continue. Scheduling resumes immediately after the decision, while dependents still wait for successful prerequisites. Skip is explicit, including opt-in automatic skip with `--on-breaker skip`. `[BLOCKED]` and infrastructure errors go directly to a human after all gates in the stage finish and do not count as failed cycles. Human questions are serialized. Abort affects all active processes.

### File-based decisions

With `--on-breaker hive`, Scranton publishes `<hive>/human/request.json` while waiting. It contains `v`, `runId`, `requestSeq`, `milestoneId`, `title`, `reason`, `options`, and `ts`. Copy `runId` and `requestSeq` unchanged and choose from `options`; no need to read `events.jsonl`. Write `<hive>/human/response.json` atomically (temporary file, then rename):

```json
{ "v": 1, "runId": "run-id", "requestSeq": 42, "decision": "feedback", "feedback": "Please test the missing criterion.", "ts": "2026-11-08T12:00:00.000Z" }
```

Use `v:1`, a matching run ID and sequence, and an ISO timestamp. `feedback` needs nonblank text, at most **16000 characters**. Other decisions are `retry`, `skip`, or `abort` if listed. Scranton archives the response and removes the request when waiting ends. A hard crash can leave the request behind; successful recovery removes it. See [file-based human answers](../CONTROL.md#1-file-based-human-answers-the-hive-stays-the-communication-layer).

## Conversation mode

```powershell
node bin/scranton.js run "How is this codebase organized?" --conversation
node bin/scranton.js demo --scenario question --conversation
```

The CLI shows role messages and a separate reply at the end. Michael can answer a question directly without a plan or milestones. After a planned task, he writes a closing report; on failure or timeout a deterministic summary replaces it. The demo illustrates the question path without a model call.

The engine and CLI default to off (`--no-conversation`); enable it with `--conversation`, `execution.conversation:true`, or `SCRANTON_CONVERSATION=1`. The web UI sends `conversation:true`. In Registry mode, earlier replies can enter [bounded follow-up context](projects-chats-context.md#context-system), not a full transcript. Replies are untrusted text; no extra tools or grants are enabled.

Only in conversation mode does Michael's staged prompt get an extra section for planning, answering, or reporting. Stored prompts are unchanged. Failed report text remains visible as an agent message. The CLI and terminal dashboard remove control and bidi characters from messages; large suppressed terminal messages do not push visible events out of the event tail.
