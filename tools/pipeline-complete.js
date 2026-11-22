#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyError } from '../src/core/llm/index.js';
import { createCompletionClient, completionUsage, completionError } from './completion-client.js';

export async function runPipelineCompletion(argv = process.argv.slice(2), { env = process.env, clientFactory = createCompletionClient } = {}) {
  argv = [...argv];
  const options = {};
  while (argv[0]?.startsWith('--')) {
    const key = argv.shift().slice(2);
    if (!['provider', 'model', 'thinking'].includes(key) || options[key] || !argv[0] || /^[-@]|[\x00-\x20\x7f]/.test(argv[0]) || argv[0].length > 1024) return 1;
    options[key] = argv.shift();
  }
  if (options.thinking && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(options.thinking)) return 1;
  if (argv.length !== 2 || !options.provider || !options.model) return 1;
  const [requestPath, responsePath] = argv.map((p) => path.resolve(p));
  if (requestPath === responsePath) return 1;
  let client;
  try {
    fs.rmSync(responsePath, { force: true });
    if (env.SCRANTON_PIPELINE_PI_TIMEOUT_MS !== undefined || env.SCRANTON_PI_COMMAND !== undefined) {
      process.stderr.write('Pi completion settings are no longer supported; use SCRANTON_PIPELINE_COMPLETE_TIMEOUT_MS and Scranton credentials.\n');
      return 1;
    }
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    if (request?.v !== 1 || typeof request.system !== 'string' || typeof request.user !== 'string' || !request.user.trim() ||
        request.tools !== undefined || !Number.isSafeInteger(request.max_output_tokens) || request.max_output_tokens < 1 ||
        !Number.isFinite(request.temperature)) return 1;
    const timeoutMs = Math.min(600000, Math.max(1, Number(env.SCRANTON_PIPELINE_COMPLETE_TIMEOUT_MS) || 600000));
    client = await clientFactory({ provider: options.provider, model: options.model }, undefined);
    const stream = client.llm.stream(client.model, { systemPrompt: request.system,
      messages: [{ role: 'user', content: request.user }], tools: [] },
    { maxTokens: request.max_output_tokens, temperature: request.temperature, reasoning: options.thinking, timeoutMs });
    let final;
    for await (const event of stream) {
      const message = event.message ?? event.partial ?? event.error;
      if (event.type.startsWith('toolcall_') || message?.content?.some((b) => b.type === 'toolCall')) return 1;
      if (event.type === 'error') return classifyError(message?.error ?? {}).transient ? 75 : 1;
      if (event.type === 'done') final = event.message;
    }
    if (!final || !['stop', 'length'].includes(final.stopReason)) return 1;
    const text = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (!text.trim()) return 1;
    const u = completionUsage(final.usage);
    fs.writeFileSync(responsePath, JSON.stringify({ text, usage: u ? { input_tokens: u.inputTokens, output_tokens: u.outputTokens } : null }), { mode: 0o600 });
    return 0;
  } catch (error) {
    process.stderr.write(completionError(error, env) + '\n');
    return classifyError(error).transient ? 75 : 1;
  } finally {
    try { await client?.close(); }
    catch (error) { process.stderr.write(completionError(error, env) + '\n'); return 1; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await runPipelineCompletion();
