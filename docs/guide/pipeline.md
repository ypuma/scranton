# Pipeline mode

Use a bounded workflow with explicit check evidence and human control over delivery.

[Back to the README](../../README.md)

## Pipeline workflow

Pipeline chats use a separate Python/LangGraph engine. It plans, edits, and checks a private snapshot, with plan and delivery gates. With `auto_low_risk` enabled, only plans with no risk flags can be auto-approved. No flags does not mean the plan is safe. Revised plans always require renewed approval. Bounded replanning and parallel steps use private lanes with checks after integration. See the [Pipeline reference](../PIPELINE.md), [engine CLI](../../engine/README.md), and [architecture](../../engine/docs/ARCHITECTURE.md).

The host bridge `tools/pipeline-complete.js --provider P --model M [--thinking T] <request.json> <response.json>` uses Scranton's own LLM clients and credential store for a completion with `tools:[]` and no agent session. The supervisor reports `via:"bridge"` and sets `provider:"command"`; compatible API-key accounts can still use `via:"direct"`. Model calls stay on the host regardless of the check sandbox. Local/scripted tests check the bridge; historical Pi smoke tests do not verify this transport.

## Check and setup sandboxes

New Pipeline runs default to Scranton's native sandbox for checks and setup, currently Windows only. Default `low` leaves networking on and ordinary Medium-integrity Windows files readable. `strict` blocks networking for checks and setup and permits only reads accessible to the AppContainer. If setup needs networking but checks must stay offline, explicitly select Docker. Docker has its own image, built locally using **Build sandbox image**. Only Docker mounts `/workspace/.pipeline`; native setup outputs stay in the working folder. An unavailable selected mode stops the launch. Explicit trust is required for real host runs; host mode is not OS isolation.

Remaining work includes native macOS/Linux support, a Strict setup network capability, renewed trust confirmation for old host runs, clearer typed helper errors instead of Exit 125, and less relabeling work for large folders. Read the full [sandbox limits](../ISOLATION.md#pipeline-check-and-setup-isolation).

## Evidence and optional guidance

The scripted demos cover the basic flow, replanning, parallel steps, and evidence checks without model calls. **Evidence checks** (`demo --scenario evidence` in the Python engine; HTTP `demoScenario:"evidence"`) rejects and repairs a blind plan (`unseen_target`) and a false absence claim about `add` (`false_absence`, with hits). At delivery, the baseline supports a `demonstrated` criterion alongside a `met_not_demonstrated` criterion; `criteria_not_demonstrated` is set, `grounding_violations` is not. The run succeeds after both approvals. The demo requires `enforce`; `--grounding observe` produces CLI Exit 2 or HTTP 400 when the equivalent HTTP option is set. See the [full example and recorded R9 scores](../../engine/README.md#evidence-demo-abgewiesen-repariert-trotzdem-erfolgreich).

Python grounding validates shown evidence, absence claims, and criteria. Evidence distinguishes demonstrated effects from already-passing checks. A counterfactual probe first requires passing test checks with the change, then a failure without it (including import failures). Absence is scoped to policy-allowed files: `missing_file` matches names only, including existing directories; non-text files are excluded only from symbol content searches. Empty coverage remains `unverifiable`.

Full overwrites always require a current, untruncated full read shown to the model; otherwise Python reports `unseen_edit` with a hint to use `replacements`. The exception for Python reads that cannot be shown in full only applies to `replacements`/`delete` and still requires part of the current file to be shown. Model-requested reads are removed before Python's own reads when making room. An `approve` contradicting the reviewer's own `not_met` assessments or `blocking` findings is invalid output. An otherwise consistent `approve` against an unmet Python check criterion enters bounded review revision, not output repair.

The judge-free `eval --pack core` suite and opt-in **Procedural guidance (experimental)** with offline `evolve` are separate features. Guidance is off by default and does not displace evidence or change permissions or graph edges. The final gateway cap accounts for the actual rendered guidance bytes within their own allowance, in addition to the base budget. `evolve` retains rejected rounds in full in both JSONL histories; only their refiner-prompt copy is compacted to 2 KB per line.

The delivery flag `grounding_violations` only reports violations accepted under `observe`. Repaired `enforce` violations still affect the score and counts, not that flag. Grounding, guidance, and offline evolution were tested with scripted models, not live models. See [engine regression and opt-in instructions](../../engine/README.md) and the [design rationale](../../engine/docs/ARCHITECTURE.md).
