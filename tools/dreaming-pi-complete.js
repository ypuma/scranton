#!/usr/bin/env node
import path from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { validateDreamingRequest, validateDreamingResult } from '../src/core/dreaming-completion.js';

async function createRuntime() {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const override = process.env.PI_CODING_AGENT_DIR;
  const agentDir = override ? path.resolve(override.replace(/^~(?=$|[\\/])/, homedir())) : path.join(homedir(), '.pi', 'agent');
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
  return runtime;
}

export function validateDreamingPayload(api, payload, limit) {
  const caps = api === 'anthropic-messages' ? [payload.max_tokens]
    : api === 'openai-completions' ? [payload.max_tokens, payload.max_completion_tokens].filter((v) => v !== undefined)
    : ['openai-responses', 'azure-openai-responses'].includes(api) ? [payload.max_output_tokens]
    : ['google-generative-ai', 'google-vertex'].includes(api) ? [payload.config?.maxOutputTokens]
    : api === 'bedrock-converse-stream' ? [payload.inferenceConfig?.maxTokens] : [];
  if (!caps.length || caps.some((v) => !Number.isInteger(v) || v < 1 || v > limit) ||
      [payload.tools, payload.config?.tools, payload.toolConfig?.tools].some((v) => v !== undefined && (!Array.isArray(v) || v.length))) throw Error();
}

export async function runDreamingCompletion(input, { runtimeFactory = createRuntime } = {}) {
  const request = validateDreamingRequest(input);
  // The native Antigravity stream does not invoke onPayload before sending.
  if (request.model.provider === 'google-antigravity') throw Error('Google Antigravity is unsupported for dreaming completion');
  const runtime = await runtimeFactory();
  if (runtime.getError()) throw Error();
  const model = runtime.getModel(request.model.provider, request.model.model);
  if (!model || (model.type && model.type !== 'chat')) throw Error();
  if (!['anthropic-messages', 'openai-completions', 'openai-responses', 'azure-openai-responses',
    'google-generative-ai', 'google-vertex', 'bedrock-converse-stream'].includes(model.api)) throw Error();
  // Catalog samplingParams can replace messages, tools and limits after Pi builds its request.
  const requestModel = { ...model, samplingParams: undefined, samplingParamsByThinkingLevel: undefined };
  let payloadChecked = false;
  const controller = new AbortController();
  try {
    // No AgentSession/ResourceLoader: only these two messages exist, and no tools are declared.
    const stream = runtime.streamSimple(requestModel, { systemPrompt: request.system,
      messages: [{ role: 'user', content: request.user, timestamp: Date.now() }], tools: [] },
    { maxTokens: request.maxOutputTokens, toolChoice: 'none', maxRetries: 0,
      timeoutMs: request.timeoutMs, signal: controller.signal, cacheRetention: 'none',
      onPayload: (payload) => { validateDreamingPayload(model.api, payload, request.maxOutputTokens); payloadChecked = true; } });
    let final, started = false, events = 0, bytes = 0;
    for await (const event of stream) {
      const size = Buffer.byteLength(JSON.stringify(event));
      bytes += size;
      if (++events > 16384 || size > 32768 || bytes > 8 * 1024 * 1024 || final ||
          !['start', 'text_start', 'text_delta', 'text_end', 'thinking_start', 'thinking_delta', 'thinking_end', 'done'].includes(event.type)) throw Error();
      if (event.type === 'start') {
        if (started) throw Error();
        started = true;
      } else if (!started) throw Error();
      const message = event.message ?? event.partial;
      if (!message || message.role !== 'assistant' || !Array.isArray(message.content) ||
          message.content.some((block) => !block || !['text', 'thinking'].includes(block.type) ||
            (block.type === 'text' ? typeof block.text !== 'string' : typeof block.thinking !== 'string')) ||
          message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').length > 4096) throw Error();
      if (event.type === 'done') {
        if (event.reason !== 'stop' || message.stopReason !== 'stop') throw Error();
        final = message;
      }
    }
    if (!final || !payloadChecked) throw Error();
    const text = final.content.filter((block) => block.type === 'text').map((block) => {
      if (typeof block.text !== 'string') throw Error();
      return block.text;
    }).join('\n');
    const u = final.usage;
    let usage = null;
    if (u && ['input', 'output', 'cacheRead', 'cacheWrite'].every((k) => Number.isSafeInteger(u[k]) && u[k] >= 0)) {
      const inputTokens = u.input + u.cacheRead + u.cacheWrite;
      if (inputTokens || u.output) {
        usage = { inputTokens, outputTokens: u.output };
        // Pi's default cost is catalog-derived, not an actual bill.
        if (u.cost?.totalFromProvider === true && Number.isFinite(u.cost.total) && u.cost.total >= 0) usage.costUsd = u.cost.total;
      }
    }
    return validateDreamingResult({ text, usage }, request.maxOutputTokens);
  } finally { controller.abort(); }
}

async function main() {
  try {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 65536) throw Error();
      chunks.push(chunk);
    }
    const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    const result = await runDreamingCompletion(request);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch { process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
