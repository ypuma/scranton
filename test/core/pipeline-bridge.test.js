import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const helper = path.resolve('tools/pipeline-pi-complete.js');
const base = path.resolve('.scratch/pipeline/lane-b/core');
const secret = 'private-prompt-do-not-print';
const fake = `import fs from 'node:fs';
const argv = process.argv.slice(2);
fs.writeFileSync(process.env.BRIDGE_RECORD, JSON.stringify({argv, cwd: process.cwd(), files: fs.readdirSync('.'), env: Object.keys(process.env), system: fs.readFileSync(argv[argv.indexOf('--append-system-prompt')+1], 'utf8'), user: fs.readFileSync(argv.find(a=>a.startsWith('@')).slice(1), 'utf8')}));
const mode = process.env.BRIDGE_MODE;
if (mode === 'exit') { console.error('private-prompt-do-not-print'); process.exit(1); }
if (mode === 'transient') { console.error('429 rate limit private-prompt-do-not-print'); process.exit(1); }
if (mode === 'hang') await new Promise(() => setInterval(() => {}, 1000));
if (mode === 'tool') { console.log(JSON.stringify({type:'tool_execution_start'})); console.error('429 rate limit'); }
if (mode === 'empty') process.exit(0);
const message = {role:'assistant', content:[{type:'text',text:'{"ok":true}'}], stopReason: mode === 'stoperror' ? 'error' : 'stop', errorMessage: mode === 'stoperror' ? '503 unavailable' : undefined};
if (mode !== 'no_usage') message.usage = mode === 'zero_usage' ? {input:0,output:0,cacheRead:0,cacheWrite:0} : mode === 'cache_usage' ? {input:11,output:17,cacheRead:23,cacheWrite:29,cacheWrite1h:7} : {input:11,output:17};
console.log(JSON.stringify({type:'message_end',message}));
console.log(JSON.stringify({type:'agent_settled',aborted:false}));
`;

