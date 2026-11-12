# Diagnosing a quiet baseline check

## What the activity stream proves

`prepare_workspace` runs setup first. Then `index_repo` and `baseline_checks` run in parallel;
planning waits for both. No model call is expected before that join.

Baseline checks run sequentially in configured order, including final-scope checks and checks after a
failed required check. Each command has its own `timeout_s` (default 600 seconds, maximum 3600).
This is not one deadline for the entire batch. The run-level active-time budget is checked at node
boundaries; it does not interrupt a running baseline batch.

In v0.1.0, `checked()` emits `check_finished` only after `run_checks()` has returned the entire batch
and tracked-file restoration has finished. Check logs are also written when each process capture
finishes, not streamed while a command runs. A quiet activity stream or absent log therefore does
not prove that the process is hung. Setup network permission does not make checks isolated in host
mode: trusted-host execution has no OS isolation.

## Confirmed cleanup defect and source fix

A controlled test reproduced an unbounded wait in `tools/process.py`: when stdout still has an open
writer after process cleanup, the old reader thread blocks inside `BufferedReader.read()`. Its
10-second join expires, but `finally: stdout.close()` then waits for the same buffered-stream lock.
The caller cannot return its `output_not_closed` infrastructure error until the writer closes.
This affects timeout, cancellation and normal-parent-exit cleanup.

The source fix reads the pipe nonblocking in the owning thread, checks cancellation and timeout even
when output is continuous, and retains a 10-second post-process drain deadline. A retained writer
now produces `output_not_closed` without an unbounded buffered close. Output caps, redaction and tree
cleanup remain in place. This does not strengthen host-mode process containment: on POSIX a process
can deliberately leave its original process group, and that process is not claimed to be terminated.

The regression uses a real pipe and simulated process/tree ownership so the retained-writer case
can be exercised on Windows without launching an escaped process. All three cases fail on the
released implementation and pass with the fix. Additional real fixture checks cover busy stdout and
stdout closed before the process exits. These are not native macOS runtime tests.

## Evidence needed from the affected Mac

For the specific run, request only selected diagnostics, reviewed and redacted locally before sharing:

- the configured check IDs, kinds, order and `timeout_s`, sandbox mode and active-time limit;
  a screenshot of the configured checks is an alternative (review command text before sharing);
- the status/phase/node, check summaries and failure code; activity entries for preparation, baseline,
  check completion and failure; the app's redacted engine stderr/launch-error tail;
- names and sizes of existing `artifacts/logs/baseline-*.log` files, then only relevant redacted tails;
- elapsed time and a process-tree snapshot identifying the engine, active check and descendants
  without unrelated command-line arguments.

Do not dump `config.json`, `run.json`, all events or raw logs into a support conversation: these can
contain task text, command arguments, project paths or other sensitive data. Inspect selected fields
locally and disclose only what is needed. The generated `config.json` is in the run directory under
`projects/<project>/chats/<chat>/pipeline/runs/<run>/` inside the app's data directory; do not guess
which run or command is affected.

Do not infer the active command from the task text or kill unrelated processes. A few minutes in
`baseline_checks` is compatible with a normal check within its configured deadline. To attribute
this cleanup defect, evidence must show a retained stdout writer/blocked cleanup rather than merely
an unfinished command. Without that evidence, the Mac incident's root cause remains unknown.

No installed app, release asset, version, packaging configuration or wire event schema is changed
by this source fix. The released v0.1.0 app still contains the old implementation.
