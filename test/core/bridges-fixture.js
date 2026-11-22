import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

export async function bridgeFixture(t, respond) {
  const base = path.resolve('.scratch/bridges'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'case-')), credentialDir = path.join(dir, 'credentials');
  fs.mkdirSync(credentialDir);
  const calls = [], sockets = new Set();
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push(body);
    if (respond) return respond(body, res, req);
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'completion' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 4 } }) + '\n\ndata: [DONE]\n\n');
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const provider = { id: 'offline', label: 'Offline', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'test', maxTokens: 8192, contextWindow: 16000 }] };
  const store = { version: 1, credentials: { offline: { type: 'api_key', key: 'offline-fixture-key' } }, providers: { offline: provider }, renewals: {}, deviceId: 'fixture', import: { at: 'fixture' } };
  fs.writeFileSync(path.join(credentialDir, 'store.json'), JSON.stringify(store));
  const env = { ...process.env, SCRANTON_CREDENTIALS_DIR: credentialDir };
  delete env.SCRANTON_PI_COMMAND; delete env.SCRANTON_PIPELINE_PI_TIMEOUT_MS; delete env.NODE_OPTIONS;
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  return { dir, credentialDir, store, env, calls };
}

export async function invokeBridge(helper, args, env, input) {
  const child = spawn(process.execPath, [path.resolve(helper), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.on('error', () => {}); child.stdin.end(input);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, stdout, stderr };
}
