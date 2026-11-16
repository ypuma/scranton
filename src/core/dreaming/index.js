import { createStorage, fail, digest, HASH } from './storage.js';
import { emptyReflection, validateReflection, validateNotes, validateProposal, collectInput, reduceOutput, normalizeOutput, applyOperations, baseDigest, systemPrompt, modelInput } from './reflection.js';
import { randomUUID } from 'node:crypto';
import { ADAPTER_LIMITATIONS, LIMITS, freezeEpisodes, consolidate, replay } from './consolidate.js';

export { OBSERVATION_TEXT, ADAPTER_LIMITATIONS } from './consolidate.js';
const defaults = () => ({ enabled: false, intervalMinutes: 360, applyPolicy: false, reflectionEnabled: false, reflectionModel: null, reflectionMaxOutputTokens: 2048, reflectionTimeoutSeconds: 60 });
const clone = (v) => structuredClone(v);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function settings(input, partial = false) {
  if (!object(input) || Object.keys(input).some((k) => !Object.keys(defaults()).includes(k))) fail(400, 'Invalid dreaming settings');
  for (const k of ['enabled', 'applyPolicy']) if ((!partial || Object.hasOwn(input, k)) && typeof input[k] !== 'boolean') fail(400, 'Invalid dreaming settings');
  if ((!partial || Object.hasOwn(input, 'intervalMinutes')) && (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 15 || input.intervalMinutes > 10080)) fail(400, 'Invalid dreaming interval');
  for (const [key, min, max] of [['reflectionMaxOutputTokens', 256, 4096], ['reflectionTimeoutSeconds', 10, 60]]) if (Object.hasOwn(input, key) && (!Number.isInteger(input[key]) || input[key] < min || input[key] > max)) fail(400, 'Invalid reflection limits');
  if (Object.hasOwn(input, 'reflectionEnabled') && typeof input.reflectionEnabled !== 'boolean') fail(400, 'Invalid reflection settings');
  if (Object.hasOwn(input, 'reflectionModel') && input.reflectionModel !== null && (typeof input.reflectionModel !== 'string' || !/^[^\s\x00-\x1f]{1,120}\/[^\s\x00-\x1f]{1,119}$/.test(input.reflectionModel))) fail(400, 'Invalid reflection model');
  return input;
}
const empty = () => ({ at: null, episodes: [], limitations: [] });
const SNAPSHOT_BYTES = 240000;
function limitations(list) {
  const counts = new Map(), other = new Set();
  for (const text of list) {
    const match = /^Excluded (\d+): (.+)\.$/.exec(text);
    if (match) counts.set(match[2], (counts.get(match[2]) ?? 0) + Number(match[1]));
    else other.add(text);
  }
  return [...counts].map(([reason, count]) => `Excluded ${count}: ${reason}.`).concat([...other]).slice(0, 32);
}
function boundSnapshot(snapshot, budget = SNAPSHOT_BYTES) {
  const episodes = [...snapshot.episodes].sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.identity.localeCompare(b.identity));
  const prior = snapshot.limitations.filter((s) => !s.includes(': serialized snapshot capacity.'));
  let excluded = snapshot.limitations.reduce((n, text) => n + (Number(/^Excluded (\d+): serialized snapshot capacity\.$/.exec(text)?.[1]) || 0), 0);
  const update = () => {
    snapshot.episodes = [...episodes].sort((a, b) => a.identity.localeCompare(b.identity));
    snapshot.limitations = limitations([...(excluded ? [`Excluded ${excluded}: serialized snapshot capacity.`] : []), ...prior]);
  };
  update();
  while (Buffer.byteLength(JSON.stringify(snapshot)) > budget && episodes.length) { episodes.pop(); excluded++; update(); }
  return snapshot;
}
function safeLimitations(list) {
  const approved = new Set(Object.values(ADAPTER_LIMITATIONS)), counts = new Map();
  let unknown = 0;
  for (const item of list) {
    const text = typeof item === 'string' && Object.hasOwn(ADAPTER_LIMITATIONS, item) ? ADAPTER_LIMITATIONS[item] : approved.has(item) ? item : null;
    if (text) counts.set(text, (counts.get(text) ?? 0) + 1);
    else unknown++;
  }
  const texts = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([text, count]) => count === 1 ? text : `${text} (${count} occurrences)`);
  if (unknown) texts.push(`Adapter reports ${unknown} additional coverage limitation(s).`);
  return texts;
}

