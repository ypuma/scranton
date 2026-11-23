# Native shell sandbox

Default tool-process executor (`execution.sandbox.mode: 'scranton'`), wired through
the orchestrator, configuration, doctor and desktop build. It has no runtime dependencies.
Docker and explicitly trusted host execution are separate modes; failures never downgrade.

## Adapter API

```js
import { createOwnedDirectory, createSandbox, hardenCredentials } from './index.js';

// Parents must already exist. These calls refuse to adopt an existing directory.
const worktree = createOwnedDirectory(absoluteNewAgentDirectory);
const tempDir = createOwnedDirectory(absoluteNewPrivateTempDirectory);
// Populate the owned worktree (or create a git worktree in this new directory).
const sandbox = createSandbox({
  mode: 'scranton', worktree, tempDir,
  network: true, // default; false fails closed in Windows low mode
  windowsMode: 'low', // or 'strict'
  limits: { timeoutMs: 120000, memoryMb: 2048, processes: 64, cpuMs: 60000 },
});
try {
  sandbox.prepare();
  // Node's (absoluteExecutable, argv, options) => ChildProcess interface:
  // streams, events, stdin, exit status, kill() and AbortSignal remain available.
  await runTool('powershell', { command: 'node -v' }, {
    root: worktree, allow: ['powershell'], spawn: sandbox.spawn,
  });
} finally {
  await sandbox.dispose();
}
```

`prepare()` is synchronous and idempotent; `spawn()` never prepares implicitly. `dispose()` kills active children, awaits their `close` events, revokes strict profile ACEs and deletes the profile. Always await it in a `finally`. It does not delete the owned directories or change their Low labels back: discard those private trees after shutdown. A setup failure never launches the requested command.

`createOwnedDirectory()` creates a marker **only in a newly created directory**. Preserve it when materializing the agent checkout. The runtime must choose the paths; never offer an agent a way to claim arbitrary existing directories by creating markers. Do not manually put markers into a user's workspace/home. `prepare()` requires markers, disjoint worktree/temp and no credential overlap. Root/ancestor symbolic links are rejected; on Windows the helper additionally preflights the entire tree for reparse points and multiply-linked files before changing labels. Unix policy generation does not perform that Windows full-tree check; materialize private trees without links to host data. Do not share these directories with concurrent untrusted host writers. Only an agent's disposable checkout should be writable. The adapter also validates spawn cwd is a real directory inside the worktree and refuses shell/verbatim/uid/gid launch overrides. Executables must be absolute; shell tool commands are passed as shell argv, not by setting Node's `shell` option. TEMP/TMP/TMPDIR always point to the private temp, including when callers supply an environment.

- `await available(options?)` (also `sandbox.available()`): returns `{available, backend?, helper?, networkIsolation?, tools?, recommendedShell?, reason?}`. Windows Low diagnostics include `tools.bash = {available: false, reason}` and `recommendedShell: 'powershell'`, even if Git Bash is installed. Actually probes token creation, Seatbelt execution, or bwrap user/PID namespaces on the current OS. Missing binaries/disabled namespaces fail closed with diagnostics. No downloads/installations/fallback.
- `resolveSandboxHelper({env,platform,arch}?)`: explicit absolute `SCRANTON_SANDBOX_HELPER`, then `src-tauri/binaries/scranton-sandbox-helper-<target>[.exe]`, then `.scratch/sandbox-helper-target/release/scranton-sandbox-helper.exe`. An invalid explicit override is an error, not a fallback.
- `credentialLocations({platform,home,env,credentialsDir}?)`: own desktop data credentials (including override), `.ssh`, `.aws`, `.config/gcloud`, `.pi`, and macOS `Library/Keychains`.
- `seatbeltProfile(options)` / `bubblewrapArgs(options,file,argv)`: pure policy builders apart from existence checks for Linux credential mounts. `platform` injection is for policy/diagnostic tests, not emulated execution.
- `limits`: positive safe integers, `timeoutMs`, `memoryMb`, `processes`, `cpuMs`. The latter three are Windows-only; supplying them on Unix fails closed. A per-spawn Node `timeout` or AbortSignal also terminates the wrapper; Windows Job closure kills descendants. On Unix the adapter's `kill()` targets its process group. Tool-side process-tree cancellation remains compatible.

### Git Bash on Windows Low mode

Git Bash/MSYS2 is deliberately **unavailable**, whether or not a trial launch happens to succeed. Direct `bash[.exe]` and `sh[.exe]` launches through the adapter throw a clear error pointing to `powershell`. `runTool('bash', ..., {spawn: sandbox.spawn})` turns this into an agent-visible tool error. No shell runs at Medium integrity as a fallback. The raw helper remains a trusted Low-token launcher, not a shell capability selector; invoking Bash indirectly through another executable can still encounter MSYS's native error.

