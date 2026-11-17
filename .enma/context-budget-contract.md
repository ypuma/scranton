# Context budget contract (context system v2, 2026-11-17)

Addendum to `.enma/context-contract.md` (v1, shipped in 0.3.0). Where the two disagree this file wins. Everything
in v1 that is not named here stays in force: authority rules (§2), turn record (§3), storage layout (§4), layer
order, redaction and masking, determinism, the legacy fallbacks on internal errors, single-hive mode, demo runs,
gate agents.

User request (verbatim): "Budget should be in tokens, rework the limits so they are more realistic. A 4000 char
limit for a prompt for example can be higher. The context should be seeable also in % and customizable (based on
the model)".

Evidence behind the decisions: `.scratch/context-budget/inventory/INVENTORY.md` (enforcement points, pinned
tests) and `.scratch/context-budget/probe/FINDINGS.md` (what the transports carry, how windows are looked up).

## 1. Summary

- Budgets are **estimated tokens** (§2), derived for each **recipient model** from its context window (§3).
- A project sets the budget as a share of the window (default 10 %) or as a fixed number of tokens, with optional
  per-model overrides (§4). Documents report tokens, model and window so clients can show percentages (§9).
- The Team builder budgets in **units** (§2), so 23900 units reproduce the 0.3.0 pack; all caps scale (§5).
- Input limits rise: notes 16000 chars, Team request 32768 chars (file transport), message to a running agent
  and HITL feedback 16000 chars (§6, §7, §12). The Pipeline gate comment stays at 4000 (argv transport).
- Pipeline: the wire carries its byte allowances; the engine prompt budget bounds them (§8).

## 2. Token estimate (normative; identical in Node and in the browser)

No tokenizer. `units(text)` is the sum over the Unicode code points of the string:

