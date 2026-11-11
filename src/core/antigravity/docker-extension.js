import { createProvider } from '@earendil-works/pi-ai/models';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

export function brokerStream(model, context, options = {}) {
  const stream = new AssistantMessageEventStream();
  void (async () => {
    let output = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const controller = new AbortController();
    let authFailed = false;
    try {
      const url = new URL(process.env.SCRANTON_ANTIGRAVITY_BROKER);
      if (url.protocol !== 'http:' || !['host.docker.internal', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/inference' || url.username || url.password || url.search || url.hash) throw Error();
      const selected = {};
      for (const key of ['reasoning', 'thinking', 'temperature', 'maxTokens', 'toolChoice']) if (options[key] !== undefined) selected[key] = options[key];
      const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : []), AbortSignal.timeout(10 * 60 * 1000)]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SCRANTON_ANTIGRAVITY_CAPABILITY}` }, body: JSON.stringify({ model: model.id, context: normalizeContext(context), options: selected }) });
      if (!response.ok) { authFailed = response.status === 401; await response.body?.cancel(); throw Error(); }
      let buffer = '', bytes = 0, terminal = false; const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        bytes += chunk.length; if (bytes > 64 * 1024 * 1024) throw Error();
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const event = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (terminal) throw Error();
          output = event.message ?? event.error ?? event.partial ?? output;
          if (event.block) {
            output.content[event.contentIndex] = event.block;
            delete event.block;
            if (event.type === 'toolcall_end') event.toolCall = output.content[event.contentIndex];
            else if (event.type.endsWith('_end')) event.content = output.content[event.contentIndex][event.type === 'thinking_end' ? 'thinking' : 'text'];
          }
          if (event.type === 'text_delta' || event.type === 'thinking_delta') {
            const field = event.type === 'text_delta' ? 'text' : 'thinking';
            output.content[event.contentIndex][field] += event.delta;
          }
          if (event.type === 'toolcall_delta') {
            const block = output.content[event.contentIndex];
            block.arguments = JSON.parse(event.delta);
          }
          terminal = event.type === 'done' || event.type === 'error';
          if (!terminal) event.partial = output;
          stream.push(event);
        }
      }
      if (buffer.trim() || !terminal) throw Error();
    } catch {
      output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = authFailed ? 'Google Antigravity sign-in unavailable; sign in again in Accounts before retrying Docker' : 'Google Antigravity broker unavailable';
      stream.push({ type: 'error', reason: output.stopReason, error: output });
    } finally { controller.abort(); stream.end(); }
  })();
  return stream;
}

export default function (pi) {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  pi.registerProvider(createProvider({ id: 'google-antigravity', name: 'Google Antigravity',
    auth: { apiKey: { name: 'Run capability', resolve: async ({ ctx }) => {
      const key = await ctx.env('SCRANTON_ANTIGRAVITY_CAPABILITY');
      return key ? { auth: { apiKey: key }, source: 'Run capability' } : undefined;
    } } },
    models: ['gemini-3-pro', 'gemini-3-flash'].map((id) => ({ id, name: `${id} (Antigravity)`, provider: 'google-antigravity', api: 'google-generative-ai', baseUrl: 'http://host.docker.internal', input: ['text', 'image'], reasoning: true, contextWindow: 1048576, maxTokens: 65536, cost,
      thinkingLevelMap: { minimal: 'low', low: 'low', medium: 'high', high: 'high' } })),
    api: { stream: brokerStream, streamSimple: brokerStream }
  }));
}
