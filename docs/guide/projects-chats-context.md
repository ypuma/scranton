# Projects, chats, and context

Register workspaces, continue a chat, and choose what context carries forward.

[Back to the README](../../README.md)

## Projects and chats

A project corresponds to a folder on your computer. Each chat is a thread with its own run history and Hive. **Follow up** starts a new run in the same thread. Scranton rebuilds bounded context from past turns and project knowledge, not full Pi transcripts or reused Pi sessions. Live instance chat for steering agents is separate.

In **New project**, **Browse...** opens the native folder picker in the desktop app. Selecting a folder only fills the editable absolute workspace path. **Create project** registers it after server-side validation; cancelling the picker leaves the previous value. In a regular browser enter the absolute path by hand. Leaving the field empty uses the default projects folder.

Projects and chats can run concurrently, but only one run at a time per chat. The registry-wide limit is `maxConcurrentRuns` or `SCRANTON_MAX_RUNS` (default **4**); blocking Team run leases count. Pipeline counts live Python processes toward that limit; a waiting gate without a process still blocks a new run in that chat. `--parallel` instead limits Team milestone pipelines within one run. Chats and pipelines using the same subscription share its rate limit.

```powershell
node bin/scranton.js projects add "My App" --data .scranton-data --workspace C:\Projects\MyApp
node bin/scranton.js projects list --data .scranton-data
node bin/scranton.js chats PROJECT-ID --data .scranton-data
node bin/scranton.js run "Implement the first version" --data .scranton-data --project PROJECT-ID
node bin/scranton.js run "Add tests" --data .scranton-data --project PROJECT-ID --chat CHAT-ID
node bin/scranton.js visualize --data .scranton-data
node bin/scranton.js projects remove PROJECT-ID --data .scranton-data
```

Copy IDs from the lists. Without `--chat`, `run` creates a thread. With it, the command adds a run to that thread. In Registry mode, the project sets the workspace and the chat sets the Hive, so `run` does not take additional `--workspace` or `--hive` flags. To create a missing folder, use `projects add ... --create`; without `--workspace`, the folder is created under `Documents\Scranton\projects\<id>`. The same real folder cannot be registered twice. Removing a project never changes workspace files. `--delete-history` also removes the associated Scranton data under the data directory.

`--data DIR` (or `SCRANTON_DATA`; for some commands, config `dataDir`) enables the registry. `run --project` or `--chat` requires explicit `--data` or inherited `SCRANTON_DATA`. Otherwise, the CLI does not read a default registry; it suggests a complete command with the desktop data directory. Workspace `.env` and `scranton.config.json` cannot select a run's registry and are not loaded for explicit Registry runs. The started run prints project/chat IDs and a continuation command. `visualize --data` also enables control; keep it local. `projects` and `chats` without a data path use the desktop data directory; `projects list` reports `dataDir` in its JSON.