| Code point | Units |
|---|---|
| U+0000..U+007F, and U+2026 `…` (the builder's own cut mark; this keeps the 0.3.0 anchor exact) | 1 |
| the rest of U+0080..U+2E7F | 2 |
| everything else, including astral code points (one surrogate pair = one code point) and a lone surrogate | 4 |

`tokens(text) = Math.ceil(units(text) / 4)`. A non-string has 0 units. Units are additive when strings are joined
at whole-code-point boundaries (the pack only joins well-formed text; a lone high surrogate followed by a lone
low one is the documented exception: 4 + 4 becomes 4); tokens are not additive, so every budget comparison is
done in units. For ASCII text 1 unit = 1 char, and `units(s) >= s.length` always.

- `clipUnits(text, max)`: the longest prefix of whole code points with `units <= max` (`''` when `max <= 0`).
- `cutUnits(text, max)`: `''` when `max <= 0`; `text` when it fits; else `clipUnits(text, max - 1) + '…'` - the
  shape of `cut` in 0.3.0 (`n - 1` chars plus the mark). The result never exceeds `max`.
- Node: `src/core/context/tokens.js` exports `units`, `tokens`, `clipUnits`, `cutUnits`, `pct`. Browser:
  `visualizer/public/js/context.js` exports `units`, `tokens` and `pct`. Both pass these vectors:

| String | JS length | Units | Tokens |
|---|---|---|---|
| `""` | 0 | 0 | 0 |
| `"Hello, World!"` | 13 | 13 | 4 |
| `"München & Köln"` | 14 | 16 | 4 |
| `"東京と北京"` | 5 | 20 | 5 |
| `"Scranton 🚀✨"` | 12 | 15 | 4 |
| `"bad\uD800surrogate\uDC00"` | 14 | 20 | 5 |
| `"Hello äöü 中文 🚀 \uD800!"` | 18 | 32 | 8 |
| `"cut…"` | 4 | 4 | 1 |

Everything user-visible says "tokens" and marks the number as an estimate (`≈`). Percentages are computed by the
clients from integers with one shared rule `pct(n, d)`: `0` when `n` is 0 (also when `d <= 0` or the value is
not finite); `<0.1` when the value is below 0.1; otherwise let `r` be the value rounded to one decimal: below 10
show `r` with one decimal (`5.0`, `9.9`, `0.2` for 0.15 %), else the raw value rounded to an integer (9.96 % is
`10`, never `10.0`; 10.45 % is `10`).

## 3. Recipients and windows

A model reference is `{ provider, model }` (the shape in `agents.json` and in Pipeline start bodies; `provider`
is null in a configuration that names only a model). Its id is `provider + '/' + model`, or `model` alone when
there is no provider (`modelId(ref)`, exported by the resolver module). A **recipient** is `{ id: string | null, window: integer, known: boolean }`; `id: null`
means pi default (no model configured). Unknown window: 128000 with `known: false`.

| Pack | Recipient |
|---|---|
| Team planner pack | Michael's effective model |
| Team developer brief | Dwight's effective model |
| Pipeline history + context | the planner role's model |

Resolver, new module `src/core/model-windows.js` (lane A2):

```js
createModelWindows({ providers, runtime } = {}) => { resolve(ref) /* -> Promise<recipient> */ }
modelId(ref) /* -> string | null */
```

- `ref` is `{ provider, model }` or null. Null, no model, or malformed: `{ id: null, window: 128000, known: false }`.
- Sources in this order: (1) custom providers (`src/core/providers.js` store, the model's declared
  `contextWindow`), read on every call; (2) pi's registry through the same runtime set-up as `src/core/auth.js`
  (its paths and its Antigravity registration - a bare `ModelRuntime.create` misses both), created once per
  process without network access and cached: `getModel(provider, model)`. For a reference without a provider:
  the window that all registry models with that id share (none, or several different windows: unknown).
  A2 may add one exported helper to `src/core/auth.js` for the runtime; nothing else changes there.
- No positive safe-integer window found: `{ id, window: 128000, known: false }`. `resolve` never throws, never
  uses the network and never spawns; a failed registry load is cached as empty. Both sources are injectable.
- `warm()` loads the registry in the background (the first load took about 1.3 s here). The server creates one
  resolver in registry mode only and warms it without delaying start-up; tests inject their own resolver, so no
  test depends on the models installed on the machine. A reference containing any control character (C0 or C1)
  or a lone surrogate is malformed.

Who resolves:

- Server, Team run start (`src/server/control.js`): the models the run will really use, i.e. after the per-run
  picks of `body.models` (ignored in Docker mode exactly as the run ignores them). The pack reaches `control.js`
  through its provider closure, which becomes `threadContext({ memory, recipients })`; `registry-router.js`
  hands both on to `forTeam`.
- Server, chat document route: Team chats use the Agents defaults (`config.agents.<id>.modelSetting.value`).
  Pipeline chats have no stored pick before a run, so the browser sends its current planner pick as query
  `?provider=<id>&model=<id>` (both or neither, each 1..256 chars without whitespace or control characters, else
  400); without it the recipient is unknown. The query is ignored for Team chats.
- Server, Pipeline run start (`src/core/pipeline-supervisor.js`): `body.models.planner`.
- CLI in registry mode without a thread-context file: the models of `loadConfig`.

`createContext` itself does no model lookup. Callers pass `recipients: { planner?, developer? }`; a missing entry
is `{ id: null, window: 128000, known: false }`.

## 4. Settings and effective budget

`<data>/projects/<p>/context/settings.json`, at most 65536 bytes (32 overrides with 513-char ids of three-byte
characters need about 51 KB):

```json
{ "v": 2, "crossChat": true,
  "budget": { "mode": "percent", "value": 10 },
  "models": { "anthropic/claude-sonnet-4-5": { "mode": "tokens", "value": 24000 } } }
```

- `budget` and `models` are optional in the file; absent means the default rule `{ "mode": "percent", "value": 10 }`
  and no overrides. A v1 file (`{ "v": 1, "crossChat": bool }`) keeps working and means the same. Anything else is
  invalid and handled as today (degraded defaults on read, clear error on write).
- A rule is exactly `{ mode, value }`: `percent` with an integer 1..50, or `tokens` with an integer 1000..200000.
- `models`: at most 32 keys; a key is a recipient id as in §3 (1..513 chars, well-formed, no whitespace, no
  control characters). Keys are user input: build and read the map without touching prototypes (`Object.create(null)`
  or `Object.hasOwn`), and refuse `__proto__`, `constructor` and `prototype`.
- `configure(projectId, patch)`: `patch` has closed keys `crossChat` (boolean), `budget` (rule, or `null` = back
  to the default) and `models` (an object whose values are a rule, or `null` = delete that override; `models`
  itself must be an object); at least one key. The patch is merged into the stored settings; more than 32
  overrides after the merge is refused.

Effective budget of a recipient (exported from `src/core/context/limits.js` as `budgetFor(settings, recipient)`):

```
rule    = settings.models[recipient.id] (source "model")  ??  settings.budget (source "project")
raw     = rule.mode === 'percent' ? floor(window * value / 100) : value
ceiling = min(200000, floor(window / 2))
tokens  = max(256, min(raw, ceiling))
capped  = tokens === raw ? null : tokens === 256 ? 'min' : ceiling === 200000 ? 'max' : 'window'
-> { tokens, mode, value, source, capped }
```

Developer brief budget: `briefFor(settings, developer) = min(B, max(250, min(2000, floor(B / 10))))` tokens with
`B = budgetFor(settings, developer).tokens`.

| Window | Rule | Pack budget | Brief budget |
|---|---|---|---|
| 32000 | default 10 % | 3200 | 320 |
| 32000 | 50000 tokens | 16000 (`window`) | 1600 |
| 128000 (also the unknown case) | default 10 % | 12800 | 1280 |
| 200000 | default 10 % | 20000 | 2000 |
| 400000 | default 10 % | 40000 | 2000 |
| 1000000 | default 10 % | 100000 | 2000 |
| 1000000 | 50 % | 200000 (`max`) | 2000 |
| 400 | 1000 tokens | 256 (`min`) | 250 |

## 5. Team planner pack and developer brief

`buildTeamPack({ ..., units: U, developerUnits: Udev })` with `U = 4 * B` and `Udev = 4 * brief`; when omitted
they default to 23900 and 3900. Everything is measured with `units()` and cut with `clipUnits` / `cutUnits`.

`scaledLimits(U, Udev)` (exported from `limits.js`) with `s = U / 23900` and `sdev = Udev / 3900`. Every
`floor(value * s)` below is computed as `Math.floor(value * U / 23900)` (and `/ 3900` for the brief), which is
exact at the anchor:

| Cap | 0.3.0 value | v2 |
|---|---|---|
| latest turn: request / reply / plan block / files block | 2000 / 6000 / 3000 / 1500 | `floor(value * s)` units |
| older detailed turn: request / reply / plan block / files block | 800 / 1500 / 1200 / 600 | `floor(value * s)` |
| request floor when shrinking | 500 | `floor(500 * s)` |
| earlier layer, other chats, memory | 4000, 3000, 2000 | `floor(value * s)` |
| detailed recent turns | 4 | `clamp(floor(4 * s), 1, 12)` |
| brief: notes part, condensed turns | 1500, 6 | `floor(1500 * sdev)`, `clamp(floor(6 * sdev), 3, 12)` |

Not scaled, but now counted in units where they were chars: outcome 300 (the turn record carries no more),
condensed line 300 (request part 160, outcome part 200), plan line 200, status 80, chat title 120. Counts stay:
6 condensed files, 24 plan lines, 30 files, 6 other chats x 3 turns, 12 siblings scanned x newest 4 runs, 500
runs read. The turn-record caps of `turns.js` are unchanged except `request` (§6), so scaled caps are upper
bounds. `scaledLimits(23900, 3900)` equals the 0.3.0 constants. The `truncated` flag of `meta` compares against
the scaled older-turn caps in units (`units(reply) > olderReply`, `units(request) > olderRequest`).

Invariants (each needs a test; I1-I8 restate v1 §6 in units):

- I1 `units(text) <= U` and `units(developer) <= Udev` for every budget from 256 tokens up; both strings use `\n`
  only and have no leading or trailing whitespace.
- I2 if a turn exists, the latest turn is present: in detail with its outcome and at least the first
  `floor(500 * s)` units of its request, or - only when that cannot fit - as a condensed line.
- I3 notes appear in full whenever `units(notes) <= floor(U / 2)`. Otherwise they are cut at the last line break
  that fits (plain `clipUnits` when no line break fits), followed by the line
  `[project notes cut to fit the context budget]`, the whole notes body staying within `floor(U / 2)` units, and
  `meta.notes.cut` is true. The existing `[End project notes]` trailer is kept in both cases.
- I4 no visible turn of this chat disappears silently (detailed, condensed, or counted in the omitted line).
- I5 other chats only use left-over budget (at most `floor(3000 * s)` units) and never displace a layer of this chat.
- I6 determinism, I7 delimiter safety, I8 empty stays empty.
- I9 anchor: for ASCII input with notes of at most 4000 chars, `U = 23900` and `Udev = 3900` give `text`,
  `developer` and `sections[].text` byte-identical to 0.3.0. The golden is generated once from the sources at
  commit `ef08739` (pattern: `.scratch/context-system/lane-c3/generate-golden.mjs`) and committed as a fixture, so
  the test needs no git.
- I10 a larger budget never loses the latest turn's detail: for the same input, if the latest turn is detailed at
  `U >= 4000` (1000 tokens) it is detailed at every `U' > U`. Below that I3 and I2 take precedence: notes that
  just fit in full can leave room only for a condensed latest turn (a test documents this case).
- P1 500 visible turns (16000-char replies, 32768-char requests) at `U = 800000` build in well under 5 s; measure
  units incrementally rather than re-joining the pack in every loop.

`meta` (also in the chat document): `{ turns, otherChats, notes: { chars, tokens, cut }, memory: { chars, tokens },
budget: { tokens: B, used: tokens(text) }, developer: { tokens: brief, used: tokens(developer) }, truncated, degraded }`.

## 6. Stored limits

| Item | 0.3.0 | v2 |
|---|---|---|
| Project notes | 4000 chars, 16384 bytes | 16000 chars (JS length), 65536 bytes |
| Turn record `request` (`turns.js`) | 4000 chars | 32768 chars |
| `settings.json` | 1024 bytes | 65536 bytes |
| Turn record `reply` | 16000 | unchanged (journal cap) |

`src/core/context/limits.js`: of the existing `LIMITS` keys only `notes` (16000), `notesBytes` (65536) and
`request` (32768) change. Every other existing key keeps its 0.3.0 value, because the anchor and the legacy
Pipeline path read them (`team` 23900, `developer` 3900, `pipelineNotes` 2000, `pipelineEarlier` 16,
`pipelineBytes` 32768, `pipelineContextBytes` 8000, ...). New keys: `settingsBytes` 65536, `window` 128000,
`percentMin` 1, `percentMax` 50, `tokensMin` 1000, `tokensMax` 200000, `overrides` 32 (the rule bounds - no
literals elsewhere), `budgetMin` 256, `budgetMax` 200000, `briefMin` 250, `briefMax` 2000, `teamCeiling` 800000, `developerCeiling`
8000, `enginePromptBytes` 200000, `pipelineHistoryFloor` 12000, `pipelineContextFloor` 4000,
`pipelineEarlierMax` 64, `pipelineNotesMax` 16000, `pipelineBytesMax` 262144, `pipelineContextBytesMax` 65536.
The module also exports `scaledLimits`, `budgetFor`, `briefFor`, `pipelineAllowance` (§8), `DEFAULT_BUDGET` and
`UNKNOWN_RECIPIENT`.

## 7. Transport

Hard ceilings are defensive and in chars; a valid pack is never above them because `units >= length`:
planner text 800000, developer brief 8000.

- Thread-context file `<hive>/control/thread-context.json`: new form `{ "v": 3, "text": "...", "developer": "..." }`
  with `text <= 800000` and `developer <= 8000` chars (`developer` optional). The file may be up to 8388608
  bytes (escaped control characters take 6 bytes each). `v: 1` (`text <= 8000`) and `v: 2` (`text <= 24000`, `developer <= 4000`) are still accepted with their
  own caps. The server writes `v: 3` whenever it has a pack; its legacy branch (no context service) keeps
  writing `v: 1`.
- Orchestrator: the line-wise clamps of `threadContext` and `developerContext` move to 800100 and 8100. They
  count one newline per line including the last, so they need the same 100 chars of headroom over the largest
  valid pack that 0.3.0 had (23900 / 24000). Empty context: prompts unchanged byte for byte. Wrapper tags and
  headings unchanged.
- Terminal dashboard: `src/dashboard/source.js` reads only the first 16 KiB of `events.jsonl` to find
  `run_started`; a long request pushes that event past it. Read enough for a 32768-char request (262144 bytes).
- Team request: at most 32768 chars (server validation, UI). Requests of at most 4000 chars travel in argv
  exactly as today (`'--', request`; byte-identical argument list). Longer ones cannot (Windows: 32767 chars for
  the whole command line, `spawn ENAMETOOLONG` at about 16300 chars of quoted text - probe experiment 1): the
  server writes `<hive>/control/request.json` = `{ "v": 1, "request": "..." }` atomically (same helper and
  directory as the thread-context file) and passes `--request-file <path>` instead of `'--', request`.
  The server deletes the file when the child exits or fails to spawn, and removes a stale one before a run whose
  request travels in argv.
- CLI: `--request-file FILE` on `scranton run`. Positional and file together: usage error. The file must be a
  regular file (no symlink) of at most 262144 bytes holding exactly `{ "v": 1, "request": string }` with a
  non-blank request of at most 32768 chars; anything else: `Invalid request file`. The positional path is
  unchanged. Both control files (request and thread context) are read with the bounded reader of `thread.js`
  after canonicalising the file's DIRECTORY, so a data path through a junction, a symlinked directory or an 8.3
  short name stays valid; only the file itself must be a regular file.
- HTTP: the JSON body cap of `readBody` (`src/server/control.js`, also used by the registry routes) rises from
  65536 to 262144 bytes; a 32768-char request can be about 100 KB of UTF-8.
- Proven carriers (probe experiment 2): pi `json` transport (`@<inbox file>`) and `rpc` transport (stdin) both
  delivered 400000-char planning inputs intact; Docker mode uses stdin. Nothing else needs to change.

## 8. Pipeline

Budget `B` = `budgetFor(settings, planner).tokens`. The engine budgets prompts in bytes
(`limits.max_prompt_bytes`, default 200000, never set by the supervisor and not user-configurable), so the
Pipeline allowances are bytes at 4 bytes per token and are bounded by the engine:

```
mp = 200000                                  // LIMITS.enginePromptBytes; a test asserts it equals the default in engine/src/scranton_pipeline/config.py
H  = max(12000, min(3 * B, floor(mp / 4)))   // history: runs + project_memory
C  = max(4000,  min(B,     floor(mp / 8)))   // context: notes, earlier, other_chats
shown budget = floor((H + C) / 4) tokens;    capped = 'engine' when H + C != 4 * B, else as in §4
used = ceil((min(wire bytes - context bytes, H) + min(context bytes, C)) / 4)   // what the engine can render
```

The floors are the 0.3.0 allowances: below them the engine's 2048-byte anchor reserve and Node's two-run shrink
floor do not fit, and the wire would come back `null`. `pipelineAllowance(settings, planner)` returns
`{ historyBytes: H, contextBytes: C, tokens, mode, value, source, capped }`.

Examples: window 128000 at 10 % -> H 38400, C 12800, 12800 tokens; window 200000 -> H 50000, C 20000, 17500
tokens (`engine`); window 1000000 -> 18750 tokens (`engine`); a 1000-token rule -> H 12000, C 4000, 4000 tokens
(`engine`).

Wire: the §26 object plus the optional closed key `"budget": { "history_bytes": H, "context_bytes": C }`
(integers; emitted after the existing keys).

- Node `buildPipelineHistory({ ..., allowance: { historyBytes, contextBytes } })` - the new input is called
  `allowance` because `budget` already is the read budget (`{ bytes, cache, exhausted }`) of that function. The
  whole compact wire is at most `max(32768, H + C)` bytes and `context` at most `max(8000, C)` bytes; `earlier`
  holds at most 64 lines; notes enter with at most 16000 code points; shedding orders as in v1 §7; the final
  shrink loop still terminates when nothing can shrink. The wire then carries `"budget"`. Without `allowance`
  the result is byte-identical to 0.3.0 (32768 / 8000 bytes, 16 lines, 2000-char notes, no `budget` key; golden
  `test/core/fixtures/pipeline-history-legacy-whitespace.json`).
- Node artifact reads: the engine writes `run.json` with `ensure_ascii` and indentation, so a non-ASCII history
  of the new size can exceed the 262144-byte artifact cap of `pipeline-history.js`; the cap rises to 1048576.
- Python `history.py`: `budget` is optional; when present it must be exactly these two keys with integers (bool
  refused) `12000 <= history_bytes <= 196608` and `4000 <= context_bytes <= 65536`, and the limits are: file and compact
  wire 262144 bytes, `context` 65536 bytes, `earlier` 64 lines, notes 16000 code points. When absent every
  existing check behaves exactly as today (32768-byte file and wire, 8192, 16, 2000), so every existing engine
  test passes unchanged. `budget` is persisted with the rest of `cross_run_history`.
- Python `agents/prompts.py`: with `budget` the planner uses `min(H, max_prompt_bytes // 4, room)` for the history
  block and `min(C, max_prompt_bytes // 8, room ...)` for the context block (same `room` expressions as today);
  without it `min(12000, mp // 8, room)` and `min(4000, mp // 32, ...)` as today. Policy sentence, anchor reserve,
  trimming orders, frame-marker neutralisation and the planner-only rule are unchanged.

## 9. HTTP API and documents

Routes as in v1 §8, with these changes:

| Route | Change |
|---|---|
| `POST /api/projects/:p/context/settings` | body = the `configure` patch of §4 (closed keys, at least one); 400 otherwise |
| `POST /api/projects/:p/context/notes` | `text` at most 16000 chars |
| `GET /api/projects/:p/chats/:c/context` | optional query `provider` + `model` (§3); documents are v2 |

Project document:

```json
{ "v": 2,
  "settings": { "crossChat": true, "budget": { "mode": "percent", "value": 10 }, "models": {} },
  "defaults": { "budget": { "mode": "percent", "value": 10 }, "window": 128000, "percent": [1, 50], "tokens": [1000, 200000], "models": 32, "pipeline": [4000, 18750],
    "pipelineBytes": { "history": [12000, 50000], "context": [4000, 25000] } },
  "notes": { "text": "", "chars": 0, "tokens": 0, "limit": 16000, "updatedAt": null },
  "chats": [{ "id": "", "title": "", "engine": "team", "turns": 0, "lastActiveAt": null, "reset": false }] }
```

Chat document (Team):

```json
{ "v": 2, "engine": "team",
  "settings": { "crossChat": true, "budget": { "mode": "percent", "value": 10 }, "models": {} },
  "reset": null,
  "model": { "id": "anthropic/claude-sonnet-4-5", "window": 200000, "known": true },
  "budget": { "tokens": 20000, "used": 1053, "mode": "percent", "value": 10, "source": "project", "capped": null },
  "turns": { "total": 7, "visible": 5, "detailed": 4, "condensed": 1, "omitted": 0 },
  "otherChats": { "chats": 2, "turns": 5 },
  "notes": { "chars": 120, "tokens": 30, "limit": 16000, "cut": false },
  "memory": { "chars": 0, "tokens": 0 },
  "truncated": false, "degraded": false,
  "sections": [{ "id": "recent", "title": "This chat - recent turns", "chars": 4210, "tokens": 1053, "text": "...", "exact": true }],
  "developer": { "model": { "id": null, "window": 128000, "known": false },
    "budget": { "tokens": 1280, "used": 450 }, "chars": 1800, "tokens": 450, "text": "..." } }
```

- `settings.budget` is the stored project rule or the default rule; `settings.models` is always an object.
  `defaults.pipeline` is the range of the Pipeline budget in tokens and `defaults.pipelineBytes` the byte bounds
  behind it (§8: floors and engine ceilings), so a client can compute a Pipeline budget exactly.
- `budget.source` is `"model"` when an override for this recipient applies, else `"project"`. `budget.capped` is
  `null`, `"min"`, `"window"`, `"max"` or `"engine"` (§4, §8). `budget.mode` / `value` are the rule that applied.
- Team: `budget.used = tokens(text)` and `sections[].tokens = tokens(section text)`.
- Pipeline: `model` is the planner recipient, `budget` is `pipelineAllowance` plus `used` (§8), `developer` is
  `null`, `sections` are readable projections (`exact: false`) whose `tokens` are informative.
- Degraded fallback: `budget.tokens` is still the computed budget, `used` the tokens of the legacy text.
- The old fields `budget.limit` and `budget.used` in chars or bytes are gone; `v` is 2 in both documents.

## 10. CLI

```
scranton context show    --data DIR --project ID [--chat ID] [--model PROVIDER/MODEL] [--json]
scranton context budget  --data DIR --project ID (--percent N | --tokens N | --default) [--model PROVIDER/MODEL]
scranton context notes   --data DIR --project ID (--file FILE | --clear)      # file up to 65536 bytes
scranton context share | reset | restore                                       # unchanged
```

- `context budget`: without `--model` it sets the project rule (`--default` removes it); with `--model` it sets
  or (`--default`) removes that model's override. It prints the resulting project settings.
- `context show --chat`: Team chats resolve Michael and Dwight from the configuration; `--model` gives the
  planner pick of a Pipeline chat (ignored for Team chats). The budget line is exactly
  `Budget: ≈<used>/<tokens> tokens (<pct>% of budget, <pct>% of the <window>-token window of <id or "pi default">)`
  followed by ` [window assumed]` when the window is not known and ` [capped: <capped>]` when capped; the
  developer brief gets the same line starting `Developer brief:`. Notes line: `notes: <chars>/16000 chars`.
  `--json` prints the documents of §9.

## 11. Web UI (`visualizer/public`, static ES modules, strictly dark monochrome, no `innerHTML`)

- Indicator: `Context: 5 turns · 2 other chats · notes · ≈6.2k tokens (3.1%)`. The percentage is of the
  recipient's context window. Compact tokens: below 1000 the integer; below 100000 one decimal `k` without a
  trailing `.0`; above that integer `k`. No token part when nothing is used.
- Drawer summary: `≈4,210 of 20,000 tokens (21% of budget · 2.1% of the 200,000-token window)`, a monochrome
  meter of used against budget, the model id (`pi default` for null) and, when the window is not known,
  `Model window unknown - assuming 128,000 tokens`; a hint when `capped` is set (`min`, `window`, `max`:
  the budget was limited to ...; `engine`: set by the Pipeline engine's prompt budget). Each section and the
  developer brief show `≈N tokens`. Section text is shown in full: the 40000-char cut of `context.js` rises to
  the transport ceiling, since `exact: true` promises the injected text.
- Budget control in the drawer: mode (share of the model's context window in % / fixed number of tokens), a
  number input bounded by `defaults.percent` / `defaults.tokens`, a checkbox `Only for <model id>` (absent when
  the id is null), Save, and `Reset to default` (removes the override when one applies, else the project rule).
  After a mutation both documents are reloaded. Unsaved budget edits are confirmed before the drawer closes,
  exactly like unsaved notes. In a Pipeline chat the preview of a rule is computed with the formula of §8 from
  `defaults.pipelineBytes` (`floor((clamp(3B, history) + clamp(B, context)) / 4)`), not by clamping the tokens.
- Pipeline chats: the chat-document request carries the browser's current planner pick as `provider` / `model`
  (the pick the form will really send, not a stale stored one); changing the pick re-reads the chat document.
- Notes editor: counter against 16000 (`maxlength` too) plus the token estimate.
- Composer and new-run request: 32768 chars (`maxlength`, counters, `REQUEST_MAX`). The user's own request is
  shown in full in the chat view (no 16000-char cut for request entries). The composer is shared with Pipeline
  chats, whose task cap stays 32768 BYTES: there the counter and the validation work in bytes, so a long
  non-ASCII text is refused in the browser with a clear message instead of by the server.
- Message to a running agent: 16000; HITL feedback: 16000 (constants, `maxlength`, counters).

## 12. Other input limits

| Input | 0.3.0 | v2 | Known enforcement points (find the rest with a search) |
|---|---|---|---|
| Message to a running agent | 4000 chars | 16000 | `src/server/control.js` (`Chat text must contain 1 to 4000 characters`), `src/core/chat-router.js` (`maxText = 4000`, command file `size > 16384`), `visualizer/public/js/chat.js` `CHAT_MAX`, `visualizer/public/js/state.js` `CHAT_TEXT_MAX`, `index.html` (`chat-view-input`, `chat-text` and their counters) |
| HITL feedback | 8000 chars | 16000 | `src/core/file-control.js` and `src/server/control.js` (`validDecision`), `visualizer/public/js/control.js` `FEEDBACK_MAX`, `index.html` (`hitl-text`, `hitl-count`) |
| Pipeline gate comment | 4000 chars | unchanged | passed as `--comment=<text>` in argv; needs a file transport first |

File caps that carry these texts must hold 16000 chars of UTF-8 (the chat command file cap of 16384 bytes does
not). `tools/pi-agent-chat.js` already allows 16000.

## 13. Lanes (exclusive ownership; a file outside your lane is read-only)

Phase 1, in parallel:

- **A1 context core**: `src/core/context/**`; tests `test/core/context-{pack,store,index,turns,tokens,budget}*.test.js`
  and fixtures `test/core/fixtures/context-*`. Implements §2, §4, §5, §6, the documents of §9 inside `inspect` /
  `status`, and passes `budget: { historyBytes, contextBytes }` to `buildPipelineHistory` (§8).
- **A2 core transports**: `src/core/model-windows.js`, `src/core/auth.js` (one exported runtime helper only),
  `src/core/pipeline-history.js`, `src/core/orchestrator.js`, `src/core/thread.js`, `src/core/messages.js`,
  `src/core/cli.js` (thread-context v3 and `--request-file` only), `bin/**`, `src/dashboard/**`; tests
  `test/core/{model-windows,request-file}.test.js` (new),
  `test/core/{pipeline-history*,context-pipeline,orchestrator-thread,team-context,team-context-cli}.test.js`,
  `test/dashboard/**`. Implements §3 (resolver), §7 (core side, dashboard read), §8 (Node wire, artifact cap).
  A2 does not edit `src/core/context/**`: it reads the new `LIMITS` keys of §6 that A1 adds, by these names.
- **P Python**: `engine/**`. Implements §8 (engine side).
- **F frontend**: `visualizer/public/**`, `test/visualizer/**`. Implements §2 (browser mirror), §11.

Phase 2, after A1 and A2:

- **A3 CLI**: `src/core/cli.js` (`context` command, registry-mode recipients), tests
  `test/core/{context-cli,dreaming-cli}.test.js`. Implements §10 and the CLI bullet of §3.
- **S server**: `src/server/**`, `src/core/pipeline-supervisor.js`, `src/core/file-control.js`,
  `src/core/chat-router.js`, `tools/**`, `test/server/**`, and the tests of the two core files it owns.
  Implements §3 (who resolves), §7 (server side), §9, §12.
- **D docs**: `README.md` (section "Kontextsystem", German), `docs/**`, `.enma/pipeline-contract.md`,
  `.enma/context-contract.md` (a pointer to this file), and the documentation assertion in
  `test/core/context-review-fixes.test.js`.

Interfaces between lanes are exactly the signatures, documents, wire keys and file formats of §2-§10. A test
that can only pass once another lane has landed is reported as pending with its name - never "fixed" by editing
the other lane's file.

Cross-lane parity tests (owner in brackets): browser `units` / `tokens` against the Node module on the vectors
of §2 and on generated strings [A1]; `LIMITS.enginePromptBytes` against `config.py`, and the Python caps of §8
against the Node constants [A2]; browser constants (`NOTES_MAX`, `REQUEST_MAX`, chat and feedback maxima) against
the server-side values [F].

## 14. Tests whose expectations change deliberately

Everything else must pass unchanged; a failing test outside this list is reported, not edited.

| Lane | Test file | What changes |
|---|---|---|
| A1 | `test/core/context-pack.test.js` | stays as the `U = 23900` anchor; scaled cases are added |
| A1 | `test/core/context-store.test.js` | notes 16000 chars / 65536 bytes; `settings.json` 65536 bytes and v2 |
| A1 | `test/core/context-index.test.js` | Pipeline `budget.limit === 32768` becomes the token budget of §8; documents are v2 |
| A2 | `test/core/context-pipeline.test.js` | calls without `budget` keep 32768 / 8000; cases with `budget` are added |
| A2 | `test/core/orchestrator-thread.test.js`, `test/core/team-context.test.js` | clamp 24000 -> 800000 (and 4000 -> 8000) |
| A2 | `test/core/team-context-cli.test.js` | v2 caps stay; v3 cases are added |
| A3 | `test/core/context-cli.test.js` | budget and notes lines of §10, notes file cap 65536, Pipeline budget in tokens |
| A2 | `test/core/pipeline-history*.test.js`, `test/dashboard/**` | only where they pin the 262144-byte artifact cap or the 16 KiB head read |
| S | `test/server/context.test.js`, `test/server/conversation.test.js` | notes limit 16000, v2 documents, thread-context `v: 3` |
| S | `test/server/control.test.js` | request cap 4000 -> 32768, the body cap (an 80 KB body expected 413; the cap is 262144 now), chat and feedback maxima |
| F | `test/visualizer/context.test.js`, `control.test.js`, `multiproject.test.js` | v2 documents, `NOTES_MAX` 16000, request 32768, feedback 16000 |
| F | `test/visualizer/chat-view.test.js`, `chat-panel.test.js`, `static-safety.test.js` | chat-message maximum 16000 and the markup they pin (`maxlength`, counters) |
| D | `test/core/context-review-fixes.test.js` | the documentation paragraph on the thread-context file names `v: 3` |
| P | `engine/tests/**` | none change; new cases are added |

## 15. Rules for every lane

- Edit only the files your lane owns. Never stage, commit, revert or reformat anything; the untracked `.claude/`
  and `hive/live.json` are the user's and are not to be touched.
- Follow the surrounding style (dense ESM, Node built-ins only, `node:test`; Python as in `engine/`). No new
  dependencies. Few, short comments that say why.
- New tests keep fixtures under `.scratch/` (never the real `./hive`, never `os.tmpdir()` for new tests);
  committed fixtures live next to the tests.
- A regression test only counts if it fails without the change: name for each new test the line whose reversion
  makes it fail, or show the failing run.
- Run your targeted test files and report the exact commands and counters; do not run the full suites while
  other lanes are working.
- When the contract and the code cannot both be satisfied, stop on that point and report it with the evidence -
  do not pick a side silently.
