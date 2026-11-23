import { toolDefinitions, validate } from './schema.js';
import { read, write, edit } from './files.js';
import { grep, find, ls } from './search.js';
import { shell } from './process.js';
import { resolveToolPath } from './path.js';
import { resolveBinaries } from './binaries.js';

export { toolDefinitions } from './schema.js';

export async function runTool(name, args, ctx = {}) {
  const idempotency = ['write', 'edit'].includes(name) ? 'guarded' : ['bash', 'powershell', 'agent_chat'].includes(name) ? 'at-most-once' : 'pure';
  try {
    if (!Array.isArray(ctx.allow) || !ctx.allow.includes(name) && name !== 'request_access') throw new Error(`Tool "${name}" is not allowed`);
    const definition = toolDefinitions([name])[0];
    if (!definition) throw new Error(`Unknown tool: ${name}`);
    if (name === 'edit' && args && typeof args === 'object' && !Array.isArray(args) && !Object.hasOwn(args, 'edits') && Object.hasOwn(args, 'oldText') && Object.hasOwn(args, 'newText')) {
      const { oldText, newText, ...rest } = args;
      args = { ...rest, edits: [{ oldText, newText }] };
    }
    validate(definition.parameters, args);
    if (ctx.signal?.aborted) throw new Error('Operation aborted');
    resolveToolPath(ctx.root);
    if (ctx.binaries === undefined) ctx = { ...ctx, binaries: resolveBinaries(ctx.env) };
    let result;
    if (name === 'request_access') {
      if (typeof ctx.requestAccess !== 'function') throw Error('Access requests are unavailable');
      result = await ctx.requestAccess(args);
    } else if (name === 'bash' || name === 'powershell') result = await shell(name, args, ctx);
    else if (name === 'agent_chat') {
      if (!args.text.trim()) throw new Error('arguments.text must contain non-whitespace text');
      if (typeof ctx.chat !== 'function') throw new Error('Agent chat is unavailable');
      const ack = await ctx.chat({ to: args.to, text: args.text });
      result = { content: JSON.stringify(ack), isError: ack?.ok === false, details: { ack } };
      if (typeof result.content !== 'string') throw new Error('Agent chat returned no acknowledgement');
    } else result = await ({ read, write, edit, grep, find, ls })[name](args, ctx);
    return { content: result.content, isError: result.isError ?? false, details: { ...result.details, idempotency } };
  } catch (error) {
    return { content: error?.message ?? String(error), isError: true, details: { idempotency } };
  }
}
