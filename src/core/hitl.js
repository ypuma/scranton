import readline from 'node:readline/promises';
import { styler } from './log.js';

export const HITL_OPTIONS = ['feedback', 'retry', 'skip', 'abort'];

const KEYS = { f: 'feedback', r: 'retry', s: 'skip', a: 'abort' };

export function isInteractive(stdin = process.stdin, stdout = process.stdout) {
  return Boolean(stdin?.isTTY && stdout?.isTTY);
}

/**
 * Terminal prompt for a human decision. Resolves `{ decision, feedback?, interrupted? }`; EOF and `signal`
 * mean "abort", Ctrl+C is "abort" with `interrupted: true` (the caller exits 130). `ctx`: { title, reason, excerpt, feedbackTarget, skipLabel }.
 */
export function createTerminalHitl({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  const c = styler(stdout, env);
  return async function ask(ctx, { signal } = {}) {
    stdout.write(`\n${c.red(c.bold(`!! ${ctx.title}`))}\n`);
    stdout.write(`   ${c.bold('Reason:')} ${ctx.reason}\n`);
    if (ctx.excerpt) {
      stdout.write(`   ${c.dim(`${ctx.excerptLabel ?? "Angela's last report"} (excerpt):`)}\n`);
      for (const line of ctx.excerpt.split(/\r?\n/)) stdout.write(`   ${c.dim('|')} ${line}\n`);
    }
    stdout.write(
      `   ${c.cyan('[f]')} feedback for ${ctx.feedbackTarget ?? 'Dwight'}   ${c.cyan('[r]')} retry   ` +
        `${c.cyan('[s]')} ${ctx.skipLabel ?? 'skip milestone'}   ${c.cyan('[a]')} abort\n`
    );
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
    // A pending rl.question() never settles when input ends, so race it against 'close'.
    const closedP = new Promise((resolve) => rl.once('close', () => resolve(null)));
    const read = async (prompt) => {
      const line = await Promise.race([rl.question(prompt, { signal }), closedP]);
      if (line === null) throw new Error('input closed');
      return line;
    };
    let interrupted = false;
    rl.once('SIGINT', () => {
      interrupted = true;
      rl.close();
    });
    const aborted = () => (interrupted ? { decision: 'abort', interrupted } : { decision: 'abort' });
    try {
      for (;;) {
        let answer;
        try {
          answer = await read('   > ');
        } catch {
          return aborted();
        }
        const decision = KEYS[answer.trim().toLowerCase()[0]] ?? null;
        if (decision === 'feedback') {
          let text = '';
          try {
            text = (await read(`   Feedback for ${ctx.feedbackTarget ?? 'Dwight'} (one line): `)).trim();
          } catch {
            return aborted();
          }
          if (text) return { decision, feedback: text };
          stdout.write('   (empty feedback - choose again)\n');
        } else if (decision) {
          return { decision };
        } else {
          stdout.write('   Please answer f, r, s or a.\n');
        }
      }
    } finally {
      rl.close();
    }
  };
}
