import { stripVTControlCharacters } from 'node:util';
import { formatDuration } from './util.js';

const CODES = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36 };

/** ANSI styling that respects NO_COLOR, FORCE_COLOR and non-TTY streams. */
export function styler(stream = process.stdout, env = process.env) {
  const on = env.NO_COLOR === undefined && env.TERM !== 'dumb' && (Boolean(stream?.isTTY) || Boolean(env.FORCE_COLOR));
  return Object.fromEntries(Object.entries(CODES).map(([name, code]) => [name, (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s))]));
}

const NAMES = { michael: 'Michael', dwight: 'Dwight', oscar: 'Oscar', hank: 'Hank', angela: 'Angela', human: 'Human' };
const label = (id) => NAMES[id] ?? id;
const AGENT_COLOR = { michael: 'magenta', dwight: 'blue', angela: 'green', human: 'yellow' };

const two = (n) => String(n).padStart(2, '0');

/** Local HH:MM:SS of an ISO timestamp (the dashboards show local time too). */
function localClock(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts).slice(11, 19) : `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** Live, readable log of a run. Returns an event listener `(event) => void`. */
export function createTerminalLog({ stream = process.stdout, env = process.env, verbose = true, ascii = false } = {}) {
  const c = styler(stream, env);
  let customNames = {};
  const roleLabel = (id) => customNames[id] ?? label(id);
  const who = (id) => c[AGENT_COLOR[id] ?? 'bold'](roleLabel(id).padEnd(7));
  const print = (event, text) => {
    const time = localClock(event.ts);
    stream.write(`${c.dim(time)} ${text}\n`);
  };

  return (e) => {
    switch (e.type) {
      case 'run_started':
        customNames = Object.fromEntries((e.roles ?? []).filter((r) => r.builtin === false).map((r) => [r.id, String(r.name).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '')]));
        print(e, c.bold(`Run ${e.runId} started`));
        print(e, `  request:   ${e.request}`);
        print(e, `  workspace: ${e.workspace}`);
        break;
      case 'plan_ready':
        print(e, c.bold(`Plan: ${e.milestones.length} milestone${e.milestones.length === 1 ? '' : 's'}`));
        for (const m of e.milestones) print(e, `  ${m.id}  ${m.title}`);
        break;
      case 'milestone_started':
        print(e, c.bold(c.cyan(`== Milestone ${e.index + 1}/${e.total} (${e.milestoneId}): ${e.title}`)));
        break;
      case 'hive_write':
        print(e, `${c.dim('mail')}    ${roleLabel(e.from)} -> ${roleLabel(e.to)}  [${e.kind}] ${c.dim(e.summary)}`);
        break;
      case 'agent_status':
        if (e.status === 'blocked' || e.status === 'error') print(e, `${who(e.agent)} ${c.yellow(e.status)}  ${e.activity}`);
        break;
      case 'agent_finished': {
        const usage = e.usage ? `, ${e.usage.input}+${e.usage.output} tokens` : '';
        const ok = e.exitCode === 0;
        print(e, `${who(e.agent)} ${ok ? c.green('finished') : c.red(`exit ${e.exitCode}`)} ${e.keyword ? c.bold(`[${e.keyword}]`) : c.dim('(no keyword)')} ${c.dim(`${formatDuration(e.durationMs)}${usage}`)}`);
        break;
      }
      case 'cycle_result':
        print(e, `${e.result === 'passed' ? c.green('PASS') : c.red('FAIL')}    ${e.milestoneId} cycle ${e.cycle}: ${e.reason}${e.result === 'failed' ? c.dim(` (${e.failedCycles} failed in a row)`) : ''}`);
        break;
      case 'progress_check':
        print(e, `${e.milestoneId} cycle ${e.cycle}: ${e.verdict} (${e.source}${e.rule ? ':' + e.rule : ''}) - ${e.reason}; stalled ${e.stalledCycles}/${e.maxStalledCycles}; ${e.tokens}/${e.tokenBudget || 'off'} tokens`);
        break;
      case 'circuit_breaker':
        print(e, e.state === 'tripped'
          ? c.red(c.bold(`CIRCUIT BREAKER tripped on ${e.milestoneId}: ${e.cause ?? 'limit'}; ${e.failedCycles}/${e.maxFailedCycles} failed cycles`))
          : c.yellow(`circuit breaker reset on ${e.milestoneId}`));
        break;
      case 'hitl_request':
        print(e, c.yellow(`Human needed: ${e.reason.split('\n')[0]}`));
        break;
      case 'hitl_response':
        print(e, c.yellow(`Human decided: ${e.decision}${e.feedback ? ` - "${e.feedback}"` : ''}`));
        break;
      case 'milestone_finished':
        print(e, c.bold(`${e.milestoneId} ${e.status}`));
        break;
      case 'agent_message':
        print(e, `${who(e.agent)} ${stripVTControlCharacters(e.text).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/[\x00-\x1f\x7f-\x9f\ufe0e\ufe0f\u2028\u2029]+/g, ' ').slice(0, 140)}`);
        break;
      case 'run_reply':
        stream.write(`\n${ascii ? '--' : '──'} Reply (${e.kind}) ${ascii ? '--' : '──'}\n${stripVTControlCharacters(e.text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufe0e\ufe0f]/g, '')}\n\n`);
        break;
      case 'run_finished':
        print(e, c.bold(e.status === 'success' ? c.green(`Run finished: ${e.status}`) : c.yellow(`Run finished: ${e.status}`)) + ` - ${e.summary}`);
        break;
      case 'access_request':
        print(e, `Access requested: ${e.instanceId} ${e.mode} ${e.path}${e.protected ? ' (protected: ' + e.protected + ')' : ''}`);
        break;
      case 'access_decision':
        print(e, `Access ${e.decision}: ${e.instanceId} ${e.mode} ${e.path} (${e.by})`);
        break;
      case 'outside_write':
        print(e, `Outside write: ${e.instanceId} ${e.path} (not covered by undo)`);
        break;
      case 'log': {
        const tint = e.level === 'error' ? c.red : e.level === 'warn' ? c.yellow : c.dim;
        print(e, tint(`${e.level}: ${e.message}`));
        break;
      }
      case 'agent_tool':
        if (verbose) print(e, `${who(e.agent)} ${c.dim(`${e.tool} ${e.detail}`)}`);
        break;
      default:
        break;
    }
  };
}
