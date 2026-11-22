import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { stopSource } from '../../../src/core/sandbox-docker/command.js';

const scratch = path.resolve('.scratch/docker-executor/tests');
fs.mkdirSync(scratch, { recursive: true });
export function fixture(t) {
  const root = fs.mkdtempSync(path.join(scratch, 'case-'));
  const worktree = path.join(root, 'work'), tempDir = path.join(root, 'temp');
  fs.mkdirSync(worktree); fs.mkdirSync(tempDir); fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: host-only');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const runSync = (_exe, args, env) => { calls.push({ args, env }); return ['info', 'image'].includes(args[0]) ? 'linux' : args[0] === 'inspect' ? 'true' : ''; };
  const deps = { executable: 'fake-docker', runSync, run: async (...args) => runSync(...args) };
  return { root, worktree, tempDir, calls, deps };
}
export function fakeCli(t, { exitCode = 7 } = {}) {
  const f = fixture(t), script = path.join(f.root, 'docker.cjs'), log = path.join(f.root, 'calls.jsonl'), pid = path.join(f.root, 'exec.pid');
  fs.writeFileSync(script, `const fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]==='info'||args[0]==='image') console.log('linux');
if(args[0]==='inspect') console.log('true');
if(args[0]==='exec' && !args.includes(${JSON.stringify(stopSource)})) { fs.writeFileSync(${JSON.stringify(pid)},String(process.pid)); if(args.includes('hold')) setInterval(()=>{},1000); else { console.log('stdout'); console.error('stderr'); process.exitCode=${exitCode}; } }
if((args[0]==='rm' || args.includes(${JSON.stringify(stopSource)})) && fs.existsSync(${JSON.stringify(pid)})) { try { process.kill(Number(fs.readFileSync(${JSON.stringify(pid)},'utf8')),'SIGKILL'); } catch {} }
`);
  const deps = {
    executable: process.execPath,
    runSync: (_exe, args, env) => execFileSync(process.execPath, [script, ...args], { env, encoding: 'utf8' }).trim(),
    run: (_exe, args, env) => new Promise((resolve, reject) => execFile(process.execPath, [script, ...args], { env, encoding: 'utf8' }, (error, out) => error ? reject(error) : resolve(out.trim()))),
    spawn: (_exe, args, options) => spawn(process.execPath, [script, ...args], options),
  };
  return { ...f, deps, log, pid };
}