A unique copied MSYS runtime demonstrates the cause deterministically: Low launch succeeds cold; while a Medium Bash from the same installation is alive, Low launch fails with `NtCreateDirectoryObject(\\BaseNamedObjects\\msys-2.0S5-<key>): 0xC0000022`; after Medium exits, Low succeeds again. Thus normal host Bash **causes**, rather than cures, this collision. A read-only NT object security probe showed an Everyone DACL permitting the requested directory operations and no explicit mandatory label (implicit Medium). MSYS's installation key derives from the DLL path. The same helper and unchanged worktree labels are used throughout, so the filesystem hard-link/no-propagation change is not the cause.

Pre-creating or relabelling that installation-wide namespace Low would expose writable MSYS IPC objects shared with Medium host processes. It is not a safe compatibility workaround. No isolated, supported namespace setting has been established; the adapter conservatively refuses Bash instead of relying on session timing. This does not claim that every possible private-runtime implementation is impossible.

Doctor consumes `available().tools.bash`; configuration selects `powershell` for default Windows native-sandbox roles even when Git Bash is installed, and rejects explicit Bash role tools in that mode. Cmd/PowerShell and native `git.exe`/Node remain usable at Low integrity. Strict AppContainer Bash compatibility is still not promised. Deterministic tests cover the collision with a fresh DLL installation key and assert adapter unavailability before, during and after the Medium process; removing the spawn guard makes the regression fail (`Missing expected exception`). Reproduction/probe evidence is under `.scratch/sandbox-bash/`.

### Explicit Windows credential hardening

Before its first native Windows launch, the orchestrator hardens Scranton's own credentials directory (see `../credentials/README.md`) and stores a trusted recovery backup under `<hive>/credential-label-backups/`. Other user credential folders are not hardened automatically. Direct adapter callers must arrange protection before launching Low processes:

```js
const protection = hardenCredentials(absoluteScrantonCredentialsDir, {
  backup: absoluteTrustedBackupFileOutsideCredentialDirectory,
});
// Explicit user-authorized reversal, not routine sandbox.dispose():
protection.restore();
```

This labels existing entries Medium with No-Read-Up/No-Write-Up and inheritable flags. Backup creation is exclusive and synchronized **before** mutation. Preserve the trusted backup for reversal; never place it under a writable sandbox root. A partially failed hardening operation leaves this backup for recovery and must prevent shell execution. `restore()` replays saved mandatory labels; it does not change DACLs. Do not erase/move the tree while reversing it; descendants created after the snapshot are not individually journaled. This function can also be called explicitly for user-owned credential directories, but **never call it on those by default**. Backups contain paths/labels, not file contents. Keep backups private and trusted because restore applies their saved paths. Repeated hardening must use lifecycle-managed backups, not overwrite the original snapshot.

## Enforced boundaries and limits

| OS/backend | Enforces | Does not enforce / caveats |
| --- | --- | --- |
| Windows `low` (default) | Restricted primary token, admin SID deny-only plus LUA filtering, privileges stripped (Windows retains traversal privilege), Low integrity, suspended launch assigned to kill-on-close Job before resume, handle inheritance whitelist, optional Job memory/process/CPU limits and wall timeout. Owned worktree/temp get inheritable Low labels. | Not an exact filesystem allowlist: MIC blocks writes to Medium/High objects, but **other pre-existing Low-integrity locations remain writable**. Ordinary Medium files remain readable unless explicitly hardened. Network is allowed; `network:false` is rejected before launch. Not a VM or complete registry/device isolation. |
| Windows `strict` | Zero-capability AppContainer (no network capabilities), restricted Low token and the same Job. Unique profile; only owned worktree/temp get profile-specific Modify ACEs. | Toolchains in Program Files/user installations may not execute; Node module realpath traversal can fail. No broad toolchain/ancestor grants are added. Network stays blocked even with the default `network:true`. `dispose()` removes profile ACEs/profile; an abrupt host crash can leave a profile/ACE needing recovery. Job descendants still die when the helper dies. |
| macOS | Generated `/usr/bin/sandbox-exec` policy is deny-default: explicit process exec/fork, system-path reads, worktree/temp read/write, `/dev/null` writes, sysctl reads, same-sandbox signals/process info and named mach services. Explicit denies cover LaunchServices/launchd lookup and Apple Events plus credential/keychain reads. `network:false` denies `network*`; otherwise network is allowed. | **Native enforcement is unverified until tested on macOS**, including profile syntax, broker-escape probes and shell/git/node compatibility. Home-installed toolchains and host data outside allowed paths may be unreadable. Deprecated OS interface. Process-group cleanup is not a Job/PID namespace; detached descendants need native-host review. |
| Linux | Generated bwrap argv requests read-only `/`, RW worktree/temp, private `/dev`, `/proc` and `/tmp`, user/PID/IPC/UTS namespaces, new session and die-with-parent. Empty tmpfs hides `/run` (including `/run/dbus/system_bus_socket`), `/run/user` and `$XDG_RUNTIME_DIR`; private `/tmp` hides host `.X11-unix` and temporary Wayland sockets. D-Bus/display/session/agent discovery environment is unset. Existing credentials get empty read-only mounts. `network:false` adds a network namespace. | **Native enforcement is unverified until tested on Linux**, including bwrap mount ordering, socket escape probes and tool compatibility. Requires usable bwrap/user namespaces (not installed automatically). General non-credential reads allowed. Special `/dev`/`/proc` mounts remain operational. Nonstandard broker sockets outside masked directories and abstract/IP services when network is enabled are not comprehensively isolated; unsetting discovery variables alone is not a security boundary. No Unix memory/process/CPU limits. |

