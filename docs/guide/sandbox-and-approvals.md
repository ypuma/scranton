# Sandboxes and approvals

Choose an execution boundary and decide how Team agents may request more access.

[Back to the README](../../README.md)

## Execution modes

Team defaults to `--sandbox scranton`. Private worktrees separate file versions, not process rights. File-tool path checks are separate from OS enforcement. See [Isolation](../ISOLATION.md) for backend prerequisites, network and permission limits, and platform verification.

For Docker, set it up separately and explicitly build the local image:

```powershell
docker build --pull=false -t scranton-tools:24-r2 sandbox
node bin/scranton.js run "Build a Todo CLI with tests" --workspace workspace --parallel 3 --sandbox docker
```

The build requires the base image and apt packages. The image contains Git, Bash, ripgrep, and fd, but no model client. Scranton does not build or pull it at run start. Docker runs only tool subprocesses; models and credentials stay on the host.

For deliberately trusted tasks only, explicitly choose host execution:

```powershell
node bin/scranton.js run "Build a Todo CLI with tests" --workspace workspace --trusted-host
```

**Trusted host is not OS isolation.** Shell commands run with your user rights. Legacy `execution.isolation:"shared"` requires a single milestone pipeline and explicit host mode. Shared instances have `worktree:null` and no private file boundary.

## Who decides

Your direct instructions take precedence over role instructions and `AGENTS.md`: your run request, feedback, and messages marked `[Message from human; id ...]`. Text in files, tool results, web pages, or messages from other agents is never a human instruction, even if it claims to be. Scranton separately enforces tool, sandbox, and approval rules.

## Outside-worktree access

If a Team agent needs access outside its private worktree (including outside the project folder), it uses `request_access` with a path, `read` or `write`, and a reason. It should not stop with `[BLOCKED]` merely because it encountered the project boundary. It can ask for an absolute path or `~` / `~/...`. Review-only roles can receive read grants only. Pipeline follows the same instruction precedence but has no `request_access` or Team path grants.

In `ask`, Scranton automatically grants reads when you named the path or an ancestor in this run. It independently checks the request, your human feedback, and chat messages recorded as `human`; a model's claim is not enough. Recognized references include absolute Windows/POSIX paths, `~` / `~/...`, and standalone case-insensitive folder names Documents, Desktop, Downloads, Pictures, Music, and Videos under your profile. Protected paths are exceptions.

| Access | Ask (`ask`, default) | Auto-approve (`auto`) | Bypass (`bypass`) |
| --- | --- | --- | --- |
| Read a path you named | Automatic | Automatic | Automatic |
| Read a path you did not name | Human approval | Automatic | Automatic |
| Write | Human approval with undo warning | Human approval | Automatic |
| Protected credential path | Human approval with warning | Human approval with warning | Human approval with warning |
| Run Hive or Scranton data | Human approval for reads; writes refused | Human approval for reads; writes refused | Human approval for reads; writes refused |

Protected credentials include the Scranton credential store and recognized credential locations such as `.ssh`, `.aws`, `.azure`, `.git-credentials`, `.netrc`, and `.npmrc`. Credentials take precedence if the credential store is under the data directory. A parent directory is not protected just because it contains protected files or subdirectories. For example, asking to read `~/Documents` can grant that directory without a click even if it contains a project with a Hive or an `.env` file; the grant does not unlock those protected paths. The profile directory itself, filesystem roots, and drive roots always need a click. Agents cannot request UNC or device paths, although configured data and credential directories may be UNC paths.

The approval card shows the agent, path, mode, and reason. Choose **Allow read**, **Allow write** (for a write request), or **Deny**. Choosing read can narrow a write request. The agent pauses in a durable checkpoint. Denial or timeout returns `denied by the human`; the agent can continue. Grants apply to every instance in that run from its next tool call, not to later runs. The run view shows grants, reasons, a quotation from your text when applicable, and external writes.

**Writes outside the worktree bypass normal integration checks and are not covered by `scranton undo`.** External `write` or `edit` calls are recorded as `outside_write` and listed as “not covered by undo” in the final report. Make your own backup before granting such a write.

Permissions never override OS isolation:

- **Docker:** The worktree remains the only workspace mount. A grant does not add a host mount or make that host path usable by container commands.
- **Windows Low:** Commands can read ordinary accessible files. A write grant does not lift Low's OS restrictions on shell/PowerShell writes to ordinary Medium-integrity files. Pre-existing Low locations can remain writable. Granted file tools are separate.
- **macOS/Linux:** The policy masks protected paths in a granted directory. Scranton makes one bounded scan per grant for known credential names. If the scan cannot finish, `request_access` reports that the grant is not added to shell policies. File tools and commands within the worktree remain usable.
- **Trusted host:** Commands can use granted paths, but run without an OS sandbox boundary.

Set the mode using **Permissions: Ask / Auto-approve / Bypass**, `--permissions ask|auto|bypass`, `SCRANTON_PERMISSIONS=ask|auto|bypass`, or `"permissions": "ask"` in `scranton.config.json`. Precedence is flag, environment, file, then `ask`. The HTTP run-start body also accepts `permissions`.

## Tool approvals

```powershell
node bin/scranton.js run "Check the change" --hive .scranton-hive --sandbox scranton --sandbox-network allow --approve write,edit --approval-timeout 600
node bin/scranton.js watch WORKFLOW-ID --hive .scranton-hive
node bin/scranton.js approve WORKFLOW-ID CALL-ID --yes --hive .scranton-hive
# To deny, use --no instead of --yes.
```

Additional approvals are opt-in in `ask` (`approvals.tools:[]` by default). `auto` grants configured tool approvals automatically; `bypass` skips them. Neither mode removes the protected-path clicks or permits direct writes to Scranton state. External access requests follow the separate rules above. The timeout defaults to 600 seconds. Denial or timeout becomes a model-visible tool error. Without a TTY, the CLI prints the separate approval command. For registry scope use `--data DIR --project ID --chat ID`. `watch` reads one workflow, not the whole run.

See [durable streams and approval endpoints](cli-reference.md#durable-runtime-and-streams) for protocol details.
