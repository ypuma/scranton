import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCredentials } from '../../../src/core/credentials/index.js';

export function fixture(t) {
  const root = path.resolve('.scratch/credentials-tests'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'case-')), source = path.join(dir, 'legacy'), target = path.join(dir, 'scranton');
  fs.mkdirSync(source);
  const env = { PI_CODING_AGENT_DIR: source, SCRANTON_CREDENTIALS_DIR: target };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, source, target, env, create: (options = {}) => createCredentials({ env, ...options }) };
}
export async function server(t, handler) {
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    try { await handler(req, res, body); } catch { res.writeHead(500); res.end('Fake endpoint failure'); }
  });
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}
export function json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
export const jwt = (id = 'fake-account') => `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: id } })).toString('base64url')}.signature`;
export async function callbackPort() {
  const srv = http.createServer(); srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  const port = srv.address().port; await new Promise((resolve) => srv.close(resolve)); return port;
}
export function child(args) {
  const process = spawn(globalThis.process.execPath, ['test/core/credentials/worker.js', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  process.stdout.on('data', (c) => { stdout += c; }); process.stderr.on('data', (c) => { stderr += c; });
  return new Promise((resolve, reject) => { process.on('error', reject); process.on('exit', (code) => code === 0 ? resolve(stdout) : reject(Error(`Worker failed: ${stderr}`))); });
}