export function createDreaming({ dataDir, projectId, collect, collectReflection, completeReflection, isBusy = () => false, now = () => Date.now() } = {}) {
  if (typeof collect !== 'function' || typeof isBusy !== 'function' || typeof now !== 'function') fail(400, 'Invalid dreaming adapter');
  const storage = createStorage(dataDir, projectId);
  let closed = false, active = false, verify, job = null, closing;
  const timestamp = () => new Date(now()).toISOString();
  const preimage = (record) => ({ settings: clone(record.settings), current: clone(record.current), ...(record.reflection ? { reflectionMemory: clone(record.reflection.memory) } : {}) });
  const guard = (fn) => {
    if (closed) fail(409, 'Dreaming is closed');
    try { verify = storage.verification(); return fn(); } catch (error) { if (error.status) throw error; fail(409, 'Dreaming operation unavailable'); }
  };
  function load() {
    const record = storage.read(), staged = storage.read('proposal.json');
    if (staged !== null) validateProposal(staged);
    if (!record) return { v: 1, projectId, settings: defaults(), current: empty(), previous: null, diary: [] };
    try {
      if (!object(record) || record.v !== 1 || record.projectId !== projectId || !Array.isArray(record.diary) || record.diary.length > 24) throw Error();
      settings(record.settings);
      if (record.reflection !== undefined) validateReflection(record.reflection);
      if (record.previous?.reflectionMemory !== undefined) validateNotes(record.previous.reflectionMemory);
      if (record.reflection?.proposal && JSON.stringify(staged) !== JSON.stringify(record.reflection.proposal)) throw Error();
      const snapshot = (s) => {
        if (!object(s) || !Array.isArray(s.episodes) || s.episodes.length > 256 || !Array.isArray(s.limitations) || s.limitations.length > 32 || s.limitations.some((v) => typeof v !== 'string' || v.length > 160) || (s.at !== null && (!Number.isFinite(Date.parse(s.at)) || new Date(s.at).toISOString() !== s.at))) throw Error();
        if (s.promotions !== undefined && (!object(s.promotions) || Object.keys(s.promotions).length > 12 || Object.entries(s.promotions).some(([id, at]) => !/^[a-f0-9]{24}$/.test(id) || typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at))) throw Error();
        // Requiring exact normalization rejects injected prose and malformed persisted records without repairing them.
        const normalized = freezeEpisodes(s.episodes.map((e) => ({ ...e, observations: e.observations.map((key) => ({ key, verified: true })) })), () => true, Infinity).episodes;
        if (JSON.stringify(normalized) !== JSON.stringify(s.episodes)) throw Error();
      };
      snapshot(record.current);
      if (record.previous !== null) { settings(record.previous.settings); snapshot(record.previous.current); }
      if (record.diary.some((d) => !object(d) || !/^[a-f0-9]{24}$/.test(d.id) || !Number.isFinite(Date.parse(d.at)) || !['Deterministic consolidation saved.', 'Dreaming settings saved.', 'Latest preimage restored.', 'Reflection proposal applied.'].includes(d.text) || !Number.isInteger(d.promoted) || d.promoted < 0 || d.promoted > 12)) throw Error();
      return record;
    } catch { fail(409, 'Invalid dreaming state; no repair performed'); }
  }
  function busy() {
    if (job || active || storage.isLocked() || storage.isReflecting()) return true;
    try { return Boolean(isBusy()); } catch { fail(409, 'Dreaming availability unavailable'); }
  }
  function fresh(snapshot) {
    return freezeEpisodes(snapshot.episodes.map((e) => ({ ...e, observations: e.observations.map((key) => ({ key, verified: true })) })), verify, now());
  }
  function derive(snapshot, time = now()) {
    const frozen = fresh(snapshot), candidates = consolidate(frozen.episodes, time);
    const result = replay(frozen.episodes), memory = [];
    if (snapshot.at) for (const c of candidates.filter((c) => c.eligible)) {
      const entry = { id: c.id, text: c.text, score: c.score, sources: c.sources, promotedAt: snapshot.promotions?.[c.id] ?? snapshot.at };
      if (Buffer.byteLength(JSON.stringify([...memory, entry])) <= 16384) memory.push(entry);
    }
    return { candidates, memory, ...result, frozen };
  }
  function payload(record, snapshot = record.current, preview = false) {
    const d = derive(snapshot), state = busy() ? 'busy' : 'idle';
    return { v: 1, projectId, ...defaults(), ...record.settings, state,
      reflection: reflectionView(record),
      lastSweepAt: record.current.at,
      nextSweepAt: record.settings.enabled && record.current.at ? new Date(Date.parse(record.current.at) + record.settings.intervalMinutes * 60000).toISOString() : null,
      canRollback: record.previous !== null,
      counts: { episodes: d.frozen.episodes.length, candidates: d.candidates.length, promoted: d.memory.length, worlds: d.replay.worlds },
      phases: [{ name: 'light', status: 'deduplicated', count: d.frozen.episodes.length }, { name: 'rem', status: 'grouped', count: d.candidates.length }, { name: 'deep', status: 'weighted gates evaluated', count: d.memory.length }],
      memory: d.memory, candidates: d.candidates, replay: d.replay, diary: record.diary,
      limitations: limitations([...snapshot.limitations, ...d.frozen.limitations, ...d.candidates.filter((c) => c.signals.excludedEpisodes).map((c) => `Excluded ${c.signals.excludedEpisodes}: observation evidence window for ${c.id}.`), LIMITS]), ...(preview ? { preview: true } : {}) };
  }
  function acquire(readOnly = false) {
    if (readOnly ? active || storage.isLocked() || projectBusy() : busy()) fail(409, 'Dreaming is busy');
    let data;
    try { data = collect(); } catch { fail(409, 'Dreaming collection unavailable'); }
    if (!object(data) || !Array.isArray(data.episodes) || !Array.isArray(data.limitations)) fail(409, 'Invalid dreaming collection');
    const frozen = freezeEpisodes(clone(data.episodes), verify, now());
    return { at: new Date(now()).toISOString(), episodes: frozen.episodes, limitations: [...safeLimitations(data.limitations), ...frozen.limitations].slice(0, 32) };
  }
  function prepare(record, snapshot) {
    const incoming = new Set(snapshot.episodes.map((e) => e.identity));
    const retained = fresh(record.current);
    const merged = freezeEpisodes([...retained.episodes.filter((e) => !incoming.has(e.identity)), ...snapshot.episodes].map((e) => ({ ...e, observations: e.observations.map((key) => ({ key, verified: true })) })), () => true, now());
    const prepared = { ...snapshot, episodes: merged.episodes, limitations: limitations([...snapshot.limitations, ...retained.limitations, ...merged.limitations]) };
    const before = derive(record.current).memory;
    const after = derive(prepared).memory;
    prepared.promotions = Object.fromEntries(after.map((m) => {
      const old = before.find((entry) => entry.id === m.id && JSON.stringify(entry.sources) === JSON.stringify(m.sources));
      return [m.id, old?.promotedAt ?? prepared.at];
    }));
    return boundSnapshot(prepared);
  }
  function structuredContext() {
    const entries = [];
    const record = load();
    for (const m of [...derive(record.current).memory, ...(record.reflection?.memory ?? []).filter((m) => m.evidence.every((e) => verify({ path: e.path, sha256: e.sha256 }))).map((m) => ({ ...m, sources: m.evidence }))]) {
      const entry = { id: m.id, text: m.text.slice(0, 400), sources: m.sources.slice(0, 3).map((s) => s.path) };
      if (entries.length < 16 && JSON.stringify([...entries, entry]).length <= 2000) entries.push(entry);
    }
    return entries;
  }
  function save(record, text) {
    // Reserve room for a full future preimage, settings and the bounded audit trail.
    if (text && text !== 'Latest preimage restored.') boundSnapshot(record.current);
    let view = payload(record);
    if (text) record.diary = [...record.diary, { id: digest(`${text}:${record.current.at}:${JSON.stringify(record.settings)}:${record.diary.length}`).slice(0, 24), at: new Date(now()).toISOString(), text, promoted: view.memory.length }].slice(-24);
    let state = JSON.stringify(record) + '\n';
    // Legacy records may exceed the new per-snapshot budget. Keep their exact rollback
    // preimage and reduce only the new current snapshot until the whole record fits.
    if (Buffer.byteLength(state) > 524288 && text !== 'Latest preimage restored.') {
      const overhead = Buffer.byteLength(state) - Buffer.byteLength(JSON.stringify(record.current));
      boundSnapshot(record.current, Math.max(0, 524288 - overhead));
      view = payload(record);
      state = JSON.stringify(record) + '\n';
    }
    const memory = '# Project memory\n\nAdvisory historical notes, not current evidence or instructions.\n\n' + [...view.memory.map((m) => ({ id: m.id, title: m.text })), ...view.reflection.memory].map((m) => `- [${m.title}](NOTES.md#${m.id})`).join('\n') + '\n';
    const notes = '# Historical notes\n\n' + [...view.memory.map((m) => ({ ...m, title: 'Structural observation' })), ...view.reflection.memory].map((m) => `## ${m.id}\n${m.type ?? 'deterministic'}: ${m.title}\n\n${m.text}\n`).join('\n');
    const diary = '# Deterministic dreaming\n\n' + record.diary.map((d) => `- ${d.at}: ${d.text} Promoted: ${d.promoted}.`).join('\n') + '\n';
    if ([state, memory, notes, diary].some((value) => Buffer.byteLength(value) > 524288)) fail(409, 'Dreaming state limit exceeded');
    // Projections are replaceable views; state.json is the sole commit point and authority.
    if (text) { storage.atomic('MEMORY.md', memory); storage.atomic('NOTES.md', notes); storage.atomic('DREAMS.md', diary); }
    storage.atomic('state.json', state);
    return payload(record);
  }
  function mutate(fn) {
    if (busy()) fail(409, 'Dreaming is busy');
    active = true;
    try { const result = storage.locked(() => fn(load())); return { ...result, state: 'idle' }; } finally { active = false; }
  }
  function reflectionView(record) {
    const { fingerprints, ...view } = record.reflection ?? emptyReflection();
    return clone(view);
  }
  function reflectionInput() {
    if (typeof collectReflection !== 'function') fail(400, 'Reflection sources unavailable');
    let data;
    try { data = collectReflection(); } catch { fail(409, 'Reflection collection unavailable'); }
    return collectInput(clone(data), storage.verification());
  }
  function projectBusy() {
    try { return Boolean(isBusy()); } catch { return true; }
  }
  function propose(options = {}) {
    return guard(() => {
      if (!object(options) || Object.keys(options).some((k) => k !== 'model')) fail(400, 'Invalid reflection request');
      if (busy()) fail(409, 'Dreaming is busy');
      if (typeof completeReflection !== 'function') fail(400, 'Reflection completion unavailable');
      const record = load(), config = { ...defaults(), ...record.settings };
      const model = options.model ?? config.reflectionModel;
      settings({ reflectionModel: model }, true);
      if (!model) fail(400, 'Select a reflection model');
      if (record.reflection?.proposal) fail(409, 'Review the pending proposal first');
      const input = reflectionInput(), reflection = record.reflection ?? emptyReflection();
      if (reflection.fingerprints.includes(input.fingerprint)) fail(409, 'Reflection input already attempted');
      if (reflection.fingerprints.length >= 64) fail(409, 'Reflection fingerprint capacity exceeded');
      const projected = modelInput(reflection.memory, input), user = projected.user;
      const base = baseDigest(record), controller = new AbortController(), jobId = randomUUID();
      let release;
      storage.locked(() => {
        const current = load();
        if (baseDigest(current) !== base || projectBusy()) fail(409, 'Reflection prerequisites changed');
        release = storage.lease();
        try {
          current.reflection = { ...reflection, state: 'running', jobId, startedAt: timestamp(), finishedAt: null, error: null, usage: null, limitations: input.limitations, fingerprints: [...reflection.fingerprints, input.fingerprint] };
          save(current, null);
        } catch (error) { release(); throw error; }
      });
      const owned = { controller, promise: null, cancelled: false };
      job = owned;
      // Completion never owns the synchronous state lock while waiting on transport.
      owned.promise = finishReflection({ owned, release, model, user, input: projected.input, config, base, jobId });
      return owned.promise;
    });
  }
  async function finishReflection({ owned, release, model, user, input, config, base, jobId }) {
    let timer, poll, abortListener, completion;
    const deadline = Date.now() + config.reflectionTimeoutSeconds * 1000;
    try {
      const cancelled = new Promise((_, reject) => {
        abortListener = () => reject(Error('cancelled'));
        owned.controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      timer = setTimeout(() => { owned.controller.abort(); }, config.reflectionTimeoutSeconds * 1000);
      poll = setInterval(() => { if (projectBusy()) { owned.cancelled = true; owned.controller.abort(); } }, 100);
      poll.unref();
      completion = Promise.resolve().then(() => {
        if (owned.controller.signal.aborted) throw Error('cancelled');
        return completeReflection({ model, system: systemPrompt, user, maxOutputTokens: config.reflectionMaxOutputTokens, timeoutMs: config.reflectionTimeoutSeconds * 1000, signal: owned.controller.signal });
      });
      const result = await Promise.race([completion, cancelled]);
      if (projectBusy()) { owned.cancelled = true; owned.controller.abort(); }
      if (owned.cancelled || owned.controller.signal.aborted) throw Error('cancelled');
      if (!object(result) || Object.keys(result).some((k) => !['text', 'usage'].includes(k)) || !Object.hasOwn(result, 'usage')) fail(409, 'Invalid reflection completion');
      storage.locked(() => {
        const record = load();
        if (closed || owned.cancelled || projectBusy() || record.reflection?.jobId !== jobId || baseDigest(record) !== base) fail(409, 'Reflection prerequisites changed');
        const freshInput = reflectionInput();
        if (freshInput.fingerprint !== input.fingerprint) fail(409, 'Reflection sources changed');
        const proposal = reduceOutput(result.text, record.reflection.memory, input, { model, at: timestamp(), usage: result.usage, base });
        record.reflection = { ...record.reflection, state: proposal ? 'ready' : 'idle', finishedAt: timestamp(), proposal, usage: result.usage, limitations: [...input.limitations, ...(!proposal ? ['No changes proposed.'] : [])] };
        if (proposal) storage.atomic('proposal.json', JSON.stringify(proposal) + '\n');
        save(record, null);
      });
    } catch {
      try {
        storage.locked(() => {
          const record = load();
          if (record.reflection?.jobId !== jobId) return;
          record.reflection.state = owned.cancelled ? 'cancelled' : 'failed';
          record.reflection.error = owned.cancelled ? 'Reflection cancelled.' : 'Reflection failed.';
          record.reflection.finishedAt = timestamp();
          save(record, null);
        });
      } catch { /* Corrupt or concurrently owned state is never repaired. */ }
    } finally {
      clearTimeout(timer); clearInterval(poll);
      owned.controller.signal.removeEventListener('abort', abortListener);
      // Keep the separate lease until transport cleanup, but never beyond the hard deadline.
      let cleanupTimer;
      if (completion) await Promise.race([completion.catch(() => {}), new Promise((resolve) => { cleanupTimer = setTimeout(resolve, Math.max(0, deadline - Date.now())); })]);
      clearTimeout(cleanupTimer);
      try { release(); } finally { if (job === owned) job = null; }
    }
    verify = storage.verification();
    return clone(payload(load()));
  }
  function cancelReflection() {
    if (job) { job.cancelled = true; job.controller.abort(); }
    return guard(() => {
      const record = load(), view = payload(record);
      if (job) Object.assign(view.reflection, { state: 'cancelled', error: 'Reflection cancelled.', finishedAt: timestamp() });
      return clone(view);
    });
  }
  function rejectProposal(proposalId) {
    return guard(() => mutate((record) => {
      if (!record.reflection?.proposal || record.reflection.proposal.id !== proposalId) fail(409, 'Reflection proposal not found');
      record.reflection.proposal = null; record.reflection.state = 'idle';
      const result = save(record, null); storage.remove('proposal.json'); return result;
    }));
  }
  function applyProposal(proposalId) {
    return guard(() => mutate((record) => {
      const proposal = record.reflection?.proposal;
      if (!proposal || proposal.id !== proposalId) fail(409, 'Reflection proposal not found');
      if (baseDigest(record) !== proposal.base) fail(409, 'Reflection base changed');
      const input = reflectionInput();
      if (input.fingerprint !== proposal.fingerprint || projectBusy()) fail(409, 'Reflection sources changed');
      // Re-run the exact quote/type guards against newly acquired redacted source excerpts.
      const raw = { summary: proposal.summary, operations: proposal.operations.map(({ action, targetIds, type, title, text, reason, evidence }) => ({ action, targetIds, type, title, text, reason, evidence: [...new Map(evidence.map(({ signalId, quote }) => [JSON.stringify([signalId, quote]), { signalId, quote }])).values()] })) };
      const checked = normalizeOutput(raw, record.reflection.memory, modelInput(record.reflection.memory, input).input, { model: proposal.model, at: proposal.createdAt, usage: proposal.usage, base: proposal.base });
      if (!checked || JSON.stringify(checked.operations) !== JSON.stringify(proposal.operations)) fail(409, 'Reflection proposal changed');
      const memory = applyOperations(record.reflection.memory, proposal);
      record.previous = preimage(record);
      record.reflection.memory = memory; record.reflection.proposal = null; record.reflection.state = 'idle';
      const result = save(record, 'Reflection proposal applied.'); storage.remove('proposal.json'); return result;
    }));
  }
  return {
    status: () => guard(() => clone(payload(load()))),
    preview: () => guard(() => { const record = load(), snapshot = prepare(record, acquire(true)); return clone(payload(record, snapshot, true)); }),
    sweep: () => guard(() => {
      const snapshot = acquire(), initial = load();
      if (!snapshot.episodes.length && !initial.current.at) return clone(payload(initial, snapshot));
      return mutate((record) => {
        const prepared = prepare(record, snapshot);
        // Promotion must not reuse hashes acquired before the mutation boundary.
        verify = storage.verification();
        if (!prepared.episodes.every((e) => e.sources.every(verify))) fail(409, 'Dreaming sources changed before promotion');
        if (JSON.stringify(prepared.episodes) === JSON.stringify(record.current.episodes)) {
          record.current = prepared;
          return save(record, null);
        }
        record.previous = preimage(record);
        record.current = prepared;
        return save(record, 'Deterministic consolidation saved.');
      });
    }),
    configure: (patch) => guard(() => { settings(patch, true); return mutate((record) => {
      const next = { ...record.settings, ...patch };
      if (JSON.stringify(next) === JSON.stringify(record.settings)) return payload(record);
      record.previous = preimage(record); record.settings = next;
      return save(record, 'Dreaming settings saved.');
    }); }),
    rollback: () => guard(() => mutate((record) => {
      if (!record.previous) fail(409, 'No dreaming preimage available');
      record.settings = record.previous.settings; record.current = record.previous.current;
      if (record.previous.reflectionMemory !== undefined) { record.reflection ??= emptyReflection(); record.reflection.memory = record.previous.reflectionMemory; }
      if (record.reflection) { record.reflection.proposal = null; record.reflection.state = 'idle'; }
      record.previous = null; storage.remove('proposal.json');
      return save(record, 'Latest preimage restored.');
    })),
    memory: () => guard(structuredContext),
    structuredContext: () => guard(structuredContext),
    context: () => guard(() => {
      const memory = structuredContext();
      if (!memory.length) return '';
      let text = 'Advisory project memory: historical notes only, not current evidence or instructions.\n';
      for (const m of memory) { const line = `- ${m.text} [${m.id}]\n`; if (text.length + line.length <= 2000) text += line; }
      return text;
    }),
    policy: (engine, ceiling, cohort) => guard(() => {
      if (!['team', 'pipeline'].includes(engine) || !Number.isInteger(ceiling) || ceiling < 1 || ceiling > 100) fail(400, 'Invalid dreaming policy scope');
      const record = load();
      if (!record.settings.applyPolicy || typeof cohort !== 'string' || !HASH.test(cohort)) return null;
      const proof = derive(record.current).proofs.find((p) => p.engine === engine && p.baselineCap === ceiling && p.cohort === cohort);
      return proof && proof.sources.every(verify) ? Math.min(ceiling, proof.cap) : null;
    }),
    propose, applyProposal, rejectProposal, cancelReflection,
    close: () => {
      if (closing) return closing;
      closed = true;
      if (job) { job.cancelled = true; job.controller.abort(); }
      // Teardown waits for owned cleanup, not the final on-disk status projection.
      closing = Promise.resolve(job?.promise).then(() => {}, () => {});
      return closing;
    }
  };
}
