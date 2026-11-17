import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelWindows, modelId } from '../../src/core/model-windows.js';

const unknown = (id = null) => ({ id, window: 128000, known: false });
const known = (id, window) => ({ id, window, known: true });
const empty = { list: () => [] };
const fake = (models) => ({ getModel: (provider, id) => models.find((m) => m.provider === provider && m.id === id), getAllModels: () => models });

// Regression anchors: modelId's validation and provider-null branch.
test('model ids handle defaults, malformed references, slash ids and model-only configuration', async () => {
  const resolver = createModelWindows({ providers: empty, runtime: () => { throw Error('must not load'); } });
  for (const ref of [null, undefined, {}, [], 'p/m', { provider: 'p' }, { model: '' }, { model: 'a b' }, { model: 'm', provider: '' }, { model: 'm', provider: 1 }, { model: 'm', provider: 'a\u0000' }, { model: 'm'.repeat(257) }, { get model() { throw Error(); } }]) {
    assert.equal(modelId(ref), null); assert.deepEqual(await resolver.resolve(ref), unknown());
  }
  for (let code = 0; code <= 0x9f; code++) {
    if (code > 0x1f && code < 0x7f) continue;
    for (const ref of [{ provider: 'p', model: 'm' + String.fromCharCode(code) }, { provider: 'p' + String.fromCharCode(code), model: 'm' }]) {
      assert.equal(modelId(ref), null, `control U+${code.toString(16)}`); assert.deepEqual(await resolver.resolve(ref), unknown());
    }
  }
  assert.equal(modelId({ provider: 'p', model: 'a/b' }), 'p/a/b');
  assert.equal(modelId({ provider: null, model: 'm' }), 'm');
  assert.equal(modelId({ model: 'm' }), 'm');
});

// Regression anchors: custom lookup precedes load(), and list() is inside resolve().
test('custom declarations win and are reread for every resolve without loading pi', async () => {
  let window = 64000, reads = 0;
  const resolver = createModelWindows({ providers: { list: () => { reads++; return [{ id: 'custom', models: [{ id: 'm', contextWindow: window }] }]; } }, runtime: () => { throw Error(); } });
  assert.deepEqual(await resolver.resolve({ provider: 'custom', model: 'm' }), known('custom/m', 64000));
  window = 96000;
  assert.deepEqual(await resolver.resolve({ provider: 'custom', model: 'm' }), known('custom/m', 96000));
  assert.deepEqual(await resolver.resolve({ model: 'm' }), known('m', 96000));
  assert.equal(reads, 3);
});

// Regression anchors: safe-integer check, registry getModel fallback and per-instance promise cache.
test('invalid custom windows fall through to the cached registry getModel', async () => {
  let loads = 0;
  const resolver = createModelWindows({ providers: () => [{ id: 'p', models: [{ id: 'm', contextWindow: -1 }] }], runtime: () => { loads++; return fake([{ provider: 'p', id: 'm', contextWindow: 200000 }]); } });
  const results = await Promise.all(Array.from({ length: 5 }, () => resolver.resolve({ provider: 'p', model: 'm' })));
  assert.ok(results.every((r) => r.known && r.window === 200000)); assert.equal(loads, 1);
  assert.deepEqual(await resolver.resolve({ provider: 'p', model: 'missing' }), unknown('p/missing'));
});

test('unknown, non-positive, fractional and unsafe registry windows stay unknown', async () => {
  for (const window of [undefined, 0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '200000']) {
    const resolver = createModelWindows({ providers: empty, runtime: fake([{ provider: 'p', id: 'm', contextWindow: window }]) });
    assert.deepEqual(await resolver.resolve({ provider: 'p', model: 'm' }), unknown('p/m'));
  }
});

// Regression anchor: windowOf requires every matching registry window to agree.
test('provider-less references require a unanimous positive registry window', async () => {
  for (const [windows, expected] of [[[], unknown('m')], [[32000], known('m', 32000)], [[64000, 64000], known('m', 64000)], [[64000, 128000], unknown('m')], [[64000, 0], unknown('m')]]) {
    const resolver = createModelWindows({ providers: empty, runtime: fake(windows.map((contextWindow, i) => ({ provider: `p${i}`, id: 'm', contextWindow }))) });
    assert.deepEqual(await resolver.resolve({ model: 'm' }), expected);
  }
});

