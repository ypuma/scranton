import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const failure = (status, message) => Object.assign(new Error(message), { status });
const apis = ['openai-completions', 'openai-responses', 'anthropic-messages'];
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const builtinCatalog = builtinProviders();
export const PROVIDER_ENV_NAMES = Object.freeze({
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'], openai: ['OPENAI_API_KEY'], google: ['GEMINI_API_KEY'],
  'ant-ling': ['ANT_LING_API_KEY'], azure: ['AZURE_OPENAI_API_KEY'], baseten: ['BASETEN_API_KEY'], cerebras: ['CEREBRAS_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'], fireworks: ['FIREWORKS_API_KEY'], 'github-copilot': ['COPILOT_GITHUB_TOKEN'], groq: ['GROQ_API_KEY'],
  huggingface: ['HF_TOKEN'], 'kimi-coding': ['KIMI_API_KEY'], meta: ['META_API_KEY'], minimax: ['MINIMAX_API_KEY'], 'minimax-cn': ['MINIMAX_CN_API_KEY'],
  mistral: ['MISTRAL_API_KEY'], moonshotai: ['MOONSHOT_API_KEY'], 'moonshotai-cn': ['MOONSHOT_API_KEY'], nvidia: ['NVIDIA_API_KEY'],
  opencode: ['OPENCODE_API_KEY'], 'opencode-go': ['OPENCODE_API_KEY'], openrouter: ['OPENROUTER_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'], 'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'], 'qwen-token-plan-individual': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-individual-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'],
  radius: ['RADIUS_API_KEY'], together: ['TOGETHER_API_KEY'], typesafe: ['TYPESAFE_API_KEY'], 'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'], xai: ['XAI_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'], 'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'], 'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'], zai: ['ZAI_API_KEY'], 'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY'], 'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY'], 'amazon-bedrock': ['AWS_BEARER_TOKEN_BEDROCK']
});
export function validateKey(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.trim() || /\s/.test(value.trim()) || /^[!$]/.test(value.trim()) || /[\x00-\x1f\x7f]/.test(value)) throw failure(400, 'API key must contain 1 to 4096 non-whitespace characters');
  return value.trim();
}
export function validateBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw failure(400, 'Invalid provider base URL'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw failure(400, 'Provider URL requires HTTPS (HTTP only on loopback), without credentials, query or fragment');
  return url.href.replace(/\/+$/, '');
}
export function validateProvider(value) {
  if (!object(value) || Object.keys(value).some((k) => !['id', 'label', 'baseUrl', 'api', 'models'].includes(k)) || typeof value.id !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(value.id) || (value.id === 'google-antigravity' || builtinCatalog.some((p) => p.id === value.id))) throw failure(400, 'Invalid or built-in provider ID');
  if (!apis.includes(value.api)) throw failure(400, 'Unsupported provider API');
  const label = value.label ?? value.id;
  if (typeof label !== 'string' || !label.trim() || label.length > 120 || /[\x00-\x1f\x7f]/.test(label)) throw failure(400, 'Invalid provider label');
  if (!Array.isArray(value.models) || !value.models.length || value.models.length > 256) throw failure(400, 'Declare 1 to 256 models');
  const ids = new Set();
  const models = value.models.map((m) => {
    if (!object(m) || Object.keys(m).some((k) => !['id', 'contextWindow', 'maxTokens', 'reasoning', 'input'].includes(k)) || typeof m.id !== 'string' || !m.id.trim() || m.id.length > 256 || /[\s\x00-\x1f\x7f]/.test(m.id) || ids.has(m.id)) throw failure(400, 'Invalid or duplicate model');
    ids.add(m.id);
    for (const k of ['contextWindow', 'maxTokens']) if (m[k] !== undefined && (!Number.isSafeInteger(m[k]) || m[k] <= 0)) throw failure(400, 'Invalid model token limit');
    if (m.reasoning !== undefined && typeof m.reasoning !== 'boolean') throw failure(400, 'Invalid reasoning flag');
    if (m.input !== undefined && (!Array.isArray(m.input) || !m.input.length || m.input.some((v) => !['text', 'image'].includes(v)))) throw failure(400, 'Invalid model input');
    return { ...m };
  });
  return { name: label.trim(), baseUrl: validateBaseUrl(value.baseUrl), api: value.api, authHeader: true, models };
}
// Match Pi 1.5's unexported utils/json.js parser, including trailing commas.
function stripComments(input) {
  return input.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => m[0] === '"' ? m : '');
}
function readJson(file, fallback, writable = false) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const stripped = stripComments(text);
    if (writable && text !== stripped) throw failure(409, 'Provider configuration contains comments; refusing to rewrite or drop comments');
    const v = JSON.parse(writable ? text : stripped.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : '')));
    if (!object(v)) throw Error();
    return v;
  } catch (e) { if (e.code === 'ENOENT') return fallback; if (e.status) throw e; throw failure(409, 'Cannot read provider configuration; refusing to overwrite'); }
}
function atomic(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
export function createProviderStore(agentDir) {
  const modelsPath = path.join(agentDir, 'models.json'), registryPath = path.join(agentDir, 'scranton-providers.json');
  const lock = path.join(agentDir, 'models.json.scranton-lock');
  let detail;
  function read(writable = false) {
    const models = readJson(modelsPath, { providers: {} }, writable), registry = readJson(registryPath, {}, writable);
    if (!object(models.providers) || Object.values(registry).some((v) => typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))) throw failure(409, 'Invalid provider configuration; refusing to overwrite');
    return { models, registry };
  }
  async function exclusive(fn) {
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 10000;
    for (;;) {
      try { fs.mkdirSync(lock); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // Old Scranton locks were empty directories; new locks identify their owner.
        let stale = false, owned = false;
        try {
          const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
          owned = true;
          if (Number.isSafeInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); } catch (error) { stale = error.code === 'ESRCH'; }
          }
        } catch {
          try { stale = Date.now() - fs.statSync(lock).mtimeMs > 30000; } catch {}
        }
        if (stale && !owned) {
          // Atomic empty-directory removal cannot delete a new writer's populated lock.
          try { fs.rmdirSync(lock); continue; } catch (error) { if (error.code === 'ENOENT') continue; }
        }
        if (stale || Date.now() >= deadline) throw failure(409, 'Provider configuration is locked; after verifying no Scranton writer is running, remove models.json.scranton-lock from the Pi agent directory');
        await sleep(25);
      }
    }
    try {
      fs.writeFileSync(path.join(lock, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 });
      return await fn();
    } finally { fs.unlinkSync(path.join(lock, 'pid')); fs.rmdirSync(lock); }
  }
  function commit(models, registry) {
    if (fs.existsSync(modelsPath)) {
      try { fs.copyFileSync(modelsPath, `${modelsPath}.scranton-bak`, fs.constants.COPYFILE_EXCL); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    atomic(modelsPath, models);
    atomic(registryPath, registry);
  }
  function list() {
    detail = undefined;
    try {
      const { models, registry } = read();
      return Object.keys(registry).filter((id) => Object.hasOwn(models.providers, id) && registry[id] === digest(models.providers[id])).map((id) => {
        const entry = models.providers[id];
        if (builtinCatalog.some((p) => p.id === id)) return { id, label: id, custom: true, methods: [], status: 'error', detail: 'Custom provider conflicts with a built-in Pi provider' };
        // Revalidate before exposing or mounting metadata, even if the registry was edited externally.
        const safe = validateProvider({ id, label: entry.name, baseUrl: entry.baseUrl, api: entry.api, models: entry.models });
        return { id, label: safe.name, baseUrl: safe.baseUrl, api: safe.api, models: safe.models, custom: true, methods: ['api_key'] };
      });
    } catch { detail = 'Cannot read custom provider configuration; custom providers unavailable'; return []; }
  }
  return { list, getDetail: () => detail,
    add: (value, afterWrite = async () => {}, canRepair = async () => false) => exclusive(async () => {
      const entry = validateProvider(value), { models, registry } = read(true);
      const managed = Object.hasOwn(registry, value.id) && Object.hasOwn(models.providers, value.id) && registry[value.id] === digest(models.providers[value.id]);
      const repairable = await canRepair(managed);
      if (Object.hasOwn(models.providers, value.id) && (!managed || !repairable)) {
        throw failure(409, 'Provider already exists; remove a managed provider before replacing it');
      }
      const originals = [modelsPath, registryPath].map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]);
      try {
        models.providers[value.id] = entry; registry[value.id] = digest(entry); commit(models, registry);
        await afterWrite();
      } catch (error) {
        for (const [file, bytes] of originals) { if (bytes === null) fs.rmSync(file, { force: true }); else atomic(file, bytes); }
        throw error;
      }
    }),
    remove: (id, beforeWrite = async () => {}) => exclusive(async () => {
      const { models, registry } = read(true);
      if (!Object.hasOwn(registry, id) || !Object.hasOwn(models.providers, id) || registry[id] !== digest(models.providers[id])) throw failure(409, 'Provider is not managed by Scranton or was modified externally');
      await beforeWrite(); delete models.providers[id]; delete registry[id]; commit(models, registry);
    })
  };
}

