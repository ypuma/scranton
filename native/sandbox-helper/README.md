# scranton-sandbox-helper

Standalone, zero-dependency Rust crate; Windows-only Win32 FFI. Other targets fail closed with exit 125 and use the Node adapter's OS backend instead. The Win32 ABI declarations were studied in the project spike; the launch, relay, limits and label lifecycle are implemented here rather than invoking the spike.

## CLI

```text
exec --cwd <absolute-directory> [--mode low|strict] [--network allow|none]
     [--profile <existing-AppContainer-name>]
     [--timeout-ms N] [--memory-mb N] [--processes N] [--cpu-ms N]
     -- <absolute-executable> [args...]
label-low --path <owned-directory>
harden --path <explicit-credential-directory> --backup <new-trusted-file>
unharden --backup <trusted-existing-file>
profile-create --name <unique-name>
profile-delete --name <name>
```

- `exec` defaults to low/allow, rejects low/none. Strict uses the supplied profile SID with zero capabilities, regardless of network=allow. Profile creation/grants/revocation/deletion belong to the adapter lifecycle.
- Arguments preserve Windows argv quoting; cmd.exe receives the special raw `/c` or `/k` tail wrapped for cmd's parser. Do not pass untrusted argv as helper options before `--`.
- Child environment is inherited from the helper; the adapter sets private TEMP/TMP/TMPDIR and the trusted caller must scrub secrets. All three standard streams are relayed concurrently; no unbounded output buffering. Only child-side pipe handles are inherited.
- Process creation is suspended; Job assignment precedes resume. All setup failures report to stderr and exit **125**, without falling back. Root child exit code is propagated, wall timeout is **124**. Descendants are killed when the root exits, a timeout fires, or the helper is killed. Limits are job-wide memory/active-process/user-CPU budgets, not per-child quotas.
- `label-low` sets inheritable No-Write-Up Low labels recursively. `harden` sets Medium No-Read-Up/No-Write-Up labels recursively; it first saves original labels and fsyncs an exclusively created backup. Both preflight the entire tree and refuse reparse points and files with more than one hard link (`GetFileInformationByHandle.nNumberOfLinks`) before any label mutation. Labelling reopens each entry with `FILE_FLAG_OPEN_REPARSE_POINT`, rechecks it, and uses handle-based `SetSecurityInfo` with `MAXIMUM_ALLOWED` to suppress automatic propagation to unchecked children. The adapter must authorize/validate paths before using them; this CLI is a privileged *trusted-host control plane*, not a command exposed to an agent.
- There is still a TOCTOU window between the tree scan, each handle check, and the label update: a concurrent host writer can replace an ancestor or add a hard link after inspection. Non-following final-component handles do not pin ancestors or prevent new hard links. Only use private disposable trees with no concurrent untrusted host writers. This is not an atomic filesystem transaction.
- Label backups are a sequence of little-endian u32 UTF-8 byte length + path bytes, then u32 UTF-8 byte length + original SDDL bytes, repeated until EOF. No credential file content is read. `unharden` validates framing before applying stored mandatory labels. Backups must remain private/trusted and outside the sandbox write roots. On partial failure keep the backup and restore explicitly; no optimistic fallback. Restore journals existing entries, not an inventory of future files.
- `profile-create` prints only the new SID. It refuses an existing name, rather than adopting/deleting another session's profile. Delete failures are surfaced.

Build from repository root:

```bat
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cargo build --release --manifest-path native/sandbox-helper/Cargo.toml --target-dir .scratch/sandbox-helper-target
```

See `src/core/sandbox-native/README.md` for exact guarantees, limitations, verification, and packaging handoff. This helper is not a promise of an exact two-directory filesystem allowlist in Low mode: existing Low-integrity locations remain writable and normal Medium files remain readable unless hardened.

## MSYS2 / Git Bash compatibility

The helper always launches Low tokens in `low` mode, never Medium as a compatibility fallback. Raw MSYS2 launches are session-dependent: MSYS uses an installation-wide NT object directory under `\BaseNamedObjects\msys-<version>-<DLL-path-key>`. When a Medium host Bash holds that namespace open, its implicit Medium mandatory label prevents a Low process from opening it for directory creation (`NtCreateDirectoryObject`, `0xC0000022`). A fresh DLL installation path succeeds cold and fails while Medium Bash is alive; after that process exits, Low succeeds again. This is an NT object namespace conflict, not a worktree filesystem label failure.

The Node adapter therefore declares Bash unavailable in Windows Low mode and points agents to `powershell`. It does not pre-create/relabel shared MSYS objects, patch installed DLLs, or execute a host shell outside the sandbox. The raw helper remains usable for controlled diagnostics; it does not guarantee compatibility for MSYS programs invoked indirectly by another command. See the adapter README and `.scratch/sandbox-bash/REPORT.md` for reproduction and test details.
