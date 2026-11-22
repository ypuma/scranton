#!/usr/bin/env node
import path from 'node:path';
import { createCompletionClient, completionUsage, completionError } from './completion-client.js';
export { validateCompletionPayload as validateDreamingPayload } from './completion-client.js';
import { pathToFileURL } from 'node:url';
import { validateDreamingRequest, validateDreamingResult } from '../src/core/dreaming-completion.js';

export async function runDreamingCompletion(input, { env = process.env, clientFactory = createCompletionClient } = {}) {
  const controller = new AbortController();
  let client;
  try {
    const request = validateDreamingRequest(input);
    client = await clientFactory(request.model, request.maxOutputTokens);
    const stream = client.llm.stream(client.model, { systemPrompt: request.system,
      messages: [{ role: 'user', content: request.user }], tools: [] },
    { maxTokens: request.maxOutputTokens, timeoutMs: request.timeoutMs, signal: controller.signal });
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
    if (!final) throw Error();
    const text = final.content.filter((block) => block.type === 'text').map((block) => {
      if (typeof block.text !== 'string') throw Error();
      return block.text;
    }).join('\n');
    const usage = completionUsage(final.usage);
    if (usage && final.usage.cost?.totalFromProvider === true && Number.isFinite(final.usage.cost.total) && final.usage.cost.total >= 0) usage.costUsd = final.usage.cost.total;
    return validateDreamingResult({ text, usage }, request.maxOutputTokens);
  } catch (error) { throw new Error(completionError(error, env)); }
  finally {
    controller.abort();
    try { await client?.close(); }
    catch (error) { throw new Error(completionError(error, env)); }
  }
}

export async function main() {
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
  } catch (error) {
    if (error?.message) process.stderr.write(completionError(error) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