export async function discoverModels({ baseUrl, api, key }, { fetcher = fetch, timeoutMs = 10000, maxBytes = 1024 * 1024 } = {}) {
  const base = validateBaseUrl(baseUrl); key = validateKey(key);
  if (base.includes(key)) throw failure(400, 'Provider URL must not contain the API key');
  if (!apis.includes(api)) throw failure(400, 'Unsupported provider API');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = `${base}/models`;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetcher(url, { redirect: 'manual', signal: controller.signal, headers: { Authorization: `Bearer ${key}` } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const next = new URL(response.headers.get('location'), url);
        if (next.origin !== new URL(base).origin) throw Error();
        url = `${validateBaseUrl(next.href)}`; continue;
      }
      if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw Error(); }
      let bytes = 0; const chunks = [];
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > maxBytes) { controller.abort(); throw Error(); } chunks.push(Buffer.from(chunk)); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(data.data) || data.data.length > 256) throw Error();
      const models = data.data.map((m) => {
        if (!object(m) || typeof m.id !== 'string' || !m.id || m.id.length > 256 || /[\s\x00-\x1f\x7f]/.test(m.id) || m.id.includes(key)) throw Error();
        return { id: m.id, ...Object.fromEntries(['contextWindow', 'maxTokens'].filter((k) => Number.isSafeInteger(m[k]) && m[k] > 0).map((k) => [k, m[k]])) };
      });
      return { models };
    }
    throw Error();
  } catch { throw failure(502, 'Provider discovery failed (URL, response size, timeout or credentials); check configuration'); }
  finally { clearTimeout(timer); }
}
