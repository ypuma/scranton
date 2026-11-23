# Dreaming project memory

Consolidate prior outcomes locally or review an optional model-generated memory proposal.

[Back to the README](../../README.md)

## Structural consolidation

Dreaming applies to registered projects with Team and Pipeline chats. Background scheduling is off by default. Structural consolidation needs no model calls or extra services; reflection is separate. [OpenClaw dreaming](https://docs.openclaw.ai/concepts/dreaming) inspires Light/REM/Deep consolidation of sourced observations. [Dream-RSI](https://arxiv.org/html/2609.14858v1) inspires comparisons of exploration strategies against frozen results. Scranton uses actually recorded autonomous retry chains, not invented independent worlds. This deterministic process is not a generative dream model or scientific evidence of better quality or speed.

```powershell
node bin/scranton.js dreaming status --data .scranton-data --project PROJECT-ID --json
node bin/scranton.js dreaming preview --data .scranton-data --project PROJECT-ID --json
node bin/scranton.js dreaming run --data .scranton-data --project PROJECT-ID
node bin/scranton.js dreaming on --data .scranton-data --project PROJECT-ID
node bin/scranton.js dreaming off --data .scranton-data --project PROJECT-ID
node bin/scranton.js dreaming rollback --data .scranton-data --project PROJECT-ID
```

`on` enables automatic sweeps only while the Registry server is running, the project is idle, and recovery is not blocking it (default interval: 360 minutes). Disabling keeps existing memory. Preview writes nothing. Rollback restores the latest preimage.

Policy application is independently off. Only `applyPolicy:true` in Settings lets the next real Pipeline run reduce a retry ceiling to `min(operator ceiling, learned ceiling)`, for the exact retry ceiling and check-recipe cohort. Dreaming no longer lowers Team cycle caps. Team uses progress and token budgets to decide when to ask for help, with a separate configured safety cap. Dreaming skips no steps, checks, rights, or approvals and never changes an active run.

Team uses structured cycle and gate outcomes. New Pipeline runs record explicit `dream_attempt` events. Older `check_finished` histories cannot reliably identify attempts and contribute only final structural observations, never invented replays. Pipeline abstains from replay and policy application when there are required final checks or no required step checks. The next planning prompt receives only bounded, revalidated, advisory memory. Failed changes do not count as delivered. Python Guidance and Procedural Graphs remain separate.

The structural store at `<data>/projects/<id>/dreaming` keeps fixed outcome descriptions, task hashes, and source digests, not raw tasks, prompts, logs, or agent prose. It writes no workspace `MEMORY.md`. Linked, external, or unsafe histories are rejected; human-influenced or truncated chains are excluded. Original histories can still contain sensitive data and are not sanitized. See [Dreaming internals](../DREAMING.md) for API, privacy, replay, and limits.

## Optional model reflection

**Propose** sends redacted excerpts from at most four completed real Team/Pipeline runs to an explicitly selected signed-in provider/model. This can cost money, tokens, or subscription quota. The limits are 1000 text characters per run, 12000 input characters in total, 4096 output characters, a configurable 256–4096 output token cap, and no more than 60 seconds. Redaction is best effort, not anonymization; unknown secret formats can remain. Assistant claims are separate from recorded check and exit results. Usage and cost are shown only when known.

Proposals show typed notes (`user`, `feedback`, `project`, `reference`), actual before/after, and source quotations. Only **Apply** with the proposal ID adopts the notes. Reject discards the proposal; Cancel stops generation; Rollback restores the last state/settings preimage, not spent tokens. Sources are rechecked before applying and later injecting memory. Combined advisory memory is capped at 2000 characters. The current task and same-chat history have priority. No approvals or check success carry over. There is no on-demand topic-file retrieval or demonstrated quality gain.

Automatic generation needs both `enabled` and `reflectionEnabled`, a configured model, new input, project-wide idle time, and no pending proposal. It never applies automatically. Defaults: `reflectionEnabled:false`, `reflectionModel:null`, `reflectionMaxOutputTokens:2048`, `reflectionTimeoutSeconds:60`. Normal runs and structural preview/sweep never initiate model reflection. Run starts cancel ongoing reflection without waiting for cleanup.

```powershell
node bin/scranton.js dreaming propose --data .scranton-data --project PROJECT-ID --provider PROVIDER --model MODEL --json
node bin/scranton.js dreaming apply --data .scranton-data --project PROJECT-ID --proposal PROPOSAL-ID --json
node bin/scranton.js dreaming reject --data .scranton-data --project PROJECT-ID --proposal PROPOSAL-ID --json
node bin/scranton.js dreaming cancel --data .scranton-data --project PROJECT-ID --json
```

The bounded reflection transport uses `tools/dreaming-complete.js` and Scranton's own LLM clients without tools or sessions. It validates supported API output-token limits before inference and fails closed for unsupported payload paths. Catalogue presence does not prove endpoint compatibility; tests use offline/scripted providers.

The official Claude Code material reviewed for this feature describes Auto Memory and `/memory`, not a documented public `/dream` command. A third-party extracted consolidation prompt proves neither public availability nor triggers. **Managed Agents Dreams is a different product.** See the [research notes](../CLAUDE_CODE_DREAMING_RESEARCH.md) and [reflection protocol](../DREAMING.md#claude-inspired-optional-reflection).
