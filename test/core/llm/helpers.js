import http from 'node:http';
import { once } from 'node:events';

export const context = { systemPrompt: 'System instruction', messages: [{ role: 'user', content: 'Hello' }], tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] };
export const rates = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 };
export const model = (api, baseUrl) => ({ id: api.startsWith('google') ? 'gemini-3-pro' : 'test-model', provider: api === 'google-antigravity' ? api : 'test', api, baseUrl, contextWindow: 200000, maxTokens: 8192, reasoning: true, cost: rates });
export function sse(events) { return events.map(e => typeof e === 'string' ? `data: ${e}\n\n` : `data: ${JSON.stringify(e)}\n\n`).join(''); }
export async function server(t, handler) {
  const requests = [];
  const app = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    await handler(req, res, requests.at(-1));
  });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => { app.closeAllConnections(); return new Promise(r => app.close(r)); });
  return { url: `http://127.0.0.1:${app.address().port}`, requests };
}
export const anthropic = [
  { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Think' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call-1', name: 'Read', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"file"}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }
];
export const responses = [
  { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs-1' } },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Think' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs-1', encrypted_content: 'sig', summary: [{ type: 'summary_text', text: 'Think' }] } },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'm-1' } },
  { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'Hello' },
  { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'm-1' } },
  { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '' } },
  { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"path":' },
  { type: 'response.function_call_arguments.delta', output_index: 2, delta: '"file"}' },
  { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', arguments: '{"path":"file"}' } },
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 13, input_tokens_details: { cached_tokens: 3 }, output_tokens: 5 } } }
];
export const completions = [
  { choices: [{ delta: { reasoning_content: 'Think' } }] },
  { choices: [{ delta: { content: 'Hello', tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read', arguments: '{"path":' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"file"}' } }] }, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 13, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens: 5 } }, '[DONE]'
];
export const google = [
  { candidates: [{ content: { parts: [{ text: 'Think', thought: true, thoughtSignature: 'sig' }, { text: 'Hello' }] } }] },
  { candidates: [{ content: { parts: [{ functionCall: { id: 'call-1', name: 'read', args: { path: 'file' } }, thoughtSignature: 'call-sig' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 13, cachedContentTokenCount: 3, candidatesTokenCount: 3, thoughtsTokenCount: 2 } }
];
export const cases = [
  ['anthropic-messages', anthropic], ['openai-responses', responses], ['openai-completions', completions], ['google-generative', google], ['google-antigravity', google.map(response => ({ response }))]
];
export const authFor = (api) => api === 'google-antigravity' ? { type: 'oauth', access: 'fake-access', projectId: 'fake-project' } : { type: 'api_key', key: 'fake-key' };
