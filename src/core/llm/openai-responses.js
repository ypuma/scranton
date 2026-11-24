import { count, textContent } from './stream.js';
import { protocolError, streamError, incompleteStream } from './errors.js';
import { isChatGPT } from './catalogue.js';

export function responsesRequest(model, context, options, auth) {
  const legacy = isChatGPT(auth);
  const input = [];
  if (context.systemPrompt && !legacy) input.push({ role: model.reasoning ? 'developer' : 'system', content: context.systemPrompt });
  for (const message of context.messages) {
    if (message.role === 'toolResult') input.push({ type: 'function_call_output', call_id: message.toolCallId, output: textContent(message.content) });
    else if (message.role === 'user') input.push({ role: 'user', content: [{ type: 'input_text', text: textContent(message.content) }] });
    else for (const block of message.content) {
      if (block.type === 'thinking' && block.providerItem && message.provider === model.provider && message.model === model.id) input.push(block.providerItem);
      else if (block.type === 'text') input.push({ role: 'assistant', content: [{ type: 'output_text', text: block.text, annotations: [] }] });
      else if (block.type === 'toolCall') input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.arguments) });
    }
  }
  const body = { model: model.id, input, stream: true, store: false };
  if (context.tools?.length) body.tools = context.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
  if (auth.type !== 'oauth') {
    body.max_output_tokens = Math.max(16, options.maxTokens ?? model.maxTokens);
    if (options.temperature !== undefined) body.temperature = options.temperature;
  }
  if (model.reasoning) {
    const level = options.reasoning ?? 'off';
    const effort = model.thinkingLevelMap?.[level] ?? (level === 'off' ? 'none' : level === 'max' ? 'xhigh' : level);
    if (model.thinkingLevelMap?.[level] !== null) body.reasoning = { effort, ...(level !== 'off' ? { summary: 'auto' } : {}) };
    if (level !== 'off') body.include = ['reasoning.encrypted_content'];
  }
  const headers = { Authorization: `Bearer ${auth.type === 'oauth' ? auth.access : auth.key}` };
  let url = `${model.baseUrl.replace(/\/$/, '')}/responses`;
  if (legacy) {
    if (!auth.accountId) throw Object.assign(protocolError(), { code: 'AUTH_REQUIRED' });
    url = `${model.baseUrl === 'https://api.openai.com/v1' ? 'https://chatgpt.com/backend-api' : model.baseUrl.replace(/\/$/, '')}/codex/responses`;
    Object.assign(headers, { 'chatgpt-account-id': auth.accountId, originator: 'scranton', 'OpenAI-Beta': 'responses=experimental' });
    Object.assign(body, { instructions: context.systemPrompt || 'You are a helpful assistant.', text: { verbosity: 'low' }, include: ['reasoning.encrypted_content'], tool_choice: 'auto', parallel_tool_calls: true });
  }
  return { url, headers, body };
}

export async function* responsesEvents(events, blocks, output, context, env) {
  let terminal = false;
  for await (const event of events) {
    const key = event.output_index;
    if (event.type === 'error' || event.type === 'response.failed') throw streamError(event.response?.error ?? event.error ?? (event.type === 'response.failed' ? {} : event), env);
    if (event.type === 'response.output_item.added') {
      const item = event.item;
      if (item.type === 'function_call') yield blocks.start(key, { type: 'toolCall', id: item.call_id, name: item.name, arguments: {} });
      else if (item.type === 'reasoning') yield blocks.start(key, { type: 'thinking', thinking: '', providerItem: item });
      else if (item.type === 'message') yield blocks.start(key, { type: 'text', text: '' });
      else throw protocolError('Unsupported Responses item');
    } else if (['response.output_text.delta', 'response.reasoning_summary_text.delta', 'response.reasoning_text.delta', 'response.function_call_arguments.delta'].includes(event.type)) yield blocks.delta(key, event.delta);
    else if (event.type === 'response.output_item.done') {
      const block = blocks.get(key), item = event.item;
      if (block.type === 'thinking') { block.providerItem = item; block.thinkingSignature = item.encrypted_content; }
      if (block.type === 'toolCall' && !blocks.open.get(key).raw && item.arguments) yield blocks.delta(key, item.arguments);
      yield blocks.end(key);
    } else if (['response.completed', 'response.incomplete', 'response.done'].includes(event.type)) {
      const response = event.response;
      if (!response || !['completed', 'incomplete'].includes(response.status ?? (event.type === 'response.completed' ? 'completed' : ''))) throw protocolError('Invalid Responses terminal status');
      for (const item of response.output ?? []) {
        if (item.type === 'reasoning' && item.encrypted_content) {
          const block = output.content.find(b => b.type === 'thinking' && b.providerItem?.id === item.id);
          if (block) { block.providerItem = item; block.thinkingSignature = item.encrypted_content; }
        }
      }
      const u = response.usage;
      if (u) { output.usage.cacheRead = count(u.input_tokens_details?.cached_tokens); output.usage.input = Math.max(0, count(u.input_tokens) - output.usage.cacheRead); output.usage.output = count(u.output_tokens); }
      if (response.status === 'incomplete' && response.incomplete_details?.reason !== 'max_output_tokens') throw protocolError('Response blocked');
      output.stopReason = response.status === 'incomplete' ? 'length' : output.content.some(b => b.type === 'toolCall') ? 'toolUse' : 'stop';
      yield* blocks.endAll(); terminal = true; break;
    }
  }
  if (!terminal) throw incompleteStream('Incomplete Responses stream');
}
