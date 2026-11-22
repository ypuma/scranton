import { setTimeout as delay } from 'node:timers/promises';
import { Blocks, count, createResultStream } from './stream.js';

export function createScriptedProvider(turns) {
  const script = structuredClone(turns), calls = [];
  let turnIndex = 0;
  const stream = (model, context, options = {}) => {
    const index = turnIndex++, turn = script[index];
    calls.push(structuredClone({ model, context }));
    return createResultStream(model, options, async function* (output, signal) {
      if (!turn) throw Object.assign(new Error('Script exhausted'), { code: 'SCRIPT_EXHAUSTED' });
      if (turn.delayMs) await delay(turn.delayMs, undefined, { signal });
      const blocks = new Blocks(output);
      const content = turn.content ?? [
        ...(turn.thinking !== undefined ? [{ type: 'thinking', thinking: turn.thinking }] : []),
        ...(turn.text !== undefined ? [{ type: 'text', text: turn.text }] : []),
        ...(turn.toolCalls ?? []).map((call, i) => ({ type: 'toolCall', ...call, id: call.id ?? `script-${index + 1}-${i}` }))
      ];
      for (const [i, block] of content.entries()) {
        signal.throwIfAborted();
        const field = block.type === 'toolCall' ? 'arguments' : block.type;
        const text = field === 'arguments' ? JSON.stringify(block.arguments) : block[field];
        yield blocks.start(i, { ...block, [field]: field === 'arguments' ? {} : '' });
        const width = Math.max(1, turn.chunkSize ?? 8);
        for (let at = 0; at < text.length; at += width) { signal.throwIfAborted(); yield blocks.delta(i, text.slice(at, at + width)); }
        yield blocks.end(i);
      }
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h']) output.usage[key] = count(turn.usage?.[key]);
      if (turn.error) throw Object.assign(new Error(turn.error.message ?? 'Scripted failure'), turn.error);
      output.stopReason = turn.stopReason ?? (output.content.some(b => b.type === 'toolCall') ? 'toolUse' : 'stop');
    });
  };
  return { stream, complete: (model, context, options) => stream(model, context, options).result(), calls };
}
