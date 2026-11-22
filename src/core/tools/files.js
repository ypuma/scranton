import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolveToolPath } from './path.js';
import { limitsFor, truncate, formatSize } from './truncate.js';

const queues = new Map();
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
const lf = (text) => text.replace(/\r\n?/g, '\n');
const aborted = (ctx) => { if (ctx.signal?.aborted) throw new Error('Operation aborted'); };

async function mutation(file, operation) {
  const key = ['win32', 'darwin'].includes(process.platform) ? file.toLowerCase() : file;
  const task = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  queues.set(key, task);
  try { return await task; } finally { if (queues.get(key) === task) queues.delete(key); }
}

function atomic(file, content, ctx, input) {
  aborted(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  resolveToolPath(ctx.root, input, { mutation: true });
  const parent = fs.realpathSync.native(path.dirname(file));
  resolveToolPath(ctx.root, parent, { mutation: true });
  const identity = fs.statSync(parent);
  const validateParent = () => {
    resolveToolPath(ctx.root, input, { mutation: true });
    const real = fs.realpathSync.native(path.dirname(file));
    const stat = fs.statSync(real);
    if (real !== parent || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error('Write parent directory changed');
  };
  const temp = path.join(parent, `${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o7777 : undefined;
    fs.writeFileSync(temp, content, { flag: 'wx', mode: mode ?? 0o666 });
    if (mode !== undefined) fs.chmodSync(temp, mode);
    for (let attempt = 0; ; attempt++) {
      try {
        aborted(ctx);
        validateParent();
        fs.renameSync(temp, path.join(parent, path.basename(file))); break;
      }
      catch (error) {
        if (attempt >= 12 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      }
    }
  } finally {
    // Do not follow a swapped parent during cleanup either.
    try { validateParent(); fs.rmSync(temp, { force: true }); } catch {}
  }
}

export async function write(args, ctx) {
  const file = resolveToolPath(ctx.root, args.path, { mutation: true });
  return mutation(file, () => {
    aborted(ctx); resolveToolPath(ctx.root, args.path, { mutation: true });
    const before = fs.existsSync(file) ? hash(fs.readFileSync(file)) : null;
    atomic(file, args.content, ctx, args.path);
    return { content: `Successfully wrote to ${args.path}`, details: { files: [{ path: file, before, after: hash(args.content) }] } };
  });
}

export async function edit(args, ctx) {
  const file = resolveToolPath(ctx.root, args.path, { mutation: true });
  return mutation(file, () => {
    aborted(ctx); resolveToolPath(ctx.root, args.path, { mutation: true });
    let buffer;
    try { buffer = fs.readFileSync(file); } catch (error) { throw new Error(`Could not edit file: ${args.path}. Error code: ${error.code}.`); }
    const raw = buffer.toString('utf8');
    const bom = raw.startsWith('\ufeff') ? '\ufeff' : '';
    const original = raw.slice(bom.length), base = lf(original);
    if (!args.edits.length) throw new Error('Edit tool input is invalid. edits must contain at least one replacement.');
    const replacements = args.edits.map(({ oldText, newText }, editIndex) => {
      const old = lf(oldText);
      const multiple = args.edits.length > 1;
      if (!old) throw new Error(`${multiple ? `edits[${editIndex}].oldText` : 'oldText'} must not be empty in ${args.path}.`);
      const start = base.indexOf(old);
      if (start < 0) throw new Error(multiple ? `Could not find edits[${editIndex}] in ${args.path}. The oldText must match exactly including all whitespace and newlines.` : `Could not find the exact text in ${args.path}. The old text must match exactly including all whitespace and newlines.`);
      let occurrences = 0;
      for (let at = base.indexOf(old); at >= 0; at = base.indexOf(old, at + 1)) occurrences++;
      if (occurrences > 1) throw new Error(multiple ? `Found ${occurrences} occurrences of edits[${editIndex}] in ${args.path}. Each oldText must be unique. Please provide more context to make it unique.` : `Found ${occurrences} occurrences of the text in ${args.path}. The text must be unique. Please provide more context to make it unique.`);
      return { start, end: start + old.length, text: lf(newText), editIndex };
    }).sort((a, b) => a.start - b.start);
    for (let i = 1; i < replacements.length; i++) {
      const prev = replacements[i - 1], curr = replacements[i];
      if (prev.end > curr.start) throw new Error(`edits[${prev.editIndex}] and edits[${curr.editIndex}] overlap in ${args.path}. Merge them into one edit or target disjoint regions.`);
    }
    // Map normalized character boundaries back to the original bytes' decoded text.
    const positions = [];
    for (let i = 0; i < original.length; i++) { positions.push(i); if (original[i] === '\r' && original[i + 1] === '\n') i++; }
    positions.push(original.length);
    let result = original;
    for (const item of [...replacements].reverse()) {
      const start = positions[item.start], end = positions[item.end];
      const lineEnd = /\r\n|\r|\n/.exec(original.slice(start))?.[0] ?? /\r\n|\r|\n/.exec(original)?.[0] ?? '\n';
      result = result.slice(0, start) + item.text.replaceAll('\n', lineEnd) + result.slice(end);
    }
    const content = bom + result;
    if (content === raw) throw new Error(args.edits.length > 1 ? `No changes made to ${args.path}. The replacements produced identical content.` : `No changes made to ${args.path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`);
    atomic(file, content, ctx, args.path);
    return { content: `Successfully replaced ${args.edits.length} block(s) in ${args.path}.`, details: { files: [{ path: file, before: hash(buffer), after: hash(content) }] } };
  });
}

export async function read(args, ctx) {
  const file = resolveToolPath(ctx.root, args.path);
  const buffer = await fs.promises.readFile(file, { signal: ctx.signal });
  const header = buffer.subarray(0, 8192);
  if (/\.(?:png|jpe?g|gif|webp|bmp|ico|avif|tiff?)$/i.test(file) || header.subarray(0, 3).equals(Buffer.from([255, 216, 255])) || header.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])) || /^GIF8|^RIFF.{4}WEBP/s.test(header.toString('latin1'))) throw new Error('Images are not supported by the read tool');
  if (header.length >= 26 && header.toString('ascii', 0, 2) === 'BM' && [12, 40, 52, 56, 64, 108, 124].includes(header.readUInt32LE(14))) throw new Error('Images are not supported by the read tool');
  if (header.includes(0)) throw new Error('Binary files are not supported by the read tool (NUL in first 8 KB)');
  const lines = buffer.toString('utf8').replace(/^\ufeff/, '').split('\n');
  const offset = args.offset ?? 1;
  if (offset > lines.length) throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
  const selected = lines.slice(offset - 1, args.limit === undefined ? undefined : offset - 1 + args.limit);
  const truncation = truncate(selected.join('\n'), limitsFor(ctx, true));
  let content = truncation.content;
  const end = offset - 1 + truncation.outputLines;
  if (truncation.truncated && !truncation.outputLines) content = `[Line ${offset} exceeds ${formatSize(truncation.maxBytes)} limit. Use a shell command to select a smaller part of this line.]`;
  else if (truncation.truncated) content += `\n\n[Showing lines ${offset}-${end} of ${lines.length}${truncation.totalBytes > truncation.maxBytes ? ` (${formatSize(truncation.maxBytes)} limit)` : ''}. Use offset=${end + 1} to continue.]`;
  else if (args.limit !== undefined && offset - 1 + selected.length < lines.length) content += `\n\n[${lines.length - (offset - 1 + selected.length)} more lines in file. Use offset=${offset + selected.length} to continue.]`;
  return { content, details: { truncation } };
}
