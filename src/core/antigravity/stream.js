import { randomUUID, createHash } from 'node:crypto';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { collapseSystemMessages, getCurrentTools, getCurrentSystemPrompt } from '@earendil-works/pi-ai/utils/transcript';
import { convertMessages, convertTools, mapStopReasonString, retainThoughtSignature } from '@earendil-works/pi-ai/api/google-shared';

function thinkingLevel(model, options) {
  const level = options.reasoning ?? (options.thinking?.enabled ? options.thinking.level : 'off');
  return level === 'off' ? 'low' : model.thinkingLevelMap?.[level] ?? (['minimal', 'low'].includes(level) ? 'low' : 'high');
}

export function buildRequest(model, context, options = {}) {
  const normalized = collapseSystemMessages(context), tools = getCurrentTools(normalized.messages);
  const system = getCurrentSystemPrompt(normalized.messages);
  const generationConfig = { maxOutputTokens: options.maxTokens ?? model.maxTokens };
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (model.reasoning) {
    const level = options.reasoning ?? (options.thinking?.enabled ? options.thinking.level : 'off');
    generationConfig.thinkingConfig = { includeThoughts: level !== 'off', thinkingLevel: thinkingLevel(model, options).toUpperCase() };
  }
  return { contents: convertMessages(model, normalized), generationConfig,
    ...(system ? { systemInstruction: { role: 'user', parts: [{ text: system }] } } : {}),
    ...(tools.length ? { tools: convertTools(tools), toolConfig: { functionCallingConfig: { mode: options.toolChoice === 'none' ? 'NONE' : options.toolChoice === 'any' ? 'ANY' : 'VALIDATED' } } } : {}) };
}

async function* events(body) {
  if (!body) throw Error();
  const decoder = new TextDecoder(); let buffer = '', total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > 32 * 1024 * 1024) throw Error();
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    if (buffer.length > 2 * 1024 * 1024) throw Error();
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const record = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const data = record.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
  }
  if (buffer.trim()) throw Error();
}

export function createStream({ fetcher, endpoint, userAgent }) {
  return (model, context, options = {}) => {
    const stream = new AssistantMessageEventStream();
    const output = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'pending', timestamp: Date.now() };
    void (async () => {
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : []), AbortSignal.timeout(10 * 60 * 1000)]);
      try {
        signal.throwIfAborted();
        const auth = JSON.parse(options.apiKey);
        if (typeof auth.token !== 'string' || !auth.token || /[\x00-\x20\x7f]/.test(auth.token) ||
            typeof auth.projectId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/.test(auth.projectId)) throw Error();
        const response = await fetcher(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
          method: 'POST', redirect: 'error', signal,
          headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream', 'User-Agent': userAgent },
          body: JSON.stringify({ project: auth.projectId, model: model.id === 'gemini-3-pro' ? `gemini-3-pro-${thinkingLevel(model, options)}` : model.id, requestType: 'agent', userAgent: 'antigravity', requestId: `agent-${randomUUID()}`,
            request: { ...buildRequest(model, context, options), sessionId: `scranton-${createHash('sha256').update(JSON.stringify(context.messages.find((m) => m.role === 'user') ?? randomUUID())).digest('hex').slice(0, 32)}` } })
        });
        if (!response.ok) { await response.body?.cancel(); throw Object.assign(Error(), { status: response.status }); }
        stream.push({ type: 'start', partial: output });
        let currentBlock;
        const endBlock = () => {
          if (!currentBlock) return;
          const type = currentBlock.type, field = type === 'thinking' ? 'thinking' : 'text';
          stream.push({ type: `${type}_end`, contentIndex: output.content.length - 1, content: currentBlock[field], partial: output });
          currentBlock = undefined;
        };
        for await (const envelope of events(response.body)) {
          signal.throwIfAborted();
          if (envelope.error) throw Error();
          const chunk = envelope.response;
          if (!chunk || chunk.error) throw Error();
          const candidate = chunk.candidates?.[0];
          for (const part of candidate?.content?.parts ?? []) {
            if (typeof part.text === 'string') {
              const thinking = part.thought === true, type = thinking ? 'thinking' : 'text', field = thinking ? 'thinking' : 'text';
              if (currentBlock?.type !== type) {
                endBlock(); currentBlock = { type, [field]: '' }; output.content.push(currentBlock);
                stream.push({ type: `${type}_start`, contentIndex: output.content.length - 1, partial: output });
              }
              currentBlock[field] += part.text;
              const signature = thinking ? 'thinkingSignature' : 'textSignature';
              currentBlock[signature] = retainThoughtSignature(currentBlock[signature], part.thoughtSignature);
              stream.push({ type: `${type}_delta`, contentIndex: output.content.length - 1, delta: part.text, partial: output });
            }
            if (part.functionCall) {
              endBlock();
              const call = part.functionCall;
              if (typeof call.name !== 'string' || !call.name || (call.args !== undefined && (call.args === null || typeof call.args !== 'object' || Array.isArray(call.args)))) throw Error();
              const toolCall = { type: 'toolCall', id: typeof call.id === 'string' && call.id && !output.content.some((b) => b.type === 'toolCall' && b.id === call.id) ? call.id : randomUUID(), name: call.name, arguments: {}, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) };
              const index = output.content.length;
              output.content.push(toolCall); stream.push({ type: 'toolcall_start', contentIndex: index, partial: output });
              toolCall.arguments = call.args ?? {};
              stream.push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(toolCall.arguments), partial: output });
              stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: output });
            }
          }
          if (candidate?.finishReason) { output.rawStopReason = candidate.finishReason; output.stopReason = mapStopReasonString(candidate.finishReason); }
          const usage = chunk.usageMetadata;
          if (usage) {
            const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
            output.usage.input = Math.max(0, count(usage.promptTokenCount) - count(usage.cachedContentTokenCount));
            output.usage.output = count(usage.candidatesTokenCount) + count(usage.thoughtsTokenCount);
            output.usage.cacheRead = count(usage.cachedContentTokenCount); output.usage.totalTokens = count(usage.totalTokenCount);
          }
        }
        endBlock();
        signal.throwIfAborted();
        if (['pending', 'error', 'aborted'].includes(output.stopReason)) throw Error();
        if (output.stopReason === 'stop' && output.content.some((b) => b.type === 'toolCall')) output.stopReason = 'toolUse';
        stream.push({ type: 'done', reason: output.stopReason, message: output });
      } catch (error) {
        output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
        output.errorMessage = output.stopReason === 'aborted' ? 'Google Antigravity request cancelled' : [401, 403].includes(error.status) ? 'Google Antigravity account access rejected; sign in again in Accounts and check account access before retrying' : `Google Antigravity request failed${Number.isInteger(error.status) ? ` (HTTP ${error.status})` : ''}; check account access, quota and sign-in`;
        stream.push({ type: 'error', reason: output.stopReason, error: output });
      } finally { controller.abort(); stream.end(); }
    })();
    return stream;
  };
}
