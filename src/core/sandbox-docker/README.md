# Optional Docker tool executor

`createSandbox({worktree, tempDir, image?, network?, runId?, env?, limits?})`
returns the native adapter interface: synchronous, idempotent `prepare()`, Node-compatible
`spawn(file, argv, options)`, asynchronous idempotent `dispose()`, and `available()`.
`available(options)` is also exported. Default image: `scranton-tools:24-r2`.
The orchestrator selects this adapter for `execution.sandbox.mode: 'docker'`;
its `shells` capability supplies `/bin/bash` without host-shell discovery.

The host owns the workflow, LLM clients, credentials and contained file tools.
Only subprocess tools run in the Linux container. There is no credential projection,
Antigravity broker, Pi, host session or prompt mount, or Docker-specific model rule.
`env` selects only Docker CLI transport/discovery variables; per-tool `options.env`
is deliberately ignored. No caller environment is exported with `docker exec`.

`prepare()` checks the Linux daemon and local image without pulling, validates a private
Git worktree and disjoint temp directory, creates a read-only `.git` mask there, and
starts one hardened idle container with the worktree as the only writable host mount.
`network: allow` (also `bridge`/true) maps to bridge; `none`/false maps to none.
The worktree must permit UID/GID 10001 writes; no UID fallback is attempted.

Host shell/search executable paths are translated to known Linux image binaries.
Host PowerShell is not provided by this image: use bash in Docker. Absolute executable
paths within the worktree map to `/workspace`; cwd must be a real contained directory.
Argument contents are not rewritten: shell scripts must use container paths.
Streams stay separate as in Node; the shell tool combines stdout/stderr itself.

`kill()`, AbortSignal and configured wall timeout stop the command-local process group
inside the container, not merely the host exec client. Normal command exit also cleans
remaining group members; the container stays available for subsequent tool calls.
`dispose()` makes the adapter terminal, removes the entire container and verifies its
absence, then waits for exec clients to close before directories can be deleted.
Run labels support existing orphan recovery. Container cleanup verification failures
retain the mask and surface as errors.
Host crashes require existing run recovery; this adapter does not install a daemon.

Build only after `docker images` confirms `node:24-bookworm-slim` exists locally:
`docker build --pull=false -t scranton-tools:24-r2 sandbox`.
Revision r2 installs rg/fd from pinned, SHA-256-verified release archives rather than apt.
Rebuild explicitly; an existing r1 image does not satisfy the new default tag.
The existing base-tag/apt version policy is unchanged (not digest-reproducible).
No automatic build, pull, installation or host fallback occurs.

## Run-wide access grants

`request_access` changes host-side file tools, not the running container's mounts.
Outside roots are not added to Docker commands; commands still see only `/workspace`
and private container paths. Use the file tools for granted host paths, or choose an
explicitly trusted host/native backend at run start. There is no container restart
or host-execution fallback when an outside command path is unavailable.