Single mode with `--hive` and `--workspace` remains available without a registry. The UI shows the implicit project and chat with ID `default`, without project/chat management. The terminal dashboard remains bound to one Hive. See the [Control API and storage layout](../CONTROL.md#8-projekte-chat-threads-und-run-historie).

## Context system

A **turn** is a run that is no longer running: its request and result, including errors or interruptions. The next turn's advisory **context pack** is rebuilt deterministically from disk, without a model call or reuse of a Pi session. This applies only in Registry/desktop mode. Single-Hive behavior does not change. Projects never share context with each other.

### Layers and priority

The read/display order is project notes, Dreaming memory, other chats in the project, older own-chat turns as one-liners, then recent own-chat turns in detail. The newest own turn is last. Budget priority differs: newest turn in detail, notes within their allowance, other recent own turns (newest first), older own turns, other chats, then Dreaming. The current request wins. Notes are subordinate user preferences; this chat outranks other chats, and newer context outranks older. Own turns that do not fit are condensed or explicitly counted as omitted.

### Context budgets and limits

Tokens are estimates, not provider-measured counts. No tokenizer is used: ASCII and `…` count as one unit per code point (about four English ASCII characters per token), other code points through U+2E7F count as two, and higher ones count as four. Divide by four and round up.

Set a project-wide share of the model window (default **10%**, range **1–50%**) or a fixed budget (**1000–200000 tokens**). Up to **32** model-specific `provider/model` overrides take precedence over the project rule. Team caps the effective budget at half the window and **200000 tokens**, except that the **256-token** floor takes priority. Unknown windows are assumed to be **128000 tokens** and marked as assumed. The Planner (id `michael`) and the Developer (id `dwight`) have separate budgets based on their models.

| Limit (`src/core/context/limits.js`) | Value |
| --- | --- |
| Team planning (Planner) | Model-specific budget; section allowances and detailed turns scale with it (at most **12** detailed turns); transport at most **800000 characters**. |
| Team implementation (Developer) | One tenth of its effective budget, at least **250**, at most **2000 tokens**, never above its own budget; notes and condensed own turns, no other chats, memory, or replies. |
| Stored project notes / Dreaming source | **16000 characters / 65536 bytes** for notes; **2000 characters** for Dreaming before pack budgeting. |
| Other chats | At most **6 chats × 3 turns**; leftover budget only. |
| Pipeline prompt | **4000–18750 estimated tokens** for history and context together under the engine prompt budget, not the full model window. |
| Pipeline transport with `budget` | Notes **16000 code points**, earlier turns **64 × 240**, other chats **6 × 3 × 240**; Python allows **65536 UTF-8 bytes** for `context`, **262144 bytes** overall; Node also enforces its computed byte allowances. |
| Inputs | Team request **32768 characters**; live agent messages and human feedback **16000 characters** each; Pipeline task **32768 UTF-8 bytes** and gate comment **4000 characters**. |
| Turn collection | At most **500** own runs; **12** most recently updated sibling chats with **4** newest runs each; shared read budget **64 MiB**. The Pipeline recent-run/plan-anchor selection can separately read additional artifacts as needed. |

Input character limits count JS string length, while truncation preserves whole code points. Team includes the full notes when they fit in half the pack budget; otherwise it marks them as shortened. When space is tight, detailed turns lose files, then plan, reply, and request, before becoming a one-liner. The Code Reviewer (`oscar`), the Security Auditor (`hank`), the QA Tester (`angela`), and custom gates receive no new context. The Developer gets the brief on tasks and retries, even with no planning.

Only the Pipeline planner gets history and a separate `conversation_context` block. With byte allowances `H` and `C`, the respective prompt limits are `min(H, max_prompt_bytes // 4, room)` and `min(C, max_prompt_bytes // 8, room)`. Implementer and reviewer prompts are unchanged. Without `budget`, the [existing wire and prompt caps](../PIPELINE.md#cross-run-continuity) apply. Other chats supply only condensed lines, never `runs` entries.

### Inspect, edit, and reset context

When context is in use, the **Context** row under **Follow up** shows `≈` tokens and the share of the model window. It opens a drawer with usage, budget, a meter, the model ID and window size, any cap, collapsible layers, and the Team developer brief. Usage is shown in tokens and percentages of both the budget and window. Percentages show `0` for no use, `<0.1` below 0.1 percent, one decimal if the one-decimal rounded value is below 10, and a rounded integer otherwise (9.96 becomes `10`, not `10.0`).

Select percent or fixed tokens, the value, and optionally **Only for <model id>**. **Reset to default** removes the effective model override or, if none applies, the project rule. The drawer asks before discarding unsaved budget or notes edits. Pipeline budget previews stay within **4000–18750 tokens**; changing the planner model reloads the chat document. Team layers show the text injected; Pipeline layers show a readable projection, not the literal prompt.

**Share context between the chats of this project** defaults to on per project. Turning it off stops both sending and receiving the other-chats layer. Edit and save notes in the drawer; an empty note clears the content. **Start fresh from here** hides turns started at or before the marker from all packs, including other chats' views. It does not delete history. **Restore earlier turns** removes the marker. Neither changes project notes or Dreaming memory. Edits affect subsequent turns, not running prompts.

```text
node bin/scranton.js context show    --data DIR --project ID [--chat ID] [--model PROVIDER/MODEL] [--json]
node bin/scranton.js context budget  --data DIR --project ID (--percent N | --tokens N | --default) [--model PROVIDER/MODEL]
node bin/scranton.js context notes   --data DIR --project ID (--file FILE | --clear)
node bin/scranton.js context share   --data DIR --project ID on|off
node bin/scranton.js context reset   --data DIR --project ID --chat ID
node bin/scranton.js context restore --data DIR --project ID --chat ID
```

`context budget` sets the project rule without `--model`, or that model's override with it. `--default` removes the selected rule. `context show --chat` prints `Budget: ≈<used>/<tokens> tokens` with budget and window percentages, window size, and model ID. `[window assumed]` marks an unknown window and `[capped: ...]` marks a cap. The developer brief gets its own budget line and notes show characters out of 16000. `--model` picks the displayed Pipeline planner; Team uses agent configuration. `--json` emits v2 documents. Notes files can be at most 65536 bytes.

### Storage and trust

Settings live in `<data>/projects/<id>/context/settings.json` (`{v:2,crossChat:true,budget:{mode:"percent",value:10},models:{}}`, at most **65536 bytes**; v1 remains readable). `notes.md` sits beside it. The chat marker is `<data>/projects/<id>/chats/<chat>/context/state.json` (`{v:1,resetAt:null}` or an ISO timestamp in `resetAt`). Turns and packs are derived from those files and run history, not stored as new summaries. Missing or broken settings use defaults. Unreadable, oversized, or linked artifacts are skipped individually instead of preventing a run. See [Control API §12](../CONTROL.md#12-context-system-registry-only) for documents and transport.

Context is advisory: no approvals, completed steps, check success, evidence IDs, checkpoints, or execution state carry over. Fresh reads, checks, and approvals remain necessary. Credential redaction is best effort, not anonymization. Team **Files touched** is derived from the Developer's journaled `write`/`edit` events and points to paths, not proof of delivery. Condensation is deterministic, not model-generated; estimates say nothing about live-model quality.

## Repository instructions (AGENTS.md)

Scranton reads workspace-root `AGENTS.md` once per run from the initial workspace state. All agents in the run receive the same instructions even if the file is edited mid-run. This applies to Team roles (including custom gates), `scranton agent`, and Pipeline's planner, implementer, and reviewer. Team uses its common shadow snapshot.

The root file is inserted into the system prompt up to **32 KiB (32768 bytes)**, cut at a UTF-8 code point boundary, preferably at the last line break, with a truncation notice. For files over **1 MiB**, Scranton reads only the first 32 KiB. Nested files are not inserted: at most **50** sorted relative POSIX paths are listed, with extras as `(+N more)`. Before changing a subtree the agent should read its closest file, which takes precedence over the root there. Snapshot exclusions apply, including `.git`, `node_modules`, `.scratch`, and ignored files. Only regular files within the workspace count. External symlink/junction targets, binary data, and invalid UTF-8 are skipped with warnings; a leading UTF-8 BOM is removed.

Repository instructions rank below your direct orders and Scranton's role, tool, sandbox, and approval rules. They cannot grant rights or network access. They are mandatory instructions, not advisory history, and are neither counted nor trimmed by the context budget. Disable with `"agentsMd": false` in `scranton.config.json` or `SCRANTON_AGENTS_MD=0` (default on; environment wins).

`run_started.instructions` exposes metadata only: `{file:"AGENTS.md",bytes,sha256,truncated,nested}` for a root file, `{file:null,nested:n}` for nested files only, otherwise `null`. `bytes` and `sha256` (lowercase hex) cover the inlined root text after BOM removal and truncation, excluding the notice. `nested` is the total nested-file count.

`context show`, HTTP context status, and the **Context** drawer show a separate summary `instructions: {file,bytes,tokens,truncated,nested:[paths, max 50],nestedCount}` with file size, estimated tokens, and truncation or nested-file notes. `nestedCount` is the total; `tokens` estimates the full rendered instructions block. Without a file, the panel shows **No AGENTS.md**. This previews the current workspace, not an active run's earlier snapshot. Pipeline also records the summary in `status.instructions`. See [Events](../EVENTS.md#repository-instructions-additive-v1) and [Pipeline](../PIPELINE.md#agentsmd).
