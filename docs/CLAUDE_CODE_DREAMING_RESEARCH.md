# Claude-inspired memory consolidation: sources and boundaries

Research snapshot: 2026-11-15. This is a design comparison, not a claim of Claude Code feature parity or measured Scranton quality improvement.

## What the sources establish

| Source | Observed scope | What it does not establish |
|---|---|---|
| [Claude Code memory](https://code.claude.com/docs/en/memory.md), [commands](https://code.claude.com/docs/en/commands.md), [changelog](https://code.claude.com/docs/en/changelog.md) | Documented auto memory, `/memory`, project-scoped memory and `user`, `feedback`, `project`, `reference` note types. The documented index loads the first 200 lines or 25 KB; topic files are read on demand. Prefer useful non-derivable context over a copy of code/git facts. | The researched official documentation did not document a public `/dream` command, scheduler or dream setting. Absence in these documents is not proof that no private implementation exists. |
| [Third-party extracted Dream consolidation prompt](https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/main/system-prompts/agent-prompt-dream-memory-consolidation.md) | Repository metadata identifies Claude Code `2.1.296`; observed instructions follow Orient → gather targeted signal → consolidate → prune/index, including date normalization and narrow transcript searches. | Extraction is not an official product contract. It does not establish public availability, invocation conditions, rollout, or actual execution. Calling it definitively released, unreleased or private would exceed this evidence. |
| [Anthropic: The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory) | Research motivates selective offline consolidation and checking notes against original transcripts, rather than indiscriminate logging. Salience predicts future utility; it is not ground truth. | Published examples do not validate Scranton's implementation, eliminate hallucinations, or establish a coding benchmark improvement here. |
| [Managed Agents Dreams](https://platform.claude.com/docs/en/managed-agents/dreams) | A separate product: asynchronous, billed consolidation into a separate output memory store for subsequent evaluation/adoption rather than mutating the input store. | Not a Claude Code CLI `/dream` feature or evidence of its local scheduling behavior. |

The full upstream research working note is `.scratch/claude-dream-upstream/RESEARCH.md` (not shipped). Its conclusions are not all adopted: in particular, an extracted prompt does not prove release status, and attractive design principles are not proof that this implementation is robust or improves outcomes.

## Scranton's conservative adaptation

Scranton retains its existing deterministic structural source/replay gates unchanged. Optional model reflection is a separate proposal-generation path, inspired by selective transcript grounding, typed notes, compact context and explicit review. It sends bounded **best-effort redacted excerpts to the selected authenticated provider/model**, potentially consuming money, tokens or subscription quota. Unknown secret formats may survive redaction; hashes and relative provenance paths are not anonymization.

The adapter reads project-local completed non-demo/non-internal Team/Pipeline artifacts only. Human corrections precede original tasks. Assistant statements remain distinct from recorded terminal/check/process outcomes; an exit code alone does not prove correctness. Raw tool bodies/check output/checkpoints are not model input. Exact quotes establish source availability, not semantic truth. Missing/unsafe/malformed/over-limit sources fail safely.

Limits: four recent runs, 1000 excerpt characters per run (4000 overall), 12000 combined request characters, 4096 output characters, configurable 256–4096 output tokens and at most 60 seconds. Character budgets are not token budgets. Usage/cost is displayed only when reported. Authenticated model selection does not guarantee transport compatibility: the own bounded completion transport refuses unsupported API token-cap paths before inference; see [DREAMING.md](DREAMING.md).

Proposals require explicit ID-specific Apply or Reject. Automatic generation needs both scheduling and reflection opt-ins, a configured authenticated model, idle project, new input and no pending proposal; there is **no automatic Apply**. Run starts abort ongoing reflection without waiting for optional cleanup. Shutdown awaits owned cleanup. Failed, stale, cancelled and late responses cannot promote notes. Sources are revalidated on application and advisory context injection. Rollback restores the latest stored preimage, not consumed provider budget; attempt accounting survives rollback.

Accepted notes share the existing 2000-character advisory context budget, with same-chat history taking precedence. `MEMORY.md`/`NOTES.md` are derived projections under the project data directory, not workspace files or evidence. Scranton performs **compact injection, not Claude Code's on-demand topic-file retrieval**. Generated notes cannot approve work, waive checks, change deterministic policy gates or supersede current tasks. Offline scripted integration tests are not live-provider or native-desktop verification and do not establish measured coding-quality or runtime improvement.

See [DREAMING.md](DREAMING.md) for storage, operational recovery, budgets and commands, and [CONTROL.md](CONTROL.md) for HTTP contracts.
