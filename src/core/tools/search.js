import fs from 'node:fs';
import { Worker, workerData } from 'node:worker_threads';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { resolveToolPath, relativePath } from './path.js';
import { globMatcher } from './glob.js';
import { launch } from './process.js';
import { limitsFor, listOutput } from './truncate.js';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const check = (ctx) => { if (ctx.signal?.aborted) throw new Error('Operation aborted'); };
const decode = (field) => field?.text ?? (field?.bytes ? Buffer.from(field.bytes, 'base64').toString('utf8') : '');

function ignoreRules(dir, base, inherited) {
  let text;
  try { text = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return inherited; throw error; }
  const rules = [...inherited];
  for (let pattern of text.split(/\r?\n/)) {
    if (!pattern || pattern.startsWith('#')) continue;
    const negated = pattern.startsWith('!');
    if (negated) pattern = pattern.slice(1);
    pattern = pattern.replace(/(?<!\\) +$/, '');
    const directory = pattern.endsWith('/');
    if (directory) pattern = pattern.slice(0, -1);
    const anchored = pattern.startsWith('/');
    if (anchored) pattern = pattern.slice(1);
    rules.push({ dir, directory, negated, match: globMatcher(pattern, { basename: !anchored }) });
  }
  return rules;
}

function walk(base, ctx, includeGlob) {
  const results = [];
  const visit = (dir, inherited) => {
    check(ctx);
    const rules = ignoreRules(dir, relativePath(base, dir), inherited);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      if (['.git', 'node_modules'].includes(entry.name.toLowerCase())) continue;
      const file = path.join(dir, entry.name), rel = relativePath(base, file);
      let ignored = false;
      for (const rule of rules) {
        const local = relativePath(rule.dir, file);
        if ((!rule.directory || entry.isDirectory()) && rule.match(local)) ignored = !rule.negated;
      }
      if (ignored && !(includeGlob && (entry.isDirectory() || includeGlob(rel))) || entry.isSymbolicLink()) continue;
      try { resolveToolPath(ctx.root, file); } catch { continue; }
      if (entry.isDirectory()) { results.push(rel + '/'); visit(file, rules); }
      else if (entry.isFile()) results.push(rel);
    }
  };
  // Inherit ignore files between the allowed root and search directory.
  let inherited = [], current = path.resolve(ctx.root);
  for (const part of path.relative(current, base).split(path.sep).filter(Boolean)) {
    inherited = ignoreRules(current, relativePath(base, current), inherited); current = path.join(current, part);
  }
  visit(base, inherited);
  return results.sort(compare);
}

async function binaryLines(binary, args, ctx, cwd, consume, codes = [0]) {
  const decoder = new StringDecoder('utf8');
  let pending = '', error = '', parseError;
  const accept = (line) => { try { consume(line); } catch (error) { parseError ??= error; } };
  const chunk = (text) => {
    pending += text;
    let end;
    while ((end = pending.indexOf('\n')) >= 0) { accept(pending.slice(0, end).replace(/\r$/, '')); pending = pending.slice(end + 1); }
  };
  const result = await launch(binary, args, ctx, { cwd, onStdout: (buffer) => chunk(decoder.write(buffer)), onStderr: (buffer) => { error = (error + buffer.toString()).slice(-8192); } });
  chunk(decoder.end()); if (pending) accept(pending);
  if (parseError) throw parseError;
  if (result.reason) throw new Error(result.reason);
  if (!codes.includes(result.code)) throw new Error(error.trim() || `Search process exited with code ${result.code}`);
}

