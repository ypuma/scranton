import { count, textContent } from './stream.js';
import { protocolError, streamError, incompleteStream } from './errors.js';

const names = new Map(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'KillShell', 'NotebookEdit', 'Skill', 'Task', 'TaskOutput', 'TodoWrite', 'WebFetch', 'WebSearch'].map(n => [n.toLowerCase(), n]));
const cache_control = { type: 'ephemeral' };
export function anthropicRequest(model, context, options, auth) {
  const oauth = auth.type === 'oauth';
  const name = n => oauth ? names.get(n.toLowerCase()) ?? n : n;
  const messages = [];
  for (const message of context.messages) {
    let role, content;
    if (message.role === 'toolResult') {
      role = 'user'; content = [{ type: 'tool_result', tool_use_id: message.toolCallId, content: textContent(message.content), is_error: !!message.isError }];
    } else if (message.role === 'user') {
      role = 'user'; content = [{ type: 'text', text: textContent(message.content) }];
    } else {
      role = 'assistant'; content = message.content.flatMap(block => {
        if (block.type === 'text') return [{ type: 'text', text: block.text }];
        if (block.type === 'toolCall') return [{ type: 'tool_use', id: block.id, name: name(block.name), input: block.arguments }];
        if (block.type === 'thinking' && block.thinkingSignature && message.provider === model.provider && message.model === model.id) return [block.redacted ? { type: 'redacted_thinking', data: block.thinkingSignature } : { type: 'thinking', thinking: block.thinking, signature: block.thinkingSignature }];
        return [];
      });
    }
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content);
    else messages.push({ role, content });
  }
  if (messages.at(-1)?.content.length) messages.at(-1).content.at(-1).cache_control = cache_control;
  const body = { model: model.id, messages, max_tokens: options.maxTokens ?? model.maxTokens, stream: true };
  const system = [...(oauth ? ["You are Claude Code, Anthropic's official CLI for Claude."] : []), ...(context.systemPrompt ? [context.systemPrompt] : [])];
  if (system.length) body.system = system.map(text => ({ type: 'text', text, cache_control }));
  const thinking = model.reasoning && (options.reasoning ?? 'off') !== 'off';
  const betas = [...(oauth ? ['claude-code-20250219', 'oauth-2025-04-20'] : []), ...(context.tools?.length ? ['fine-grained-tool-streaming-2025-05-14'] : [])];
  if (model.reasoning) {
    if (thinking || model.thinkingLevelMap?.off === null) {
      if (model.adaptiveThinking) {
        body.thinking = { type: 'adaptive', display: 'summarized' };
        body.output_config = { effort: model.thinkingLevelMap?.[options.reasoning] ?? (['minimal', 'low'].includes(options.reasoning) ? 'low' : ['xhigh', 'max'].includes(options.reasoning) ? 'high' : options.reasoning ?? 'high') };
      } else {
        const budget = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 32768 }[options.reasoning] ?? 1024;
        body.thinking = { type: 'enabled', budget_tokens: Math.min(budget, body.max_tokens - 1), display: 'summarized' };
        if (body.thinking.budget_tokens < 1024) throw protocolError('Insufficient thinking token budget');
        betas.push('interleaved-thinking-2025-05-14');
      }
    } else body.thinking = { type: 'disabled' };
  }
  if (options.temperature !== undefined && !body.thinking?.type?.match(/adaptive|enabled/) && model.supportsTemperature !== false) body.temperature = options.temperature;
  if (context.tools?.length) body.tools = context.tools.map((tool, i) => ({ name: name(tool.name), description: tool.description, input_schema: tool.parameters, ...(i === context.tools.length - 1 ? { cache_control } : {}) }));
  const headers = { 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', ...(betas.length ? { 'anthropic-beta': betas.join(',') } : {}),
    ...(oauth ? { Authorization: `Bearer ${auth.access}`, 'user-agent': 'claude-cli/2.1.322', 'x-app': 'cli' } : { 'x-api-key': auth.key }) };
  return { url: `${model.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/messages`, headers, body };
}

export async function* anthropicEvents(events, blocks, output, context, env) {
  let stopped = false, reason;
  const usage = (u) => {
    for (const [key, wire] of Object.entries({ input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' })) if (u?.[wire] !== undefined) output.usage[key] = count(u[wire]);
    if (u?.cache_creation) output.usage.cacheWrite1h = count(u.cache_creation.ephemeral_1h_input_tokens);
  };
  for await (const event of events) {
    if (event.type === 'error') throw streamError(event.error, env);
    if (event.type === 'message_start') usage(event.message?.usage);
    else if (event.type === 'content_block_start') {
      const b = event.content_block;
      if (b.type === 'text') { yield blocks.start(event.index, { type: 'text', text: '' }); if (b.text) yield blocks.delta(event.index, b.text); }
      else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        yield blocks.start(event.index, { type: 'thinking', thinking: '', thinkingSignature: b.signature ?? b.data ?? '', ...(b.type === 'redacted_thinking' ? { redacted: true } : {}) });
        if (b.thinking) yield blocks.delta(event.index, b.thinking);
      } else if (b.type === 'tool_use') yield blocks.start(event.index, { type: 'toolCall', id: b.id, name: context.tools?.find(t => t.name.toLowerCase() === b.name.toLowerCase())?.name ?? b.name, arguments: b.input ?? {} });
      else throw protocolError('Unsupported content block');
    } else if (event.type === 'content_block_delta') {
      const d = event.delta;
      if (d.type === 'signature_delta') blocks.get(event.index).thinkingSignature += d.signature;
      else if (['text_delta', 'thinking_delta', 'input_json_delta'].includes(d.type)) yield blocks.delta(event.index, d.text ?? d.thinking ?? d.partial_json);
    } else if (event.type === 'content_block_stop') yield blocks.end(event.index);
    else if (event.type === 'message_delta') { usage(event.usage); reason = event.delta?.stop_reason ?? reason; }
    else if (event.type === 'message_stop') { stopped = true; break; }
  }
  if (!stopped || blocks.open.size) throw incompleteStream('Incomplete Anthropic stream');
  output.stopReason = reason === 'max_tokens' ? 'length' : reason === 'tool_use' ? 'toolUse' : ['end_turn', 'stop_sequence', 'pause_turn'].includes(reason) ? 'stop' : 'error';
  if (output.stopReason === 'error') throw protocolError('Anthropic stop reason rejected');
}
