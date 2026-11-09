// Regenerates the hive fixtures: node test/dashboard/fixtures/build-fixtures.js
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScenario, reduceState } from './scenario.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// the recorded parallel RPC demo (test/visualizer/fixtures/record-demo.js)
const DEMO = path.join(here, '..', '..', '..', 'visualizer', 'public', 'demo', 'sample-events.jsonl');

async function write(name, events, jsonl = events.map((e) => JSON.stringify(e)).join('\n') + '\n') {
  const dir = path.join(here, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'events.jsonl'), jsonl);
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(reduceState(events), null, 2) + '\n');
  console.log(`${name}: ${events.length} events`);
}

for (const name of ['running', 'tripped', 'finished', 'aborted']) {
  const events = buildScenario(name);
  let jsonl = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  // A live writer can be caught mid-line; consumers must skip the fragment.
  if (name === 'running') jsonl += '{"v":1,"seq":' + (events.length + 1) + ',"ts":"2025-06-14T10:2';
  await write(name, events, jsonl);
}

// The demo cut off while m1 and m2 run in parallel and the human message to dwight-m2 is delivered.
const demo = (await readFile(DEMO, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const cut = demo.findIndex((e) => e.type === 'chat_delivery') + 1;
await write('parallel', demo.slice(0, cut));

await mkdir(path.join(here, 'idle'), { recursive: true });
await writeFile(path.join(here, 'idle', 'README.md'), 'A hive before the first run: no state.json and no events.jsonl, so the dashboard shows its idle screen.\n');
