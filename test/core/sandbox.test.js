import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkSandbox, cleanupRunContainers, DEFAULT_DOCKER_IMAGE } from '../../src/core/sandbox.js';

const scratch = path.resolve('.scratch/docker-executor/credentials');
fs.mkdirSync(scratch, { recursive: true });
process.env.SCRANTON_CREDENTIALS_DIR = scratch;

const executable = 'fake-docker';
test('Docker checks fail closed for CLI, daemon and missing local image', async () => {
  assert.match((await checkSandbox({}, { executable: null })).reason, /Docker CLI not found/);
  assert.match((await checkSandbox({}, { executable, run: async () => { throw Error('SECRET'); } })).reason, /engine is not responding/);
  const result = await checkSandbox({}, { executable, run: async (_exe, args) => args[0] === 'info' ? 'linux' : '' });
  assert.equal(result.available, false);
  const missing = await checkSandbox({}, { executable, run: async (_exe, args) => { if (args[0] === 'info') return 'linux'; throw Error('SECRET'); } });
  assert.match(missing.reason, /docker build --pull=false/); assert.doesNotMatch(missing.reason, /SECRET/);
});
test('Docker checker rejects non-Docker modes instead of bypassing the boundary', async () => {
  for (const mode of ['host', 'trusted-host', 'scranton']) {
    await assert.rejects(checkSandbox({ mode }, { executable, run: async () => { throw Error('must not probe'); } }), /Sandbox mode must be docker/);
  }
});
test('Docker uses own tool image, accepts network alias and never validates host model choices', async () => {
  const calls = [];
  const result = await checkSandbox({ network: 'allow' }, { executable, run: async (_exe, args) => { calls.push(args); return 'linux'; } });
  assert.equal(result.image, DEFAULT_DOCKER_IMAGE); assert.equal(result.network, 'bridge');
  assert.deepEqual(calls.map(args => args[0]), ['info', 'image']);
});
test('orphan cleanup removes only the matching labeled Scranton container and verifies absence', async () => {
  const a = 'scranton-11111111-1111-1111-1111-111111111111', b = 'scranton-22222222-2222-2222-2222-222222222222';
  const calls = [];
  const warnings = await cleanupRunContainers('run-1', [], { executable, run: async (_exe, args) => {
    calls.push(args);
    if (args.includes('{{.Names}}')) return `${a}\n${b}\nunrelated`;
    if (args[1] === 'inspect') return JSON.stringify([{ Config: { Labels: { 'scranton.run': args[2] === a ? 'run-1' : 'other' } } }]);
    return '';
  } });
  assert.deepEqual(warnings, []); assert.deepEqual(calls.filter(args => args[0] === 'rm'), [['rm', '-f', a]]);
});
test('tool image recipe contains no inference installation or host copy', () => {
  const recipe = fs.readFileSync('sandbox/Dockerfile', 'utf8');
  assert.match(recipe, /^FROM node:24-bookworm-slim$/m);
  assert.deepEqual([...recipe.matchAll(/apt-get install -y --no-install-recommends ([^\r\n]+)/g)].map(match => match[1].trim()), ['git bash ca-certificates \\']);
  const lock = JSON.parse(fs.readFileSync('tools-lock.json', 'utf8'));
  for (const tool of ['rg', 'fd']) {
    const prefix = tool.toUpperCase();
    assert.ok(recipe.includes(`${prefix}_VERSION='${lock.tools[tool].version}'`));
    for (const target of ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu']) {
      const pin = lock.tools[tool].targets[target];
      assert.ok(recipe.includes(`${prefix}_URL='${pin.url}'`));
      assert.ok(recipe.includes(`${prefix}_SHA256='${pin.sha256}'`));
    }
    const check = `printf '%s  %s\\n' "$${prefix}_SHA256" '/tmp/${tool}.tar.gz' | sha256sum -c -`;
    const extract = `tar -xzf /tmp/${tool}.tar.gz`;
    assert.ok(recipe.includes(check));
    assert.ok(recipe.indexOf(extract) > recipe.indexOf(check));
    assert.ok(recipe.includes(`install -m 0755 "/tmp/search-tools/$${prefix}_BINARY" /usr/local/bin/${tool}`));
  }
  assert.match(recipe, /USER 10001:10001/); assert.doesNotMatch(recipe, /npm install|earendil|^COPY |^ADD /m);
});