async function invoke(t, mode, selection = {}) {
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'call-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pi = path.join(dir, 'fake.mjs'), request = path.join(dir, 'request.json'), response = path.join(dir, 'response.json'), record = path.join(dir, 'record.json');
  fs.writeFileSync(pi, fake);
  fs.writeFileSync(request, JSON.stringify({ v: 1, role: 'planner', model: 'test', system: secret, user: secret, max_output_tokens: 8192, temperature: 0 }));
  fs.writeFileSync(response, 'stale response must be removed');
  const child = spawn(process.execPath, [helper, '--provider', selection.provider ?? 'anthropic', '--model', selection.model ?? 'test', '--thinking', selection.thinking ?? 'low', request, response], { env: { ...process.env, SCRANTON_PI_COMMAND: JSON.stringify([process.execPath, pi]), SCRANTON_PIPELINE_KEY_PLANNER: 'sensitive-key', SCRANTON_PIPELINE_PI_TIMEOUT_MS: mode === 'hang' ? '1000' : '10000', BRIDGE_MODE: mode, BRIDGE_RECORD: record }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(stdout, ''); assert.equal(stderr, '');
  if (Object.keys(selection).length) { assert.equal(fs.existsSync(record), false); assert.equal(fs.readdirSync(dir).some((f) => f.startsWith('pi-')), false); return { code }; }
  const seen = JSON.parse(fs.readFileSync(record));
  assert.equal(fs.existsSync(seen.cwd), false);
  assert.deepEqual(seen.files, []);
  assert.equal(seen.system, secret); assert.equal(seen.user, secret); assert.equal(seen.argv.some((a) => a.includes(secret)), false);
  assert.equal(seen.env.some((k) => k.startsWith('SCRANTON_PIPELINE_KEY_')), false);
  assert.equal(fs.readdirSync(dir).some((f) => f.startsWith('pi-')), false);
  return { code, seen, response };
}

for (const mode of ['ok', 'no_usage', 'zero_usage', 'cache_usage', 'exit', 'transient', 'stoperror', 'empty', 'hang', 'tool']) {
  test(`Pipeline pi bridge: ${mode}, private prompt cleanup and silent output`, async (t) => {
    const { code, seen, response } = await invoke(t, mode);
    assert.equal(code, ['transient', 'stoperror', 'hang'].includes(mode) ? 75 : ['exit', 'empty', 'tool'].includes(mode) ? 1 : 0);
    const flags = ['--mode', 'json', '-p', '--no-tools', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-session', '--no-approve', '--provider', 'anthropic', '--model', 'test', '--thinking', 'low'];
    assert.deepEqual(seen.argv.slice(0, flags.length), flags);
    assert.equal(seen.argv[flags.length], '--system-prompt');
    if (code === 0) assert.deepEqual(JSON.parse(fs.readFileSync(response)), { text: '{"ok":true}', usage: ['no_usage', 'zero_usage'].includes(mode) ? null : { input_tokens: mode === 'cache_usage' ? 63 : 11, output_tokens: 17 } });
    else assert.equal(fs.existsSync(response), false);
  });
}

for (const selection of [{ provider: '--tools' }, { model: '--extensions' }, { model: 'test\n--tools' }, { thinking: '--tools' }, { thinking: 'bogus' }]) {
  test(`Pipeline pi bridge refuses option injection ${JSON.stringify(selection)}`, async (t) => {
    assert.equal((await invoke(t, 'ok', selection)).code, 1);
  });
}

// Status fixtures exercise the bridge without starting an engine or model.
test('Pipeline conversation list bounds replies and inspect preserves reply/event envelopes', async (t) => {
  const { createPipelineSupervisor } = await import('../../src/core/pipeline-supervisor.js');
  const base = path.resolve('.scratch/pipeline/chat-node/tests'); fs.mkdirSync(base, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(base, 'list-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const supervisor = createPipelineSupervisor({ dataDir, env: {} });
  const chat = { projectId: 'project1', id: 'chat0001' };
  const runs = path.join(dataDir, 'projects/project1/chats/chat0001/pipeline/runs');
  const reply = { from: 'pipeline', kind: 'answer', text: 'A'.repeat(4001), truncated: false, citations: ['E-1234567890'] };
  const status = (id, reply) => ({ schema: 1, run_id: id, status: 'succeeded', phase: 'done', task: 'Question', created_at: '2026-11-11T00:00:00Z', updated_at: '2026-11-11T00:01:00Z', ...(reply ? { reply } : {}) });
  for (const [id, value] of [['answer01', status('answer01', reply)], ['normal01', status('normal01')]]) {
    fs.mkdirSync(path.join(runs, id), { recursive: true });
    fs.writeFileSync(path.join(runs, id, 'status.json'), JSON.stringify(value));
  }
  const events = [
    { seq: 1, ts: '2026-11-11T00:00:30Z', run_id: 'answer01', type: 'agent_message', node: null, data: { role: 'planner', text: 'A valid turn', context: 'Revision 0', final: true, truncated: false } },
    { seq: 2, ts: '2026-11-11T00:00:31Z', run_id: 'answer01', type: 'run_reply', node: null, data: reply }
  ];
  fs.writeFileSync(path.join(runs, 'answer01/events.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
  const list = supervisor.list(chat);
  assert.deepEqual(list, { active: null, runs: [
    { runId: 'answer01', status: 'succeeded', phase: 'done', task: 'Question', createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:01:00Z', reply: { kind: 'answer', text: 'A'.repeat(4000), truncated: true, citations: ['E-1234567890'] } },
    { runId: 'normal01', status: 'succeeded', phase: 'done', task: 'Question', createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:01:00Z' }
  ] });
  assert.equal(Object.hasOwn(list.runs[1], 'reply'), false);
  const inspected = await supervisor.inspect(chat, 'answer01');
  assert.deepEqual(inspected.status.reply, reply);
  assert.deepEqual(inspected.events, events);
  assert.deepEqual((await supervisor.inspect(chat, 'answer01', 1)).events, [events[1]]);
  for (const truncated of [false, true]) {
    const short = { ...reply, kind: 'result', text: 'Done', truncated, citations: [] };
    fs.writeFileSync(path.join(runs, 'answer01/status.json'), JSON.stringify(status('answer01', short)));
    assert.deepEqual(supervisor.list(chat).runs[0].reply, { kind: 'result', text: 'Done', truncated, citations: [] });
  }
});
