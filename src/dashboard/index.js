import path from 'node:path';
import { renderDashboard } from './render.js';
import { createHiveSource } from './source.js';
import { visibleWidth } from './text.js';

export { renderDashboard } from './render.js';
export { createHiveSource } from './source.js';

const ENTER = '\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H';
const LEAVE = '\x1b[?2026l\x1b[0m\x1b[?25h\x1b[?1049l';
const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
const TICK_MS = 120;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function useColor(stdout, env = process.env) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  return Boolean(stdout.isTTY) && env.TERM !== 'dumb';
}

function write(stdout, text) {
  return new Promise((resolve) => {
    if (stdout.write(text) !== false || typeof stdout.once !== 'function') resolve();
    else stdout.once('drain', resolve);
  });
}

export async function runDashboard({
  hiveDir = 'hive', once = false, ascii = false, refreshMs = 250, stdout = process.stdout, stdin = process.stdin,
} = {}) {
  const dir = path.resolve(hiveDir);
  const source = createHiveSource(dir);
  const color = useColor(stdout);
  const frame = () => renderDashboard(source.state, source.events, {
    width: stdout.columns || 80, height: stdout.rows || 24, color, ascii, hiveDir: dir,
  });

  await source.poll();
  if (once || !stdout.isTTY) {
    await write(stdout, frame() + '\n');
    return;
  }
  await runLive({ source, frame, stdout, stdin, refreshMs });
}

function runLive({ source, frame, stdout, stdin, refreshMs }) {
  return new Promise((resolve, reject) => {
    let shown = null;
    let polling = false;
    let finished = false;
    let raw = false;
    let pollTimer = null;
    let tickTimer = null;

    // Only lines that differ from the previous frame are rewritten, each in place,
    // so the screen never blanks between frames.
    const draw = () => {
      if (finished) return;
      const lines = frame().split('\n');
      const columns = stdout.columns || 80;
      const rows = stdout.rows || 24;
      let out = '';
      lines.forEach((line, i) => {
        if (shown && shown[i] === line) return;
        // EL right after a full-width line would erase its last cell on some terminals.
        out += `\x1b[${i + 1};1H${line}${visibleWidth(line) < columns ? '\x1b[K' : ''}`;
      });
      if (lines.length < rows && (!shown || lines.length < shown.length)) out += `\x1b[${lines.length + 1};1H\x1b[J`;
      shown = lines;
      if (out) stdout.write(SYNC_BEGIN + out + SYNC_END);
    };

    const restore = () => {
      clearInterval(pollTimer);
      clearInterval(tickTimer);
      stdout.off?.('resize', onResize);
      for (const sig of SIGNALS) process.off(sig, stop);
      process.off('uncaughtException', onFatal);
      process.off('exit', restore);
      if (raw) {
        stdin.off('data', onKey);
        try {
          stdin.setRawMode(false);
        } catch {
          // stdin already closed
        }
        stdin.pause();
        raw = false;
      }
      if (!finished) {
        finished = true;
        stdout.write(LEAVE);
      }
    };

    function stop() {
      if (finished) return;
      restore();
      resolve();
    }

    function fail(err) {
      if (finished) return;
      restore();
      reject(err);
    }

    function onFatal(err) {
      restore();
      process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
      process.exit(1);
    }

    function onResize() {
      shown = null;
      stdout.write('\x1b[2J');
      draw();
    }

    function onKey(data) {
      const key = String(data);
      if (key === 'q' || key === 'Q' || key.includes('\x03')) stop();
    }

    const poll = async () => {
      if (polling || finished) return;
      polling = true;
      try {
        if (await source.poll()) draw();
      } catch (err) {
        fail(err);
      } finally {
        polling = false;
      }
    };

    const tick = () => {
      try {
        draw();
      } catch (err) {
        fail(err);
      }
    };

    try {
      stdout.write(ENTER);
      for (const sig of SIGNALS) process.on(sig, stop);
      process.on('uncaughtException', onFatal);
      process.on('exit', restore);
      stdout.on?.('resize', onResize);
      if (stdin && stdin.isTTY && typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(true);
        raw = true;
        stdin.on('data', onKey);
        stdin.resume();
      }
      draw();
      pollTimer = setInterval(poll, Math.max(20, refreshMs));
      tickTimer = setInterval(tick, TICK_MS);
    } catch (err) {
      fail(err);
    }
  });
}
