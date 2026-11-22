import { spawn } from 'node:child_process';
import path from 'node:path';

/** Kill a child and everything it started (taskkill /T on Windows, the process group elsewhere). */
export function killTree(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null || child.signalCode != null) return resolve();
    let killer;
    const direct = () => { try { return child.kill?.('SIGKILL'); } catch {} };
    const timer = setTimeout(() => {
      if (killer) { try { killer.kill(); } catch {} direct(); }
      resolve();
    }, 1000);
    const done = () => { clearTimeout(timer); resolve(); };
    if (child.killOwnsTree === true || !child.pid) {
      Promise.resolve(direct()).then(done, done);
      return;
    }
    if (process.platform === 'win32') {
      const fallback = () => { direct(); done(); };
      try {
        killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.once('error', fallback);
        killer.once('close', code => { if (code !== 0) direct(); done(); });
      } catch { fallback(); }
      return;
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch { direct(); }
    done();
  });
}

export function helperEnv(env) {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (/^SCRANTON_(RUN_LEASE|PARENT_GUARD)$/i.test(key)) delete childEnv[key];
  }
  return childEnv;
}

