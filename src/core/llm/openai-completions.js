import { count, textContent } from './stream.js';
import { protocolError, streamError, incompleteStream } from './errors.js';

export function completionsRequest(model, context, options, auth) {
  if (auth.type !== 'api_key') throw Object.assign(protocolError(), { code: 'AUTH_REQUIRED' });
  const messages = context.systemPrompt ? [{ role: 'system', content: context.systemPrompt }] : [];
  for (const m of context.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: textContent(m.content) });
    else if (m.role === 'toolResult') messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: textContent(m.content) });
    else {
      const calls = m.content.filter(b => b.type === 'toolCall').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.arguments) } }));
      const thinking = m.content.filter(b => b.type === 'thinking');
      messages.push({ role: 'assistant', content: textContent(m.content) || null, ...(calls.length ? { tool_calls: calls } : {}),
        ...(thinking.length ? { reasoning_content: thinking.map(b => b.thinking).join('') } : {}) });
    }
  }
  const body = { model: model.id, messages, stream: true, stream_options: { include_usage: true },
    [model.compat?.maxTokensField ?? 'max_tokens']: options.maxTokens ?? model.maxTokens };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (model.reasoning && options.reasoning && options.reasoning !== 'off') body.reasoning_effort = model.thinkingLevelMap?.[options.reasoning] ?? (['minimal', 'low'].includes(options.reasoning) ? 'low' : ['max', 'xhigh'].includes(options.reasoning) ? 'high' : options.reasoning);
  if (context.tools?.length) body.tools = context.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  return { url: `${model.baseUrl.replace(/\/$/, '')}/chat/completions`, headers: { Authorization: `Bearer ${auth.key}` }, body };
}

export async function* completionsEvents(events, blocks, output, context, env) {
  let reason;
  for await (const event of events) {
    if (event.error) throw streamError(event.error, env);
    const u = event.usage;
    if (u) {
      output.usage.cacheRead = count(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens);
      output.usage.input = Math.max(0, count(u.prompt_tokens) - output.usage.cacheRead);
      output.usage.output = count(u.completion_tokens);
    }
    const choice = event.choices?.[0];
    if (!choice) continue;
    const d = choice.delta ?? {};
    const reasoning = d.reasoning_content ?? d.reasoning ?? d.reasoning_text;
    for (const [key, value] of [['thinking', reasoning], ['text', d.content]]) {
      if (typeof value !== 'string' || !value) continue;
      if (!blocks.open.has(key)) yield blocks.start(key, { type: key, [key]: '' });
      yield blocks.delta(key, value);
    }
    for (const call of d.tool_calls ?? []) {
      const key = `call:${call.index}`;
      if (!blocks.open.has(key)) yield blocks.start(key, { type: 'toolCall', id: call.id ?? '', name: call.function?.name ?? '', arguments: {} });
      const block = blocks.get(key);
      if (call.id) block.id = call.id;
      if (call.function?.name && !block.name) block.name = call.function.name;
      if (call.function?.arguments) yield blocks.delta(key, call.function.arguments);
    }
    if (choice.finish_reason) reason = choice.finish_reason;
  }
  if (!reason) throw incompleteStream('Missing finish_reason');
  if (!['stop', 'length', 'tool_calls', 'function_call'].includes(reason)) throw protocolError('Completion blocked');
  output.stopReason = reason === 'length' ? 'length' : ['tool_calls', 'function_call'].includes(reason) ? 'toolUse' : 'stop';
  yield* blocks.endAll();
}
