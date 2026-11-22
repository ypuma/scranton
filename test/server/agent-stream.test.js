import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, events, until } from './agent-fixture.js';

for (const scoped of [false, true]) test(`agent SSE ${scoped ? 'scoped' : 'single'}: attempts, invocations, inclusive offset and Last-Event-ID resume`, async t => {
  const f = await fixture(t, scoped);
  assert.equal((await f.start([{ text: 'failed partial', error: { status: 503 } }, { text: 'first [TASK_COMPLETE]' }]).done).ok, true);
  assert.equal((await f.start([{ text: 'second [TASK_COMPLETE]' }]).done).ok, true);
  const route = `${f.prefix}/runs/r1/agents/dwight-m1/stream`;
  const response = await f.request(route); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const all = events(await response.text()), chunks = all.filter(event => event.event === 'chunk');
  assert.deepEqual(all.at(-1), { event: 'end', id: undefined, data: { status: 'SUCCESS' } });
  assert.deepEqual(chunks.filter(event => event.data.type === 'attempt_start').map(event => event.data.attempt), [1, 2, 1]);
  assert.match(chunks.map(event => event.data.delta ?? '').join(''), /first.*second/s);
  assert.deepEqual(chunks.map(event => Number(event.id)), chunks.map((_, index) => index));
  const query = events(await (await f.request(route + '?fromOffset=2')).text());
  assert.deepEqual(query, all.slice(2));
  const header = events(await (await f.request(route, undefined, { 'Last-Event-ID': '2' })).text());
  assert.deepEqual(header, all.slice(3));
  for (const url of [route.replace('/r1/', '/missing/'), route.replace('dwight-m1', 'unknown')]) assert.equal((await f.request(url)).status, 404);
  for (const value of ['-1', 'NaN', '9007199254740992', '1.5']) assert.equal((await f.request(route + '?fromOffset=' + value)).status, 400);
  assert.equal((await f.request(route, undefined, { 'x-scranton-client': '' })).status, 403);
  assert.equal((await f.request(route, undefined, { Origin: 'https://foreign.test' })).status, 403);
  if (scoped) {
    assert.equal((await f.request(f.foreign + '/runs/r1/agents/dwight-m1/stream')).status, 404);
    assert.equal((await f.request(route.replace(f.prefix.split('/')[3], 'missing'))).status, 404);
  }
});

test('agent SSE streams invocations created later in the same active run', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.hive, 'state.json'), JSON.stringify({ runId: 'r1', status: 'running' }));
  await f.start([{ text: 'first [TASK_COMPLETE]' }]).done;
  const response = await f.request('/api/runs/r1/agents/dwight-m1/stream');
  const reader = response.body.getReader();
  let text = new TextDecoder().decode((await reader.read()).value);
  await f.start([{ text: 'later [TASK_COMPLETE]' }]).done;
  fs.writeFileSync(path.join(f.hive, 'state.json'), JSON.stringify({ runId: 'r1', status: 'finished' }));
  for (;;) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
  assert.match(events(text).map(e => e.data.delta ?? '').join(''), /first.*later/s);
  assert.equal(events(text).at(-1).event, 'end');
});

test('agent SSE disconnect closes an active durable reader; server close does not hang', async t => {
  const f = await fixture(t), runner = f.start([{ text: 'later', delayMs: 1000 }]);
  await until(() => f.runtime.listWorkflows(), rows => rows.length);
  const response = await f.request('/api/runs/r1/agents/dwight-m1/stream');
  await response.body.cancel();
  await f.server.close();
  assert.equal((await runner.abort()).ok, false);
});

for (const explicit of [false, true]) test(`shared database streams only the addressed hive with ${explicit ? 'explicit registry' : 'hashed hive'} identity`, async t => {
  const { sharedFixture } = await import('./agent-fixture.js');
  const f = await sharedFixture(t);
  const ids = chatId => explicit ? { projectId: 'project', chatId } : {};
  const a = f.start('a', [{ text: 'private-a [TASK_COMPLETE]' }], ids('a'));
  assert.equal((await a.done).ok, true);
  assert.equal((await f.request('/b/stream')).status, 404);
  const b = f.start('b', [{ text: 'private-b [TASK_COMPLETE]' }], ids('b'));
  assert.equal((await b.done).ok, true);
  assert.notEqual(a.workflowId, b.workflowId);
  assert.equal((await f.runtime.listWorkflows()).length, 2);
  const legacy = f.start('a', [{ text: 'legacy-secret [TASK_COMPLETE]' }], { workflowId: 'scr:single/hive/r1/dwight-m1/old' });
  assert.equal((await legacy.done).ok, true);
  for (const chat of ['a', 'b']) {
    const response = await f.request(`/${chat}/stream`);
    assert.equal(response.status, 200);
    const output = events(await response.text()).map(e => e.data.delta ?? '').join('');
    assert.match(output, new RegExp('private-' + chat));
    assert.doesNotMatch(output, /legacy-secret/);
    assert.doesNotMatch(output, new RegExp('private-' + (chat === 'a' ? 'b' : 'a')));
  }
});

for (const dead of ['finished', 'owner-gone']) test(`agent SSE ends interrupted when pending workflow's run is ${dead}`, async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.hive, 'state.json'), JSON.stringify({ runId: 'r1', status: 'running' }));
  const runner = f.start([{ text: 'late', delayMs: 10000 }]);
  await until(() => f.runtime.listWorkflows(), rows => rows.length);
  const response = await f.request('/api/runs/r1/agents/dwight-m1/stream');
  if (dead === 'finished') fs.writeFileSync(path.join(f.hive, 'state.json'), JSON.stringify({ runId: 'r1', status: 'aborted' }));
  else {
    const { spawnSync } = await import('node:child_process');
    const exited = spawnSync(process.execPath, ['--version']);
    fs.mkdirSync(path.join(f.hive, 'control'), { recursive: true });
    fs.writeFileSync(path.join(f.hive, 'control/owner.json'), JSON.stringify({ v: 1, runId: 'r1', token: 'fixture' }));
    fs.writeFileSync(path.join(f.hive, 'control/heartbeat.json'), JSON.stringify({ v: 1, runId: 'r1', pid: exited.pid, at: new Date().toISOString() }));
  }
  let timeout;
  try {
    const text = await Promise.race([response.text(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Interrupted stream did not end')), 2000); })]);
    assert.deepEqual(events(text).at(-1), { event: 'end', id: undefined, data: { status: 'interrupted' } });
  } finally { clearTimeout(timeout); await runner.abort(); }
});
