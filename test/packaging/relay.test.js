import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { desktopPlatform } from '../../scripts/desktop-platform.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = path.join(root, 'src-tauri/staged/app');
const staged = existsSync(path.join(app, 'packaging-manifest.json'));
const options = { skip: !staged && 'Run npm.cmd run app:prepare first' };

async function environment(t) {
  const scratch = path.join(root, '.scratch/packaging/relay');
  await fs.mkdir(scratch, { recursive: true });
  const profile = await fs.mkdtemp(path.join(scratch, 'profile-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  return {
    cwd: profile, encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, PATH: '', HOME: profile, USERPROFILE: profile,
      APPDATA: profile, LOCALAPPDATA: profile, TEMP: profile, TMP: profile, TMPDIR: profile,
      SCRANTON_CREDENTIALS_DIR: path.join(profile, 'credentials') }
  };
}

const bundledNode = () => path.join(root, 'src-tauri/binaries', desktopPlatform().nodeFile);

test('staged relay server, pairing page, CLI and install instructions match current sources', options, async () => {
  for (const file of ['src/server/relay.js', 'src/server/relay-page.js', 'src/core/cli.js',
    'bin/scranton.js', 'docs/RELAY.md', 'docs/DESKTOP.md', 'package.json', 'package-lock.json',
    'visualizer/public/js/phone-relay.js', 'visualizer/public/js/settings-panel.js',
    'visualizer/public/index.html', 'visualizer/public/styles.css']) {
    assert.deepEqual(await fs.readFile(path.join(app, file)), await fs.readFile(path.join(root, file)),
      `${file}: staging missing/stale; run npm.cmd run app:prepare`);
  }
});

test('bundled Node CLI resolves the real relay import offline from a different cwd/profile', options, async (t) => {
  const run = spawnSync(bundledNode(), [path.join(app, 'bin/scranton.js'), 'relay'], await environment(t));
  assert.equal(run.status, 2, 'Missing origin must reach relay validation, not fail module loading');
  assert.match(run.stderr, /--origin.*HTTPS/);
  assert.doesNotMatch(run.stderr, /ERR_MODULE_NOT_FOUND|unexpected error|not available/);
  assert.equal(run.stdout, '', 'Invalid invocation must not create a pairing code');
});

test('bundled Node runs staged relay pairing and authenticated session API on loopback offline', options, async (t) => {
  const script = `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    const { startRelay } = await import(${JSON.stringify(pathToFileURL(path.join(app, 'src/server/relay.js')).href)});
    const upstream = http.createServer((req, res) => {
      assert.equal(req.url, '/api/control');
      assert.equal(req.headers['x-scranton-client'], '1');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ v: 1, enabled: true, run: null, pendingHuman: null }));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    let relay;
    try {
      const origin = 'https://relay.example.test';
      relay = await startRelay({ origin, port: 0, targetPort: upstream.address().port });
      assert.equal(new URL(relay.url).hostname, '127.0.0.1');
      function request(resource, { method = 'GET', body, cookie } = {}) {
        return new Promise((resolve, reject) => {
          const req = http.request(relay.url + resource, {
            method, headers: { Host: new URL(origin).host, Origin: origin,
              'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) }
          }, res => {
            let text = '';
            res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
          });
          req.on('error', reject); req.end(body);
        });
      }
      const page = await request('/');
      assert.equal(page.status, 200);
      assert.match(page.text, /Pair with Scranton/);
      assert.equal((await request('/_relay/session')).status, 401);
      const paired = await request('/_relay/pair', {
        method: 'POST', body: new URLSearchParams({ code: relay.code }).toString()
      });
      assert.equal(paired.status, 303);
      const setCookie = paired.headers['set-cookie']?.[0];
      assert.ok(typeof setCookie === 'string', 'Pairing must set a session cookie');
      assert.ok(setCookie.includes('Secure') && setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict'));
      const cookie = setCookie.split(';', 1)[0];
      const session = await request('/_relay/session', { cookie });
      assert.equal(session.status, 200);
      assert.equal(JSON.parse(session.text).paired, true);
      const logout = await request('/_relay/logout', { method: 'POST', body: '', cookie });
      assert.equal(logout.status, 303);
      assert.equal((await request('/_relay/session', { cookie })).status, 401);
    } finally {
      await relay?.close();
      await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
    }
    console.log('Staged relay pairing/session/logout passed offline');
  `;
  const run = spawnSync(bundledNode(), ['--input-type=module', '--eval', script], await environment(t));
  // Never include child output in a failure: session/code material must stay private.
  assert.equal(run.status, 0, 'Staged relay runtime probe failed (no credential-bearing child output retained)');
  assert.match(run.stdout, /Staged relay pairing\/session\/logout passed offline/);
});
