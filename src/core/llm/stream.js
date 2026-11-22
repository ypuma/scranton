import { calculateCost } from './catalogue.js';
import { classifyError, protocolError } from './errors.js';

export const textContent = (content) => typeof content === 'string' ? content : (content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
export const count = (n) => Number.isSafeInteger(n) && n >= 0 ? n : 0;
export function newMessage(model) {
  return { role: 'assistant', content: [], provider: model.provider, model: model.id ?? model.model,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' };
}

export function createResultStream(model, options, produce) {
  const output = newMessage(model), controller = new AbortController();
  let started = false, settled = false, resolve;
  const result = new Promise(r => { resolve = r; });
  const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 600000)]);
  const finish = () => { if (!settled) { settled = true; calculateCost(model, output.usage); resolve(structuredClone(output)); } };
  const iterator = (async function* () {
    try {
      signal.throwIfAborted();
      yield { type: 'start', partial: structuredClone(output) };
      for await (const event of produce(output, signal)) {
        signal.throwIfAborted();
        yield structuredClone({ ...event, partial: output });
      }
      signal.throwIfAborted();
      if (!['stop', 'length', 'toolUse'].includes(output.stopReason)) throw protocolError('Invalid terminal stop reason');
      calculateCost(model, output.usage);
      yield { type: 'done', reason: output.stopReason, message: structuredClone(output) };
    } catch (error) {
      output.stopReason = options.signal?.aborted || controller.signal.aborted ? 'aborted' : 'error';
      output.error = classifyError(output.stopReason === 'aborted' ? { code: 'ABORTED' } : signal.aborted ? signal.reason : error);
      output.errorMessage = output.error.message;
      calculateCost(model, output.usage);
      yield { type: 'error', reason: output.stopReason, error: structuredClone(output) };
    } finally {
      if (!settled && !['error', 'aborted'].includes(output.stopReason) && !completed) {
        output.stopReason = 'aborted'; output.error = classifyError({ code: 'ABORTED' }); output.errorMessage = output.error.message;
      }
      controller.abort(); finish();
    }
  })();
  let completed = false;
  const wrapped = {
    async next() { started = true; const item = await iterator.next(); if (!item.done && ['done', 'error'].includes(item.value.type)) { completed = true; finish(); } return item; },
    async return() {
      controller.abort();
      if (!started) { output.stopReason = 'aborted'; output.error = classifyError({ code: 'ABORTED' }); output.errorMessage = output.error.message; }
      const value = await iterator.return(); finish(); return value;
    },
    [Symbol.asyncIterator]() { return this; },
    result() { if (!started) { started = true; void (async () => { for await (const _ of wrapped) { /* drain */ } })(); } return result; }
  };
  return wrapped;
}

export class Blocks {
  constructor(output) { this.output = output; this.open = new Map(); }
  start(key, block) {
    if (this.open.has(key)) throw protocolError();
    const index = this.output.content.push(block) - 1;
    this.open.set(key, { index, raw: '' });
    const type = block.type === 'toolCall' ? 'toolcall' : block.type;
    return { type: `${type}_start`, contentIndex: index, ...(type === 'toolcall' ? { id: block.id, toolName: block.name } : {}) };
  }
  get(key) { const state = this.open.get(key); if (!state) throw protocolError(); return this.output.content[state.index]; }
  delta(key, delta) {
    const state = this.open.get(key), block = this.get(key);
    if (typeof delta !== 'string') throw protocolError();
    const type = block.type === 'toolCall' ? 'toolcall' : block.type;
    if (type === 'toolcall') state.raw += delta;
    else block[type] += delta;
    return { type: `${type}_delta`, contentIndex: state.index, delta };
  }
  end(key) {
    const state = this.open.get(key), block = this.get(key);
    const type = block.type === 'toolCall' ? 'toolcall' : block.type;
    if (type === 'toolcall') {
      let args = block.arguments;
      if (state.raw) { try { args = JSON.parse(state.raw); } catch { throw protocolError('Invalid tool JSON'); } }
      if (!args || typeof args !== 'object' || Array.isArray(args) || !block.id || !block.name) throw protocolError('Invalid tool call');
      block.arguments = args;
      if (this.output.content.some((b, i) => i !== state.index && b.type === 'toolCall' && b.id === block.id)) throw protocolError('Duplicate tool call id');
    }
    this.open.delete(key);
    return { type: `${type}_end`, contentIndex: state.index, ...(type === 'toolcall' ? { toolCall: block } : { content: block[type] }) };
  }
  *endAll() { for (const key of this.open.keys()) yield this.end(key); }
}
