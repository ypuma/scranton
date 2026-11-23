# Restore points and undo

Restore affected pre-run files after Team worktree integration, within the backup limits below.

[Back to the README](../../README.md)

## What gets backed up

Before writing changes back, Team worktree integration saves the original bytes of affected files under `<hive>/restore-points/<runId>/`, including uncommitted originals. This applies with the Scranton sandbox, trusted host, or Docker. Startup prints two lines: whether `.git` was found in the workspace or an ancestor, and the restore-point caveat. This check does not execute Git, read Git configuration, or count uncommitted or untracked files. The final summary prints the exact undo command only while files remain to restore and reports the number of unrestorable files.

The latest **10** points are retained. Originals larger than **16 MiB** are not backed up and cannot be restored even with Force. Only affected, integrated files are backed up, not the whole directory. A fully rolled-back first integration leaves no point. Restore points may contain sensitive original file contents; keep them out of public repositories.

**Not covered:** Shared/direct workspace execution, standalone `agent`, and Python Pipeline chats. Shared writes directly to the workspace. A standalone agent in a private worktree leaves its changes there without integration and prints that path when it finishes. Undo does not reset the Git index or history. [External writes](sandbox-and-approvals.md#outside-worktree-access) are also outside undo.

## Use undo and inspect points

```powershell
node bin/scranton.js undo --hive .scranton-hive --list
node bin/scranton.js undo --hive .scranton-hive
node bin/scranton.js undo --hive .scranton-hive --run RUN-ID
node bin/scranton.js undo --data .scranton-data --project PROJECT-ID --chat CHAT-ID
```

Undo proceeds in reverse order within a Hive. Without `--run`, it selects the newest run with files still to restore. Undo refuses an older point while newer points are open, even with `--force`; the error names the newer run IDs. If newer points remain open because you kept subsequent edits, decide whether to force their undo (overwriting those edits) or leave both points alone.

Undo restores affected originals to their pre-run state and removes files created by the run. It reports only paths it actually changed. `--list` distinguishes open, partly undone, fully undone, and no-restorable-files points and calls out missing backups. `files` is the total; `undone` counts files already restored or removed; `unrestorable` counts files without usable backups. `remaining` counts restorable files without `undoneAt` or `undoUnrestorable`. Kept `changed` files and temporarily `blocked` files keep a point open. A point is settled when `undoneAt` is set or `remaining:0`, even if the process stopped before writing the final timestamp. Explicit undo fills in that timestamp and still reports unrestorable files on retries. Directories created by the run that cannot be removed cause warnings, not an open point.

Unreadable entries appear as `unreadable`, are never selected, and are left alone by pruning. Normal undo remains available for readable points. Force is refused if an unreadable entry's directory timestamp is newer than the selected point; the error names the unreadable entry.

## Conflict codes

| Code | What happened | What to do |
| --- | --- | --- |
| `changed` | The current file differs from what the run wrote, whether due to a person or another chat. | Keep it or use `--force` to overwrite it. |
| `unrestorable` | Backup missing or unusable: not an independent regular file, over the size limit, or fails the size/SHA-256 check. | Force cannot help. |
| `blocked` | Retryable access/write failure or unsafe path state. That includes backup reads failing with `EBUSY`/`EACCES`, a file changing during a read, a hardlink, a directory or link, an unsafe parent, or a manifest limit. | Fix the cause and retry. Force cannot help. |

Each conflict reports the path, code, and reason. The CLI prints `Blocked` with a safe reason or OS error code, never contents or unrelated absolute paths, and does not recommend Force. Transient read failures do not permanently mark a backup unusable.

## Ownership and recovery

An active run in this chat or required recovery blocks undo. In Registry scope, an active or unresolved run in another chat of the project also blocks undo, including with Force. Single `--hive` mode has no sibling discovery. Undo holds the same Hive lease as a run throughout the operation; a competing run or undo identifies the current writer as an undo. After an undo crash, recovery follows the same ownership evidence rules but releases only the lease and heartbeat. Run history, events, and restore-point accounting are unchanged, so the next undo continues the file work.

Sibling chats are checked, not locked across the project. A sibling run can start during undo; integration still uses the shared workspace lock. For details see the [Control API](../CONTROL.md#restore-points-and-undo-registry-only) and [lease recovery](cli-reference.md#run-ownership-and-recovery).

### Exit status

Exit 0 means restored or listed; 1 means conflicts or an operational error; 2 means invalid invocation.
