import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';

const publicDir = fileURLToPath(new URL('../../visualizer/public/', import.meta.url));
const scratch = fileURLToPath(new URL('../../.scratch/desktop-csp/', import.meta.url));

test('dashboard HTTP CSP permits only same-origin and Tauri IPC connections', async (t) => {
  fs.mkdirSync(scratch, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(scratch, 'server-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const srv = await startVisualizerServer({ hiveDir: fixture, publicDir, port: 0 });
  t.after(() => srv.close());

  for (const method of ['GET', 'HEAD']) {
    for (const route of ['/', '/index.html']) {
      const response = await fetch(`${srv.url}${route}`, { method });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
      const csp = response.headers.get('content-security-policy');
      assert.ok(csp, `${method} ${route} has a CSP`);
      const directives = csp.split(';').map((part) => part.trim().split(/\s+/));
      const connect = directives.find(([name]) => name === 'connect-src');
      assert.deepEqual(connect, ['connect-src', "'self'", 'ipc:', 'http://ipc.localhost'],
        'exact allowlist excludes foreign origins, wildcard hosts, broad HTTP(S) and other loopback ports');
      assert.deepEqual(directives.filter(([name]) => name !== 'connect-src'), [
        ['default-src', "'self'"],
        ['script-src', "'self'"],
        ['style-src', "'self'"],
        ['img-src', "'self'", 'data:'],
        ['object-src', "'none'"],
        ['base-uri', "'none'"],
        ['frame-ancestors', "'none'"],
      ], 'all other CSP directives remain unchanged, including script-src');
      await response.arrayBuffer();
    }
  }
  const script = await fetch(`${srv.url}/js/main.js`);
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('content-security-policy'), null, 'CSP remains HTML-only');
  await script.arrayBuffer();
});
