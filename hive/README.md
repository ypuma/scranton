# The Hive

The Hive is Project Scranton's file-based communication system. Agents never talk to each other directly and never write here themselves: the orchestrator ("Michael") is the postman. It stores each agent's final answer in that agent's `outbox.md` and delivers it into the next agent's `inbox.md`. Everything is plain Markdown/JSON, so you can read (or edit) it at any time.

```
hive/
  michael/   inbox.md  outbox.md  plan.json  plan.md  system.md  archive/
  dwight/    inbox.md  outbox.md  system.md  archive/
  angela/    inbox.md  outbox.md  system.md  archive/
  human/     inbox.md                        <- notes for you when a human decision is needed
  sessions/  michael/ dwight/ angela/        <- pi session files (one fresh session per invocation)
  runs/      <runId>/events.jsonl state.json <- archived earlier runs
  events.jsonl                               <- append-only event stream of the current/last run
  state.json                                 <- snapshot of the current/last run
```

- `inbox.md`: the message an agent works on next. Starts with a front-matter header (`from`, `to`, `kind`, `runId`, `milestone`, `cycle`, `date`). The previous inbox is moved to `archive/` first.
- `outbox.md`: the agent's latest final report.
- `plan.json` / `plan.md`: Michael's milestone plan for the current run.
- `system.md`: the role prompt (from `agents/<agent>/SKILL.md`) that is handed to pi.
- `events.jsonl` / `state.json`: the contract consumed by the terminal dashboard and the web dashboard. See `docs/EVENTS.md`.

Runtime files are ignored by git; only this README and the `.gitkeep` files are tracked.