export async function grep(args, ctx) {
  if (!ctx.binaries?.rg && workerData?.tool !== 'native-grep') return fallbackSearch(args, ctx);
  const base = resolveToolPath(ctx.root, args.path ?? '.');
  const directory = fs.statSync(base).isDirectory();
  const limit = args.limit ?? 100, context = args.context ?? 0;
  const rows = [], maxLength = limitsFor(ctx).grepMaxLineLength;
  let count = 0, lastFile, trailingEnd = 0, long = false;
  const rowCap = limitsFor(ctx).maxLines + 1;
  const emit = (file, line, text, match) => {
    const inWindow = file === lastFile && line <= trailingEnd;
    if (count >= limit && !inWindow) { if (match) count++; return; }
    const shownMatch = match && count < limit;
    if (match) count++;
    if (shownMatch) { lastFile = file; trailingEnd = line + context; }
    if (rows.length >= rowCap) return;
    text = text.replace(/\r?\n$/, '');
    if (text.length > maxLength) {
      let end = maxLength;
      if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
      text = text.slice(0, end) + '... [truncated]'; long = true;
    }
    rows.push(shownMatch ? `${file}:${line}: ${text}` : `${file}-${line}- ${text}`);
  };
  if (ctx.binaries?.rg) {
    const argv = ['--no-config', '--json', '--line-number', '--color=never', '--hidden', '--sort', 'path'];
    if (args.ignoreCase) argv.push('--ignore-case');
    if (args.literal) argv.push('--fixed-strings');
    if (args.glob) argv.push('--glob', args.glob.replace(/^(!?)(?:\.\/)+/, '$1'));
    argv.push('--iglob', '!**/.git/**', '--iglob', '!**/node_modules/**');
    if (context) argv.push('--context', String(context));
    argv.push('--', args.pattern, directory ? '.' : base);
    await binaryLines(ctx.binaries.rg, argv, ctx, directory ? base : path.dirname(base), (line) => {
      const event = JSON.parse(line);
      if (!['match', 'context'].includes(event.type)) return;
      let file;
      try { file = resolveToolPath(ctx.root, path.resolve(directory ? base : path.dirname(base), decode(event.data.path))); } catch { return; }
      emit(directory ? relativePath(base, file) : path.basename(base), event.data.line_number, decode(event.data.lines), event.type === 'match');
    }, [0, 1]);
  } else {
    const pattern = args.literal ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : args.pattern;
    const regex = new RegExp(pattern, args.ignoreCase ? 'i' : '');
    const glob = args.glob ? globMatcher(args.glob.replace(/^!/, '')) : () => true;
    const files = directory ? walk(base, ctx, args.glob && !args.glob.startsWith('!') ? glob : undefined).filter((name) => !name.endsWith('/')) : [path.basename(base)];
    for (const name of files) {
      check(ctx);
      if (args.glob?.startsWith('!') ? glob(name) : !glob(name)) continue;
      const file = directory ? resolveToolPath(ctx.root, path.join(base, name)) : base;
      const buffer = fs.readFileSync(file);
      if (buffer.subarray(0, 8192).includes(0)) continue;
      const lines = buffer.toString('utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      const matches = lines.map((line) => regex.test(line.replace(/\r$/, '')));
      for (let i = 0; i < lines.length; i++) {
        if (matches[i] || matches.slice(Math.max(0, i - context), i + context + 1).some(Boolean)) emit(name, i + 1, lines[i].replace(/\r$/, ''), matches[i]);
      }
    }
  }
  const notices = [];
  if (count > limit) notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
  if (long) notices.push(`Some lines truncated to ${maxLength} chars. Use read tool to see full lines`);
  return listOutput(rows, ctx, { limit: Number.MAX_SAFE_INTEGER, noun: 'matches', empty: 'No matches found', notices });
}

export async function find(args, ctx) {
  const base = resolveToolPath(ctx.root, args.path ?? '.');
  const matcher = globMatcher(args.pattern, { nocase: args.pattern === args.pattern.toLowerCase() });
  let entries;
  if (ctx.binaries?.fd) {
    entries = [];
    const argv = ['--color=never', '--hidden', '--exclude', '.git', '--exclude', 'node_modules', '--no-require-git', '--', '', base];
    await binaryLines(ctx.binaries.fd, argv, ctx, base, (line) => {
      if (!line) return;
      const directory = /[\\/]$/.test(line);
      let file;
      try { file = resolveToolPath(ctx.root, path.resolve(base, line)); } catch { return; }
      const relative = relativePath(base, file);
      if (matcher(relative)) entries.push(relative + (directory ? '/' : ''));
    });
  } else entries = walk(base, ctx).filter((name) => matcher(name.replace(/\/$/, '')));
  entries.sort(compare);
  return listOutput(entries, ctx, { limit: args.limit ?? 1000, noun: 'results', empty: 'No files found matching pattern' });
}

export async function ls(args, ctx) {
  const base = resolveToolPath(ctx.root, args.path ?? '.');
  const entries = fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => compare(a.name.toLowerCase(), b.name.toLowerCase()) || compare(a.name, b.name));
  const lines = entries.flatMap((entry) => {
    try { resolveToolPath(ctx.root, path.join(base, entry.name)); } catch { return []; }
    return entry.name + (entry.isDirectory() ? '/' : '');
  });
  return listOutput(lines, ctx, { limit: args.limit ?? 500, noun: 'entries', empty: '(empty directory)' });
}

function fallbackSearch(args, ctx) {
  const timeout = limitsFor(ctx).grepTimeoutMs;
  return new Promise((resolve, reject) => {
    check(ctx);
    const worker = new Worker(new URL('./search-worker.js', import.meta.url), {
      workerData: { tool: 'native-grep', args, ctx: { root: ctx.root, limits: ctx.limits } },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', abort);
      worker.terminate().then(() => error ? reject(error) : resolve(result), reject);
    };
    const abort = () => finish(new Error('Operation aborted'));
    const timer = setTimeout(() => finish(new Error(`Native grep timed out after ${timeout} ms`)), timeout);
    worker.once('message', (message) => finish(message.error ? new Error(message.error) : null, message.result));
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => finish(new Error(`Native grep worker exited with code ${code}`)));
    ctx.signal?.addEventListener('abort', abort, { once: true });
    if (ctx.signal?.aborted) abort();
  });
}
