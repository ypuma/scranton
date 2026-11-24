# Agent names (2026-11-24)

The user asked: "rename agents so its clearer what they are and do". The five built-in agents of a Team run were
shown under first names (Michael, Dwight, Oscar, Hank, Angela) that say nothing about their job. From now on they
are shown under the name of their role, with a short phrase that says what they do.

## The names

| id (unchanged) | Name | Short | Does (shown beside the name) | Description (tooltips, Agents drawer, docs) |
| --- | --- | --- | --- | --- |
| `michael` | Planner | Planner | Plans the work | Breaks the request into milestones, judges progress when a milestone fails and, in a chat, writes the final reply. |
| `dwight` | Developer | Developer | Writes the code | Implements one milestone at a time and fixes what the checks report. |
| `oscar` | Code Reviewer | Reviewer | Reviews the changes | Reviews each milestone's changes for defects, regressions and test coverage. Never edits the project. |
| `hank` | Security Auditor | Security | Checks security | Audits each milestone's changes for exploitable weaknesses. Never edits the project. |
| `angela` | QA Tester | QA | Tests the result | Runs the tests and the program against every acceptance criterion. Never edits the project. |

Check each description against `agents/<id>/SKILL.md` and the orchestrator before using it; correct the wording
if the code says otherwise, and tell Core. The Name, Short and Does columns are fixed.

- "Short" is for places with no room (a table column, a chip, a stage summary).
- In a sentence the name takes an article and keeps its capitals: "the Developer finished m1", "the QA Tester
  rejected m2", "waiting for the Code Reviewer". As a label or heading it stands alone: "Developer".
- An instance is shown as name plus where it works, never as its raw id: `dwight-m1` is "Developer · m1". The raw
  instance id stays in the data and may appear in a `title` or an opened detail.
- "Human" and the names of custom agents (the user chose those) do not change.

## What does not change

Everything a machine or a saved file reads: the ids `michael | dwight | oscar | hank | angela` in config keys,
`--gates "oscar+hank,angela"`, `SCRANTON_<ID>_*` environment variables, `agents.json`, prompt files
`<promptsDir>/<id>.md`, the folders `agents/<id>/` and the `name:` line of their front matter, events (`agent`,
`from`, `to`, `instanceId`), mailboxes, keywords (`[PLAN_READY]`, `[TASK_COMPLETE]`, ...), API routes and their
field names. Existing configs, saved runs and scripts keep working without migration.

Where a human has to type or recognise an id (CLI help, the Agents drawer, the docs), it is shown next to the
name: "Developer (id `dwight`)".

Text that an earlier run already wrote into its journal (handoff summaries, reports) keeps the old first names;
nothing rewrites saved runs. Labels the UI computes from ids show the new names for old runs too.

## One table per runtime

- Node: `src/core/workflow.js` exports `ROLE_NAMES` (exists), and new `ROLE_SHORT`, `ROLE_TITLES` (the "Does"
  phrase) and `ROLE_DESCRIPTIONS`, each keyed by id. Every other Node module, the terminal dashboard included,
  takes the words from there.
- Browser: `visualizer/public/js/state.js` exports the same four names (`ROLE_TITLES` exists and now holds the
  "Does" phrase; `ROLE_NAMES` is new and holds the five built-ins). Every other UI module takes the words from
  there (`displayName`, `roleTitle`); no module keeps a table of its own.
- `GET /api/agents` keeps its shape: for a built-in agent `name` is the Name and `title` is the "Does" phrase.
- A test compares the two tables (it lives with the UI tests and imports both modules).

## Prompts

`agents/<id>/SKILL.md` and every text the orchestrator writes to a model or into the journal use the new names
("You are the Developer", "hand off to the QA Tester"). Only names change: instructions, keywords, structure and
order stay byte for byte. A prompt the user saved under `<promptsDir>/<id>.md` is not touched.

A model still addresses the others by id (mailboxes, `agent_chat`), so wherever a model is given ids - the
recipient list of the instance coordination block, an example in a prompt - each id carries its name:
`angela-m1` (QA Tester, m1). Before the rename the id and the first name matched and this was implicit.
