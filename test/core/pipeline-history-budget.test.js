import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPipelineHistory, readPipelineHistoryJson } from '../../src/core/pipeline-history.js';
import { LIMITS } from '../../src/core/context/limits.js';

function fixture(t) {
  const base = path.resolve('.scratch/context-budget/a2'); fs.mkdirSync(base, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(base, 'wire-')); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const scope = { dataDir, projectId: 'project', chatId: 'chat' };
  const write = (id, name, value) => {
    const file = path.join(dataDir, 'projects/project/chats/chat/pipeline/runs', id, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); return file;
  };
  return { scope, write };
}
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const allowances = [[12000, 4000], [12000, 8000], [24000, 8000], [38400, 12800], [50000, 20000], [50000, 25000], [196608, 65536]];

// Regression anchors: wireBytes/contextBytes floors, allowance-specific note/line caps, result.budget.
for (const [historyBytes, contextBytes] of allowances) test(`budgeted wire obeys ${historyBytes}/${contextBytes} byte allowances and floors`, (t) => {
  const f = fixture(t), allowance = { historyBytes, contextBytes };
  for (let i = 1; i <= 4; i++) {
    const id = `run${i}`;
    f.write(id, 'status.json', { status: 'failed', created_at: String(i) });
    f.write(id, 'run.json', { task: '\u{1f680}"\\'.repeat(4000) });
    f.write(id, 'artifacts/plan.json', { summary: '\u754c'.repeat(8000), steps: [{ id: 's', title: 'Keep anchor', files: [] }] });
    f.write(id, 'delivery/reply.json', { text: '\u{1f680}'.repeat(8000) });
  }
  const context = { notes: '\u754c'.repeat(16001), lines: Array.from({ length: 100 }, (_, i) => ({ run_id: `old${i}`, line: `#${i} ` + '\u{1f680}'.repeat(240) })),
    other_chats: Array.from({ length: 6 }, () => ({ title: 'Sibling', engine: 'team', turns: ['\u754c'.repeat(240)] })) };
  const result = buildPipelineHistory({ ...f.scope, allowance, context });
  assert.ok(result); assert.deepEqual(result.budget, { history_bytes: historyBytes, context_bytes: contextBytes });
  assert.equal(Object.keys(result).at(-1), 'budget');
  assert.ok(bytes(result) <= Math.max(32768, historyBytes + contextBytes));
  assert.ok(bytes(result.context) <= Math.max(8000, contextBytes));
  assert.ok(Array.from(result.context.notes).length <= LIMITS.pipelineNotesMax);
  assert.ok((result.context.earlier?.length ?? 0) <= LIMITS.pipelineEarlierMax);
  assert.equal(result.runs.at(-1).run_id, 'run4'); assert.ok(result.runs.at(-1).plan);
  if (historyBytes + contextBytes > 75000) assert.ok(bytes(result) > 32768, 'large allowances must not retain the legacy wire cap');
});

test('budgeted notes retain 16000 code points and earlier retains newest 64 lines when room exists', (t) => {
  const f = fixture(t), context = { notes: 'n'.repeat(16001), lines: Array.from({ length: 70 }, (_, i) => ({ run_id: `r${i}`, line: `#${i}` })) };
  const result = buildPipelineHistory({ ...f.scope, context, allowance: { historyBytes: 50000, contextBytes: 25000 } });
  assert.equal(result.context.notes.length, 16000); assert.equal(result.context.earlier.length, 64);
  assert.deepEqual(result.context.earlier, context.lines.slice(-64).map((v) => v.line)); assert.equal(result.context.omitted, 6);
  const legacy = buildPipelineHistory({ ...f.scope, context });
  assert.equal(legacy.context.notes.length, 2000); assert.equal(legacy.context.earlier.length, 16); assert.ok(!Object.hasOwn(legacy, 'budget'));
});

