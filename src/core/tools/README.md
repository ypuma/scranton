# Deterministic agent tools

ESM entry point: `index.js`. The durable agent workflow calls these tools with its
role allowlist and the configured executor's spawn adapter.

```js
import { runTool, toolDefinitions } from './index.js';
const allow = ['read', 'grep', 'find', 'ls', 'write', 'edit'];
const definitions = toolDefinitions(allow);
const result = await runTool('read', { path: 'src/main.js', offset: 1 }, {
  root: absoluteWorkspace,
  allow,
  signal,
  env: process.env,
  binaries: { rg: null, fd: null },
});
// result: { content: string, isError: boolean, details: object }
```

`toolDefinitions(allow)` returns fresh plain JSON Schema definitions with no extra properties allowed. Runtime argument errors and tool failures are returned, not thrown. `edit` additionally accepts the legacy `{ path, oldText, newText }` form; its advertised schema uses `edits` only. Numeric offsets/counts must be positive safe integers; context may be zero. Shell timeout is a positive number of seconds, at most 1800.

## Context and result metadata

- `root`: absolute working directory; paths are confined to this tree.
- `allow`: explicit array of allowed names; absent means deny all.
- `signal`: optional AbortSignal. File mutations observe cancellation before committing; cancellation after a committed rename does not turn success into an ambiguous failure.
- `limits`: positive integer overrides: `maxLines` (200), `maxBytes` (10240), `readMaxLines` (2000), `readMaxBytes` (51200), `grepMaxLineLength` (500), `grepTimeoutMs` (5000, native fallback only). Notices are outside the retained-content budget.
- `env`: base child environment; defaults to process.env, then secret/session variable names are removed. A supplied object replaces rather than extends process.env.
- `binaries`: optional absolute rg/fd executable paths. When omitted, `binaries.js` checks bundled `tools/bin/` first, then PATH from `env` (or process.env). In an explicit object, missing/null entries force native fallback. Runtime resolution never installs, downloads or imports Pi; desktop preparation stages hash-pinned binaries from `tools-lock.json`.
- `spawn`: optional Node-compatible `(file, argv, options) => ChildProcess`. Used for shell and search launches. Adapters must preserve the child stream/events contract. A returned child may declare `killOwnsTree: true` only when its `kill()` tears down its process tree (native Job/process group or Docker in-container group). Otherwise timeout/abort uses host process-tree cleanup, including for an injected plain Node spawn. Taskkill is a host cleanup operation, not dispatched as an agent command.
- `chat`: optional async `({to, text}) => ack` callback; invoked once, with no retry. Its acknowledgement is JSON encoded. `ack.ok === false` marks an error.

Every result includes `details.idempotency`: `pure` for read/search/list; `guarded` for edit/write; `at-most-once` for shells/chat. Successful guarded results include `files: [{path, before, after}]`, using absolute paths and SHA-256 over exact file bytes (`before: null` for a new file).

## Layout

- `schema.js`: definitions and small recursive validator.
- `path.js`: lexical containment and existing-component reparse checks, macOS OS-alias exception, mutation prohibition for `.git`.
- `truncate.js`: central limits, head/tail truncation, size and list notices.
- `files.js`: read, exact edit, atomic write, per-file queue and hashes.
- `glob.js`: own glob compiler, including brace alternatives and character classes.
- `search.js`: rg JSON / fd line adapters, native walker, grep formatting and ls.
- `process.js`: environment filtering, shell resolution, injectable launcher, timeout/abort cleanup and bounded shell tail buffering.
- `binaries.js`: bundled/PATH rg/fd resolution without runtime downloads.

## Deliberate parity differences

- Strong workspace containment; no `~`, `@` stripping, Unicode normalization, external links/junctions, screenshot-name guesses or WSL relay. All symlinks/junctions are rejected, including internal aliases, except verified macOS `/var` and `/tmp` OS aliases. This also prevents an alias from bypassing the `.git` write prohibition.
- Exact LF-normalized edit only, with original BOM and untouched line endings preserved. No fuzzy matching or JSON-string/object coercion for edits. All overlapping occurrences are counted, not merely non-overlapping string splits.
- Images and binary reads are errors. Text BOM is not displayed.
- Smaller default search/list/shell output caps, shell timeout default 120 seconds, maximum 1800, and no output spill. Atomic writes alone create a short-lived sibling file and remove it on success/failure.
- rg sorts by path; excludes for `.git` and `node_modules` are case-insensitive and remain effective even with a positive user glob. Positive grep globs override `.gitignore`, as in rg/Pi.
- fd enumerates candidates without an early result cap, then the same own matcher is used on every platform and results are sorted before limiting. This extends Pi's Windows path-pattern workaround and avoids a nondeterministic subset selected by fd workers.
- Native grep runs in a worker terminated on abort or after `grepTimeoutMs`, keeping regex backtracking off the calling thread. It uses JavaScript RegExp rather than Rust regex: inline mode flags and POSIX classes differ; JS lookaround/backreferences are accepted. Both paths share text formatting, count limiting, context windows and 500-character clipping.
- Native walking reads inherited/local `.gitignore` files (glob patterns, anchored paths, directory rules and negations); it does not load global Git excludes, `.git/info/exclude`, `.ignore` or rg-specific ignore files. Gitignore backslash-escaped special-character patterns are not supported by the native matcher. Native traversal deliberately skips links and unsafe discovered entries. Windows device-name, ADS and trailing-dot/space restrictions apply only on Windows; valid POSIX names remain accessible. No Git command is run against an untrusted workspace.
- File reads/native grep currently buffer individual input files; shell output is bounded in memory. No streaming gigabyte-read guarantee is made.

Writes create a sibling temp in a validated real parent, preserve an existing file's mode, and use 0o666 minus umask for new files. The parent realpath and directory identity are rechecked immediately before every rename attempt, including retries. Cleanup does not follow a changed parent and may leave a temp in the displaced directory.

These path checks are not an OS sandbox. A hostile concurrent host process can still swap a directory between the final validation and a filesystem operation (including temp creation or rename): Node's portable path-based API does not provide directory-handle-relative rename. Shell command contents and protection against that remaining race require the configured executor's OS isolation; explicit trusted-host mode provides none.

## Verification

Run `node --test "test/core/tools/*.test.js"` from the repository root. Fixtures stay in `.scratch/tools-tests/`. Real rg/fd tests resolve bundled or PATH binaries and otherwise state a skip reason. Shell tests skip only when the respective shell is unavailable.

Regression anchors: removing the `includeGlob` override passed to `walk` in grep makes the real rg/native parity test fail for `glob: '*.txt'` (observed before the correction). Replacing the raw bounded shell accumulator with per-chunk `truncate` calls makes the chunk-boundary newline test fail (`thirdfourth` instead of separate lines).

The implementation was written independently after studying Pi's MIT tool sources. No substantial implementation block was copied verbatim; requested interface descriptions, notices and edit error strings are retained for compatibility.
