# Orphaned-run recovery contract (lead, 2026-11-09)

## The bug
The user reported "Request stop does nothing". Evidence from the desktop app's "Hey" chat:
- `hive/control/owner.json` holds run 2dda5818, started 2026-11-08 22:56Z, with `exitCode: null`. That run waited on a human ("Docker CLI not found") and its process died when the app closed. Its events have no `run_finished`.
- The user clicked Request stop at 2026-11-09 17:29:59Z. `control/stop.json` was written, and nothing reads it because the orchestrator is dead.
- New runs in that chat stay disabled forever. The only way out is manual file surgery (docs/CONTROL.md section 6).

## Pinned shapes
1. **Heartbeat.** The process that runs the orchestrator writes `hive/control/heartbeat.json`: `{ "v": 1, "runId": string, "pid": number, "at": "<ISO>" }`.
   - The writer is the CLI run, the server-launched child, or the demo.
   - It writes atomically every 5 s, from the moment it owns the run until it releases the lease, including while waiting for a human.
   - It deletes the file on clean release.
   - `owner.json` keeps its current shape.
2. **Owner status.** A helper in `src/core/run-lease.js` returns `'alive' | 'gone' | 'unknown'`, checked in this order:
   1. No heartbeat, or the heartbeat's runId differs from the lease's: `'unknown'`. Legacy leases fall here.
   2. The heartbeat's pid is not running (`process.kill(pid, 0)` gives ESRCH): `'gone'`.
   3. The heartbeat is at most 30 s old and the pid is running (or EPERM): `'alive'`.
   4. Anything else, for example a stale heartbeat whose pid was reused after a reboot: `'unknown'`.
3. **`GET /api/control`.** `orphan` becomes `{ runId, startedAt, owner, heartbeatAt: string|null, stopRequestedAt: string|null, recoveryError: string|null }`. `recoveryRequired` and every other field are unchanged.
4. **Recovery steps.** Shared by automatic recovery and the release route:
   1. If the run used Docker, remove its leftover containers, matched by Scranton's own container names or labels. Use the existing sandbox cleanup code.
   2. If Docker is unreachable, continue and add the warning "Docker is not reachable; containers of this run could not be checked".
   3. Clear the run's pending human question.
   4. Append `run_finished` `{ status: "aborted", summary }` for the orphan's runId to the hive's events and state, the same way a normal aborted finish is recorded and archived.
   5. Remove `owner.json`, `heartbeat.json` and `stop.json`.
5. **Automatic recovery.** When the server sees an orphan whose owner is `'gone'`, it recovers it at once with the summary `Interrupted: the run's process ended without finishing`. On failure it keeps the lease and sets `recoveryError`.
6. **`POST /api/runs/release`.** Body: `{ runId }`. It has the same protection as `POST /api/runs/stop` (client header, origin, loopback, body limit). In registry mode it is mapped like stop: `/release` and `/runs/release` per chat.
   - 409 `{ error }` if no orphan exists or the runId does not match.
   - 409 `{ error: "The run is still running. Request a stop instead." }` if the owner is `'alive'`.
   - Otherwise it recovers with the summary `Released by the user`, then returns `200 { ok: true, warnings: string[] }`.
7. **Web UI recovery panel.** Unchanged when there is no orphan.
   - `'alive'`: "Request stop", as today.
   - `'unknown'`: "Request stop" plus a "Release chat" button with a confirm dialog. The dialog says:
     - Scranton cannot tell whether that run is still running.
     - Release only when sure it has stopped, for example after the app was closed or the computer restarted.
     - Releasing a run that is still running lets two runs share this chat.
     - The run will be recorded as aborted.
   - `'gone'` with `recoveryError`: the error text plus "Release chat".
   - In every state, show the stop request time, and the last heartbeat when there is one.
8. **Safety invariants stay.**
   - Never two live runs in one chat.
   - A live server-owned run is never touched by this path.
   - No blind kill of a stored PID.
   - Active-run "Stop run" behaviour is unchanged.
   - docs/CONTROL.md and the German desktop docs describe the new path.

## Review round 1 pins (lead, 2026-11-09; these override the sections above where they conflict)
9. **Automatic recovery needs verified cleanup.** The server recovers automatically only when the owner is `'gone'` AND cleanup is verified: either the run did not use Docker, or all of its containers were confirmed removed. If cleanup cannot be verified (Docker unreachable, removal failed), it keeps the lease and sets `recoveryError` to the reason, e.g. "Docker is not reachable; containers of this run could not be checked". The user's manual Release (§6) may then go ahead and returns that reason in `warnings`.
10. **Unclean finish.** If a run ends with its own cleanup unresolved, it must never read as `'gone'`.
    - It rewrites `heartbeat.json` with `cleanup: "unresolved"` and `reason: string`.
    - The status helper returns `'unknown'` for such a heartbeat.
    - `orphan.recoveryError` = `Cleanup of this run could not be verified: <reason>`.
    - Automatic recovery never touches it.
11. **Run killed before its journal started.** If `events.jsonl` holds no events for the orphan's runId (it was killed between taking the lease and `rec.start()`), recovery archives the previous journal exactly as `start()` does. It then records `run_started` (request and workspace from the lease, `roles: []`) followed by the pinned `run_finished`. Release must never fail with a journal identity error in this case.
12. **Release during an automatic recovery.** `POST /api/runs/release` answers 409 `{ error: "Recovery is already in progress. Try again in a moment." }`.
    - `recoveryError` comes only from recovery attempts, never from a 409.
    - It is cleared when recovery succeeds or the orphan changes.
13. **Locks and liveness.**
    - A crashed `recovery.lock` (empty, its pid gone, or older than 5 minutes) is stale and is taken over.
    - Requests for other chats never wait for a recovery in progress; recovery runs in the background per chat.
    - If the first heartbeat write fails, the CLI releases the lease it just took.
14. **Old servers in the web UI.** Offer "Release chat" only when the server reports `orphan.owner` (a new server). With an old server, keep the previous panel (Request stop only). Show `recoveryError` in every owner state when present.
