# Reflection core API (frozen)

Final overrides in memory `claude-code-dreaming` govern this additive v1 extension. Deterministic consolidation/replay are unchanged. No provider calls in the core library itself.

## Factory and methods
`createDreaming({dataDir,projectId,collect,isBusy,now,collectReflection,completeReflection})`.
- `propose({model?} = {})` is deliberately **not async**. It throws synchronous safe `.status` 400/409 on invalid/busy/pending/repeated/unavailable prerequisites, records running synchronously, then returns a Promise resolving the complete status after generation. `model` is a provider/model string, falling back only to configured reflectionModel; integration must authenticate/catalog-validate it before calling. Manual generation does not require scheduling enabled.
- `applyProposal(proposalId)` / `rejectProposal(proposalId)` return complete status synchronously. Apply revalidates base, sources, exact quotes, types and capacities. Base authority includes settings, deterministic episodes and accepted reflection memory; sweep timestamps, limitation notices and derived promotion timestamps do not stale unchanged proposals. No automatic acceptance.
- `cancelReflection()` aborts immediately and returns complete status synchronously. Run-start must call it. A 100ms isBusy fallback also aborts. Async completion persists cancellation without promoting anything. Late provider results are ignored.
- `close()` cancels and returns the active job Promise, if any. Integration awaits it. Core retains its job lease while awaiting transport cleanup, bounded by the original hard deadline; injected transport must own cleanup and honor signal/timeout.
- `status().reflection` has `{state,jobId,startedAt,finishedAt,error,usage,proposal,memory,limitations}`. States idle/running/ready/failed/cancelled. Nullable fields explicit; arrays explicit. Completion failures use fixed safe messages, not provider output. Accepted notes are in reflection.memory; top-level memory remains deterministic.

Settings: reflectionEnabled false; reflectionModel null; reflectionMaxOutputTokens 2048 (integer256..4096); reflectionTimeoutSeconds60 (integer10..60). Legacy v1 settings remain stored exactly until edited; missing extension fields resolve to defaults in payloads. Existing enabled/intervalMinutes/applyPolicy semantics unchanged. Scheduling belongs to integration, never core.

## Adapter input
Synchronous `collectReflection()` -> `{signals,limitations}`. Each signal exactly:
`{id,runId,role,text,at,sources:[{path,sha256}]}`.
`runId` is a stable 64-hex digest of project/chat/engine/original-run identity, not a source path; id stable hash-derived safe identifier. role user/assistant/outcome. ISO timestamp. Up to four runIds, <=1000 total excerpt characters **per runId**, <=4000 overall; <=32 signals, <=3 original source refs/signal. All sources verified against regular unlinked project-scoped artifacts using existing storage verification. Core also redacts excerpts. Unknown adapter limitation text is never surfaced; only a fixed coverage notice. All supplied evidence files, not just the first, are retained when used (proposals over three expanded evidence refs are refused).

`completeReflection({model,system,user,maxOutputTokens,timeoutMs,signal})` -> Promise `{text,usage}`; usage null or `{inputTokens,outputTokens,costUsd?}` with finite nonnegative counts/cost. Combined system+user <=12000 characters, output <=4096, hard deadline <=60 seconds. Model-facing memory includes every accepted id/type/title with bounded text; signals include every id/role with bounded redacted text, not stored hashes or provenance. A shared text-prefix cap is reduced until the serialized request fits. Exact quote checks at generation and apply use these same projected excerpts; original source verification and fingerprints remain authoritative. Hard deadline expiration is failed; explicit cancellation, close, or project busy is cancelled. No tools or ambient context; transport owns enforcement outside core too.

Team archival locator clarification: the adapter emits canonical `projects/<project>/chats/<chat>/hive/runs/<originalRunId>/events.jsonl` provenance even while that run is live. Run identity hashes project/chat/engine/original run ID, independent of live/archive location. Service validation reads only this fixed archive location, or (only when absent) that chat's fixed `hive/events.jsonl`; every journal row must bind the original run ID with sequential v1 events and terminal boundaries, and original SHA-256 must match. Unsafe or changed existing archives fail closed, never fall back. No artifact-controlled path, digest-search, copied projection or other chat/project is an alternate original. Links/hardlinks are refused. Expected unchanged-byte archival preserves signals/fingerprints; no history is rewritten. Privacy disclosure is not a coverage limitation; missing optional Pipeline reply alone is not coverage loss.

## Strict model output
JSON only, exactly `{summary,operations}`. summary <=400 chars. <=12 operations. Every operation has exactly:
`{action,targetIds,type,title,text,reason,evidence}`.
- action add/replace/remove; targetIds [] for add, existing generated note IDs for replace/remove (multiple supported); no deterministic IDs or repeated targets.
- type user/feedback/project/reference; title <=80; text <=400. For remove, type/title/text MUST all be null.
- reason <=400, evidence <=3 entries exactly `{signalId,quote}`, with no duplicate signalId/quote pairs. Add/replace require nonempty known exact redacted quotations. user/feedback require user evidence. Remove may have no evidence.
- Unsupported schema/capacities reject the entire result. Model output never silently prunes unrelated notes. Summary/reason/title/text are redacted; exact quotations must already be redacted.

Normalized proposal: `{id,createdAt,model,summary,operations,usage,base,fingerprint}`.
Normalized operation adds `before:[notes]`, `after:note|null`, expands evidence to `{signalId,quote,role,at,path,sha256}`.
Accepted note exactly `{id,type,title,text,evidence,createdAt}`. Maximum16 accepted notes/16KiB serialized. IDs derived from normalized content and evidence. Before/after are actual reviewed transformations, not provider claims.

## Persistence and injection
state.json remains authority with optional validated reflection and reflection-memory preimages. proposal.json is staged before state commit and must match the pending proposal; removed after apply/reject. Valid orphan projections are not authority; malformed projections fail closed. Separate owned `.reflection-job` lease excludes cross-instance model work without holding `.owner-lock` over awaits. Crash-orphan leases need exclusive offline recovery; no PID-based lock stealing. Attempt fingerprints persist independently of rollback (bounded64, then refuse), including failed/noop/cancelled requests, preventing repeated automatic charges for identical inputs. Noop/failure/cancellation never changes accepted notes.

Settings, deterministic snapshots and generated-note memory have exact preimages, including absent legacy settings. Rollback retains attempt accounting. MEMORY.md is a compact index into NOTES.md, both derived projections; neither is read as evidence. Sources are revalidated at apply and injection. context()/structuredContext() combine deterministic and generated memory under <=16 entries, <=2000 serialized characters (structured), <=2000 characters (text), <=400 text/entry, <=3 path refs<=240. Advisory historical content only; not current evidence or permission to supersede a task.

Read-only deterministic `preview()` is allowed during reflection generation (including another instance's reflection lease), but still refuses actual project-run busy state or a synchronous state owner lock. Sweep/settings/rollback/apply remain excluded during generation.
