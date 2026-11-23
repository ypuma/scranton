# Configuration

Set defaults for Team execution, models, and gate tools.

[Back to the README](../../README.md)

## Precedence and execution defaults

Flags take precedence over environment variables, then `scranton.config.json`, then defaults. Scranton loads `.env`, but inherited environment values win. Never put credentials in the repository; see [`.env.example`](../../.env.example). [Registry runs](projects-chats-context.md#projects-and-chats) have separate scope rules.

```json
{
  "execution": {
    "maxParallel": 3,
    "isolation": "worktree",
    "sandbox": { "mode": "scranton", "network": "allow" },
    "persistentSessions": true,
    "maxReplans": 0
  }
}
```

Dynamic Team replanning is not implemented: the published dependency graph is immutable, and effective `maxReplans` is `0`. Role models come from [agent defaults or run overrides](team-roles-gates.md#custom-agents-and-models). LLM access stays on the host. Docker `none` blocks only tool networking; `allow` (alias `bridge`) permits egress.

## Legacy settings and gate tools

Scranton rejects all `pi.*` options, `SCRANTON_PI_COMMAND`, and `agents.<id>.extraArgs` for every role. Configure models, tools, and Thinking directly. No third-party Pi extensions, skills, or MCP discovery are loaded. Project files are untrusted inputs and cannot grant permissions.

`agents.oscar.tools`, `agents.hank.tools`, `agents.angela.tools`, and custom gate tool lists must be nonempty subsets of `read`, `grep`, `find`, `ls`, and `bash` (Windows fallback: `powershell`). `write`, `edit`, and other tools cause a `ConfigError` naming `agents.<id>.tools` on config load, even for `visualize`. Remove invalid overrides from existing configurations. Shell commands can still write; the tool allowlist is not OS isolation.

See also [CLI options](cli-reference.md#run-options), [permissions](sandbox-and-approvals.md#outside-worktree-access), and [repository instructions](projects-chats-context.md#repository-instructions-agentsmd).
