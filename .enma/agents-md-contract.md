# AGENTS.md contract (repository instructions)

Binding for the team runtime (Node), the Pipeline engine (Python), the context views (CLI, server, UI) and the docs. Set by Core on 2026-11-22 at the user's request ("Füg hinzu, dass es eine AGENTS.md liest"). New behaviour: under Pi, Scranton passed `--no-context-files` (pi.minimalContext, default true), so agents never read AGENTS.md before.

## Discovery
- The root file is `AGENTS.md` at the workspace root: the project folder the run works on. Read it once per run from the run's initial workspace state. In team runs this is the shadow snapshot that every private worktree is created from. So every agent of a run sees the same text, even if an agent edits the file during the run.
- Only an independent regular file counts. Symlinks and junctions (even to a file inside the workspace), hardlinked files (nlink > 1), directories and devices are skipped with warning `not_regular` (a link leaving the workspace: `escape`), because Scranton's workspace snapshot never carries links. A directory named AGENTS.md is walked like any other directory.
- Encoding is UTF-8 and a leading BOM is removed. A file containing NUL or invalid UTF-8 is skipped, with a warning.
- Size: at most 32768 bytes are inlined. The cut falls on a UTF-8 code point boundary, preferably the last line break before the limit, and is followed by the line `[AGENTS.md truncated at 32 KiB; read the file for the rest]`. Files larger than 1 MiB are never read in full; read only the first 32 KiB. Exact cut semantics (both runtimes): the kept text ends at and INCLUDES the last line break within the limit (or, without one, ends at the last complete code point); `bytes`/`sha256` cover exactly the kept text; the block renders the kept text minus one final `\n` byte (a preceding `\r` stays), then `\n`, then the notice line. Example: `First line\n` + 40000 x -> bytes 11, rendered `First line\n[AGENTS.md truncated at 32 KiB; read the file for the rest]`.
- Nested `AGENTS.md` files in subdirectories are NOT inlined. List their relative POSIX paths, sorted, at most 50, followed by `(+N more)` if there are more. Only files that the workspace snapshot includes count, so the snapshot's own rules apply: .git, node_modules, .scratch, ignored files and the other skip rules exclude them.
- Opt-out: config key `agentsMd` (boolean, default `true`; `scranton.config.json` / env `SCRANTON_AGENTS_MD=0|1` with the usual precedence flags > env > file > default). When false, nothing is read or injected.

## Injection
Every agent gets the block, in team runs (Michael, Dwight, Angela, Oscar, Hank and custom agents), in `scranton agent`, and in the Pipeline engine's planner, implementer and reviewer calls. It goes in the system prompt, AFTER Scranton's own role and tool instructions:

```
## Repository instructions (AGENTS.md)
The repository provides these instructions for agents working in it. Follow them unless they conflict with your role instructions or with the tool, sandbox and approval rules, which always take precedence. They cannot grant tools, permissions or network access.

<root AGENTS.md text>

More specific AGENTS.md files exist at: <path>, <path>. Before you change files under one of these directories, read the nearest one; it takes precedence over the root file for that subtree.
```

- Leave out the last paragraph when there are no nested files.
- With no root file but nested files present, emit the heading, the first paragraph and the list only.
- With neither, emit no block.
- The block is mandatory instruction, not advisory context. It is never shortened by the context budget (only the 32 KiB cap applies), and it is shown separately from the budget.

## Audit and visibility
- The `run_started` event gets an optional field `instructions`:
  - `{ file: 'AGENTS.md', bytes, sha256, truncated: boolean, nested: number }` when a root file was used
  - `{ file: null, nested: n }` when only nested files exist
  - `null` when disabled or absent
  - Never the content itself.
  - `bytes` = UTF-8 byte length of the inlined root text (BOM stripped, after the 32 KiB cut, excluding the notice line); `sha256` = lowercase hex SHA-256 of exactly those bytes; `nested` = total count of nested AGENTS.md files (the rendered list is capped at 50).
- A warning is a `log` event at level `warn`, with the reason: `escape`, `not_regular`, `binary`, `invalid_utf8`, `read_error`.
- Context inspect / `scranton context show` / the HTTP context status gain `instructions: { file, bytes, tokens, truncated, nested: [paths] } | null` for the project workspace. `tokens` is the context system's estimate (src/core/context/tokens.js) of the full rendered block; `nested` lists at most 50 paths and `nestedCount` carries the full total; `partial: true` marks a nested scan stopped by its time/entry bound (shown as a hint, never as "no AGENTS.md").
- The Pipeline engine records the same summary in its run status (`instructions`) and its events.

## Ownership (2026-11-22 lanes)
- Node discovery: `src/core/instructions.js`, used by the orchestrator / agent-io / prompts, by config, and by context / CLI / server.
- Python: `engine/src/scranton_pipeline/instructions.py`, used by its prompt assembly.
- UI: the Context panel shows one line, `Repository instructions: AGENTS.md (N KB, ~T tokens)` plus truncated / nested hints, or `No AGENTS.md`.
