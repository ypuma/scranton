import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createAuthService } from '../../src/core/auth.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';

test('review 1 HTTP: broken custom configuration keeps account/key/logout routes available', async (t) => {
  const root = path.resolve('.scratch/keys-fix'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'http-'));
  const auth = createAuthService({ authPath: path.join(dir, 'auth.json'), env: {} });
  const server = await startVisualizerServer({ hiveDir: path.join(dir, 'hive'), publicDir: dir, port: 0, control: { workspace: dir, auth } });
  t.after(async () => { await server.close(); await auth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = async (route, body) => {
    const response = await fetch(server.url + route, { method: body ? 'POST' : 'GET', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  for (const file of ['models.json', 'scranton-providers.json']) {
    fs.writeFileSync(path.join(dir, file), '{broken');
    const result = await request('/api/auth');
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.accounts.map((p) => p.id), ['anthropic', 'openai', 'google']);
    assert.match(result.data.accounts[0].detail, /custom provider configuration/i);
    assert.equal((await request('/api/auth/providers')).status, 200);
    assert.equal((await request('/api/auth/key', { provider: 'google', key: 'FAKE_HTTP_KEY' })).status, 202);
    assert.equal((await request('/api/auth/logout', { provider: 'google' })).status, 202);
    fs.rmSync(path.join(dir, file));
  }
});
