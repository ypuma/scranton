# Getting started

Set up a source checkout, run your first Team task, or try a scripted demo.

[Back to the README](../../README.md)

## Source prerequisites

Use Node.js 24, npm, and Git. The CLI declares Node.js 22.19.0 as its minimum; local durable workflows need `node:sqlite`, and desktop packaging targets Node.js 24. The default Scranton OS sandbox requires the native helper on Windows (see the [helper build instructions](../../native/sandbox-helper/README.md)), `sandbox-exec` on macOS, or a separately installed, usable `bwrap` on Linux. Missing prerequisites stop the run; they do not trigger host fallback. Docker is optional and is never installed, built, or pulled automatically. See [Isolation](../ISOLATION.md).

Run these commands from the cloned Scranton repository. `node bin/scranton.js` does not require a global CLI entry. Optional `npm.cmd link` exposes the `scranton` command declared in `package.json` if the global npm bin directory is on PATH. Use `npm` instead of `npm.cmd` outside Windows.

```powershell
npm.cmd ci
node bin/scranton.js help

# Sign in with a provider (here, a ChatGPT subscription) and check status.
node bin/scranton.js login chatgpt
node bin/scranton.js accounts

# Optional: pin models for the three default Team roles. Otherwise use Automatic.
node bin/scranton.js agents --hive .scranton-hive
node bin/scranton.js agent set-model michael --provider openai --model gpt-6.2-sol --hive .scranton-hive
node bin/scranton.js agent set-model dwight --provider openai --model gpt-6.2-sol --hive .scranton-hive
node bin/scranton.js agent set-model angela --provider openai --model gpt-6.2-sol --hive .scranton-hive

# Replace C:\Projects\MyApp with your project folder.
node bin/scranton.js doctor --workspace "C:\Projects\MyApp" --hive .scranton-hive
node bin/scranton.js run "Add a small feature with tests" --workspace "C:\Projects\MyApp" --hive .scranton-hive --sandbox scranton
```

A real run consumes model quota or incurs charges. [Automatic model selection](providers-and-models.md#automatic-selection) is the default without a configured model. `doctor` checks availability offline, with no model calls or token refresh, and exits 0 for warnings or 1 for errors. Agent defaults are stored in the selected Hive; use the same `--hive` for model selection, the check, and the run.

## Integration and troubleshooting

In default worktree mode, agents work in private copies. Once gates pass, Scranton writes each completed milestone back to the chosen project folder, not just at the end of the run. Existing uncommitted files form the baseline and may be edited further; Scranton does not change the user's Git history, index, or branch. Later overlapping changes cause an integration conflict. Back up the workspace first: private copies and bounded restore points are not a full backup. See [Team integration](team-roles-gates.md#parallelism-verification-and-integration).

On failure, start with the terminal diagnostics, `.scranton-hive/state.json`, `.scranton-hive/events.jsonl`, and instance outboxes under `.scranton-hive/<instance>/outbox.md`. Earlier runs are under `.scranton-hive/runs/`. See the [dashboard commands](desktop-and-updates.md#dashboards) and [recovery instructions](cli-reference.md#run-ownership-and-recovery).

## Try a scripted demo

```powershell
node bin/scranton.js demo
node bin/scranton.js demo --scenario breaker --delay 50 --on-breaker skip
```

The demo uses the scripted provider in the normal durable loop, with private worktrees and explicitly simulated trusted-host mode. The standard scripted adapter makes no real model or shell calls; this does not verify a sandbox boundary. Scenarios are `happy`, `flaky` (default), `breaker`, `blocked`, `changes_once`, `security_issues`, `question`, `progress`, and `access`.

For optional Docker or explicitly trusted host runs, see [Sandbox options](sandbox-and-approvals.md#execution-modes).
