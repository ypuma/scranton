import { spawn } from 'node:child_process';
export function child(args) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['test/core/durable/child.js', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { process.kill(); reject(new Error(`Child timed out: ${stderr}`)); }, 15000);
    process.stdout.on('data', chunk => { stdout += chunk; });
    process.stderr.on('data', chunk => { stderr += chunk; });
    process.on('error', reject);
    process.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