// Regression anchors: unchanged context shedding order and the final !fields.length return.
test('budgeted context-only shrink terminates, shedding chats then lines then notes', { timeout: 5000 }, (t) => {
  const f = fixture(t), result = buildPipelineHistory({ ...f.scope, allowance: { historyBytes: 12000, contextBytes: 4000 },
    context: { notes: '\u{1f680}'.repeat(16000), lines: Array.from({ length: 64 }, (_, i) => ({ run_id: `r${i}`, line: '\u{1f680}'.repeat(240) })),
      other_chats: [{ title: 'Other', engine: 'team', turns: ['other'] }] } });
  assert.deepEqual(result.budget, { history_bytes: 12000, context_bytes: 4000 });
  assert.deepEqual(result.runs, []); assert.ok(bytes(result.context) <= 8000); assert.ok(bytes(result) <= 32768);
  assert.equal(result.context.other_chats, undefined); assert.equal(result.context.earlier, undefined);
  assert.equal(result.context.omitted, undefined); assert.match(result.context.notes, /\u2026$/);
  assert.equal(buildPipelineHistory({ ...f.scope, allowance: { historyBytes: 12000, contextBytes: 4000 }, context: {} }), null);
});

// Regression anchor: MAX_ARTIFACT = 1024 * 1024; all identity guards remain active.
test('artifact reader accepts up to 1048576 bytes, rejects the next byte and charges its separate read budget', (t) => {
  const f = fixture(t), json = JSON.stringify({ task: 'New non-ASCII history \u754c'.repeat(10000) });
  const file = f.write('r1', 'run.json', {}), rel = path.relative(f.scope.dataDir, file).split(path.sep).join('/');
  const raw = json + ' '.repeat(1048576 - Buffer.byteLength(json)); fs.writeFileSync(file, raw);
  const budget = { bytes: 1048576, cache: new Map() };
  assert.deepEqual(readPipelineHistoryJson(f.scope.dataDir, rel, { budget }), JSON.parse(json)); assert.equal(budget.bytes, 0);
  fs.appendFileSync(file, ' '); assert.equal(readPipelineHistoryJson(f.scope.dataDir, rel), null);
  fs.writeFileSync(file, json); const small = { bytes: 1 };
  assert.equal(readPipelineHistoryJson(f.scope.dataDir, rel, { budget: small }), null); assert.equal(small.exhausted, true);
});

// Regression anchors: all allowance branches; Python independently checks byte and leaf caps.
test('Python validates a batch of Node-built legacy and budgeted wires', (t) => {
  const python = path.resolve('.scratch/pipeline/venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(python)) return t.skip('Development Python venv unavailable');
  const f = fixture(t), wires = [];
  for (const [historyBytes, contextBytes] of allowances) for (const fragment of ['a', '\u754c', '\u{1f680}', '\u0001"\\']) {
    const context = { notes: fragment.repeat(16000), lines: Array.from({ length: 80 }, (_, i) => ({ run_id: `r${i}`, line: fragment.repeat(240) })) };
    for (const allowance of [undefined, { historyBytes, contextBytes }]) {
      const wire = buildPipelineHistory({ ...f.scope, allowance, context });
      assert.equal(Object.hasOwn(wire, 'budget'), Boolean(allowance)); wires.push(wire);
    }
  }
  const script = path.join(f.scope.dataDir, 'validate.py');
  fs.writeFileSync(script, 'import json,sys\nfrom scranton_pipeline.history import validate_history\nfrom scranton_pipeline.tools.secrets import Redactor\nwires=json.load(sys.stdin)\nfor wire in wires: validate_history(wire,Redactor())\nprint(len(wires))\n');
  const result = spawnSync(python, [script], { input: JSON.stringify(wires), encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONPATH: path.resolve('engine/src'), PYTHONPYCACHEPREFIX: path.resolve('.scratch/pipeline/bytecode'),
      TEMP: path.resolve('.scratch/pipeline/tmp'), TMP: path.resolve('.scratch/pipeline/tmp'), TMPDIR: path.resolve('.scratch/pipeline/tmp') } });
  assert.equal(result.status, 0, result.stderr); assert.equal(Number(result.stdout.trim()), 56); t.diagnostic(`Python accepted ${result.stdout.trim()} Node-built wires`);
});