// Regression anchors: independent provider catch, cached load failure and outer resolve catch.
test('provider and registry failures never throw and failed registry creation is cached', async () => {
  let calls = 0;
  const resolver = createModelWindows({ providers: () => { throw Error(); }, runtime: () => { calls++; throw Error(); } });
  for (let i = 0; i < 2; i++) assert.deepEqual(await resolver.resolve({ provider: 'p', model: 'm' }), unknown('p/m'));
  assert.equal(calls, 1);
  const fallback = createModelWindows({ providers: () => { throw Error(); }, runtime: fake([{ provider: 'p', id: 'm', contextWindow: 10 }]) });
  assert.deepEqual(await fallback.resolve({ provider: 'p', model: 'm' }), known('p/m', 10));
  const broken = createModelWindows({ providers: empty, runtime: { getAllModels() { throw Error(); }, getModel() { throw Error(); } } });
  assert.deepEqual(await broken.resolve({ model: 'm' }), unknown('m'));
  assert.deepEqual(await broken.resolve({ provider: 'p', model: 'm' }), unknown('p/m'));
});

// Regression anchors: sharedRuntime and createModelRuntime (offline paths + Antigravity registration).
test('real pi registry resolves a known model offline; cold and warm timings', async (t) => {
  const ref = { provider: 'openai', model: 'gpt-4o' };
  const resolver = createModelWindows({ providers: empty });
  const start = performance.now(), result = await resolver.resolve(ref), cold = performance.now() - start;
  const next = performance.now(), warmResult = await createModelWindows({ providers: empty }).resolve(ref), warm = performance.now() - next;
  assert.equal(result.known, true); assert.ok(result.window > 0); assert.deepEqual(result, warmResult);
  t.diagnostic(`Real pi registry cold=${cold.toFixed(3)} ms warm=${warm.toFixed(3)} ms window=${result.window}`);
  assert.deepEqual(await resolver.resolve({ provider: 'google-antigravity', model: 'gemini-3-pro' }), known('google-antigravity/gemini-3-pro', 1048576));
});

// Removing warm/load reuse makes this fail without touching installed pi models or providers.
test('warm starts one background registry load and resolve reuses it', async () => {
  let loads = 0, reads = 0, finish;
  const resolver = createModelWindows({ providers: () => { reads++; return []; }, runtime: () => {
    loads++; return new Promise((resolve) => { finish = resolve; });
  } });
  assert.doesNotThrow(() => { resolver.warm(); resolver.warm(); });
  await Promise.resolve(); assert.equal(loads, 1); assert.equal(reads, 0);
  const pending = resolver.resolve({ provider: 'p', model: 'm' });
  finish(fake([{ provider: 'p', id: 'm', contextWindow: 96000 }]));
  assert.deepEqual(await pending, known('p/m', 96000));
  resolver.warm(); assert.deepEqual(await resolver.resolve({ provider: 'p', model: 'm' }), known('p/m', 96000)); assert.equal(loads, 1);
});
test('warm never throws or leaks rejected runtime loads and failures stay cached', async () => {
  for (const runtime of [() => { throw Error('load failed'); }, () => Promise.reject(Error('load failed'))]) {
    let loads = 0;
    const resolver = createModelWindows({ providers: empty, runtime: () => { loads++; return runtime(); } });
    assert.doesNotThrow(() => { resolver.warm(); resolver.warm(); });
    assert.deepEqual(await resolver.resolve({ provider: 'p', model: 'm' }), unknown('p/m'));
    resolver.warm(); assert.equal(loads, 1);
  }
});

// Revert valid's isWellFormed check to accept these malformed references.
test('lone surrogates are malformed model references without consulting either source', async () => {
  let reads = 0, loads = 0;
  const resolver = createModelWindows({ providers: () => { reads++; return []; }, runtime: () => { loads++; return fake([]); } });
  for (const part of ['bad\ud800', 'bad\udc00']) for (const ref of [{ provider: 'p', model: part }, { provider: part, model: 'm' }]) {
    assert.equal(modelId(ref), null); assert.deepEqual(await resolver.resolve(ref), unknown());
  }
  assert.equal(reads, 0); assert.equal(loads, 0); assert.equal(modelId({ provider: 'p', model: '\ud83d\ude80' }), 'p/\ud83d\ude80');
});
