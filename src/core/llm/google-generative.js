import { randomUUID } from 'node:crypto';
import { count, textContent } from './stream.js';
import { protocolError } from './errors.js';

export function googleBody(model, context, options) {
  const contents = [];
  for (const m of context.messages) {
    const sameModel = m.provider === model.provider && m.model === model.id;
    let role = m.role === 'assistant' ? 'model' : 'user';
    let parts;
    if (m.role === 'toolResult') parts = [{ functionResponse: { id: m.toolCallId, name: m.toolName, response: { [m.isError ? 'error' : 'output']: textContent(m.content) } } }];
    else if (m.role === 'user') parts = [{ text: textContent(m.content) }];
    else parts = m.content.flatMap(b => {
      if (b.type === 'toolCall') return [{ functionCall: { id: b.id, name: b.name, args: b.arguments }, ...(sameModel && b.thoughtSignature ? { thoughtSignature: b.thoughtSignature } : {}) }];
      if (b.type === 'thinking') return sameModel && b.thinkingSignature ? [{ text: b.thinking, thought: true, thoughtSignature: b.thinkingSignature }] : [];
      return [{ text: b.text, ...(sameModel && b.textSignature ? { thoughtSignature: b.textSignature } : {}) }];
    });
    if (!parts.length) continue;
    if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts);
    else contents.push({ role, parts });
  }
  const generationConfig = { maxOutputTokens: options.maxTokens ?? model.maxTokens };
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (model.reasoning) {
    const level = options.reasoning ?? 'off';
    const mapped = model.thinkingLevelMap?.[level];
    const usesLevel = /gemini-(?:3(?:\.\d+)?-(?:pro|flash)|[4-9])|gemma-?4/.test(model.id) || model.provider === 'google-antigravity';
    const effective = mapped ?? (level === 'off' ? 'low' : ['xhigh', 'max'].includes(level) ? 'high' : level);
    generationConfig.thinkingConfig = { includeThoughts: level !== 'off', ...(usesLevel ? { thinkingLevel: String(effective).toUpperCase() } : { thinkingBudget: level === 'off' ? 0 : { minimal: 128, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 24576 }[level] }) };
  }
  return { contents, generationConfig,
    ...(context.systemPrompt ? { systemInstruction: { role: 'user', parts: [{ text: context.systemPrompt }] } } : {}),
    ...(context.tools?.length ? { tools: [{ functionDeclarations: context.tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }], toolConfig: { functionCallingConfig: { mode: /gemini-[3-9]/.test(model.id) ? 'VALIDATED' : 'AUTO' } } } : {}) };
}

export function googleRequest(model, context, options, auth) {
  if (auth.type !== 'api_key') throw Object.assign(protocolError(), { code: 'AUTH_REQUIRED' });
  return { url: `${model.baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`, headers: { 'x-goog-api-key': auth.key }, body: googleBody(model, context, options) };
}

export async function* googleEvents(events, blocks, output, { envelope = false } = {}) {
  let current, serial = 0, terminal = false;
  for await (const raw of events) {
    const chunk = envelope ? raw.response : raw;
    if (raw.error || !chunk || chunk.error) throw Object.assign(protocolError(), { status: raw.error?.code ?? chunk?.error?.code });
    const candidate = chunk.candidates?.[0];
    if (chunk.promptFeedback?.blockReason) throw protocolError('Prompt blocked');
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === 'string') {
        const type = part.thought === true ? 'thinking' : 'text';
        const signatureKey = type === 'thinking' ? 'thinkingSignature' : 'textSignature';
        // A signature belongs to its part, not to a neighboring text block.
        if (current !== undefined && (blocks.get(current).type !== type || blocks.get(current)[signatureKey])) { yield blocks.end(current); current = undefined; }
        if (current === undefined) { current = serial++; yield blocks.start(current, { type, [type]: '' }); }
        if (part.thoughtSignature) blocks.get(current)[signatureKey] = part.thoughtSignature;
        yield blocks.delta(current, part.text);
      } else if (part.thoughtSignature && !part.functionCall && current !== undefined) {
        const block = blocks.get(current); block[block.type === 'thinking' ? 'thinkingSignature' : 'textSignature'] = part.thoughtSignature;
      }
      if (part.functionCall) {
        if (current !== undefined) { yield blocks.end(current); current = undefined; }
        const call = part.functionCall, key = serial++;
        yield blocks.start(key, { type: 'toolCall', id: call.id ?? `google-call-${randomUUID()}`, name: call.name, arguments: {}, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) });
        yield blocks.delta(key, JSON.stringify(call.args ?? {})); yield blocks.end(key);
      }
    }
    const u = chunk.usageMetadata;
    if (u) { output.usage.cacheRead = count(u.cachedContentTokenCount); output.usage.input = Math.max(0, count(u.promptTokenCount) - output.usage.cacheRead); output.usage.output = count(u.candidatesTokenCount) + count(u.thoughtsTokenCount); }
    if (candidate?.finishReason) {
      if (!['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) throw protocolError('Google stop reason rejected');
      output.stopReason = candidate.finishReason === 'MAX_TOKENS' ? 'length' : output.content.some(b => b.type === 'toolCall') ? 'toolUse' : 'stop';
      terminal = true;
    }
  }
  if (!terminal) throw protocolError('Incomplete Google stream');
  if (current !== undefined) yield blocks.end(current);
}