Windows labelling is not atomic: there is a TOCTOU window between the full-tree scan, the per-handle recheck and the label change. The helper refuses hard links/reparse points, opens final components without following reparse points and labels checked handles without automatic child propagation, but a concurrent host writer can still change ancestors or create a hard link after inspection. Keep these trees private and free of concurrent untrusted host writers.

This boundary only covers child processes launched through `sandbox.spawn`. Native Node filesystem tools retain their separate containment rules. The trusted runtime must scrub credentials from child environments (the existing tools already do), and must never put secrets in shell arguments or shared files.

## Verification and integration

Build from the repository root:

```bat
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cargo build --release --manifest-path native/sandbox-helper/Cargo.toml --target-dir .scratch/sandbox-helper-target
node --test "test/core/sandbox-native/*.test.js"
```

Alternatively run `cargo build --release --target-dir <absolute-project>/.scratch/sandbox-helper-target` from the helper crate. Desktop preparation builds the helper separately for its Windows target.

The real Windows integration matrix uses cmd and PowerShell, and asserts explicit unavailability for installed Git Bash in Low mode. It checks inside/outside writes, protected credential reads, unisolated positive controls, git status/node, PID-specific descendant death on kill and timeout. Separate tests check strict network denial against a host-reachable local TCP endpoint and actual profile registry creation/removal, ACE cleanup, concurrent 256 KiB stdout/stderr, stdin, exact exit status, process-count enforcement, native/adapter network fail-closed and hardening restoration. The strict execution probe uses the Windows-supplied PowerShell; AppContainer execution of installed Git Bash/Node is not promised. macOS/Linux generated-policy tests run on Windows; native execution cases state their skip reason. These tests prove the exact policy text/argv, not OS enforcement. Native macOS/Linux enforcement remains unverified until the policies and broker escape attempts run on those hosts.

Earlier mutation negative controls replaced the adapter spawn with host spawn and made cmd/PowerShell/Git Bash boundary tests fail at outside-write denial (exit 0 instead of denied). Git Bash is now deliberately unavailable in Low mode rather than a boundary positive control. The independent credential-hardening test also fails at denied-read assertion with that bypass. The production spawn was restored before the final gate.

Review regressions: a real NTFS hard link inside the owned worktree points to an outside fixture file. Before the fix, `label-low` succeeded and `icacls` showed the outside file acquiring Low integrity; after the fix it exits 125 with a hard-link diagnostic and both outside/root labels are unchanged. Policy-test mutation controls also fail if deny-default is replaced by allow-default or the runtime-directory masks are removed. The fixed policies are restored for the final gate.

Policy references (Apache-2.0, design reference rather than imports): [OpenAI Codex base Seatbelt policy](https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl) and [Anthropic sandbox-runtime macOS policy generator](https://github.com/anthropic-experimental/sandbox-runtime/blob/main/src/sandbox/macos-sandbox-utils.ts). The small named-service allowlist here must be validated on macOS; it is not a general desktop-service allowlist.

The orchestrator creates disposable owned checkout/temp roots, hardens Scranton credentials before Windows Low launches, calls `prepare()`, supplies the sandbox to the runner, preserves cancellation and awaits `dispose()` before deleting temp trees. Config/doctor support is active; unsupported network/limits fail closed. Direct strict-mode callers must track profile names/SIDs for orphan cleanup after crashes; this module does not install a recovery service.

`scripts/prepare-desktop.mjs` builds and stages `scranton-sandbox-helper-<target>.exe` in `src-tauri/binaries` for Windows, and `src-tauri/tauri.conf.json` declares the helper sidecar. The desktop launcher supplies its packaged absolute path through `SCRANTON_SANDBOX_HELPER`. macOS uses the OS binary; Linux diagnoses a missing/unusable bwrap. No automatic helper installation or host fallback occurs.

## Run-wide access grants

The runtime supplies `extraRoots: () => [{path, mode, protected}]`; the callback is
read on every spawn. Seatbelt adds read-only/read-write subpaths; bubblewrap adds
`--ro-bind`/`--bind`, retaining credential/broker masks over broad ordinary grants.
Explicit credential grants are applied after credential masks; Seatbelt exceptions
cover only the approved credential subpaths. These generated policies have unit coverage;
actual macOS/Linux execution still needs native-host verification. Nonexistent
bind sources fail closed. A granted credential subpath may require native mount
support beneath a masked ancestor; no broad credential unmasking fallback is used.

Windows Low can read ordinary outside files already, but shell writes to Medium
paths remain denied. Grants never relabel user directories or elevate commands.
Explicitly hardened credentials remain OS-denied even after a click. Windows
strict/AppContainer receives no new host ACEs, so its outside command access may
remain denied. Host-side file tools apply run grants independently of these OS
limits. Outside file-tool writes bypass worktree integration and are not covered
by undo; only those explicit `write`/`edit` operations produce `outside_write`.
