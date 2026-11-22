import { models } from './llm/catalogue.js';
import { createCredentialStore, credentialsDirectory } from './credentials/store.js';
export { PROVIDER_ENV_NAMES } from './credentials/environment.js';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const failure = (status, message) => Object.assign(new Error(message), { status });
const apis = ['openai-completions', 'openai-responses', 'anthropic-messages'];
export const builtinCatalog = Object.freeze([...new Set(models.map((m) => m.provider))].map((id) => Object.freeze({
  id, name: { anthropic: 'Claude (Pro/Max)', openai: 'ChatGPT', google: 'Gemini', 'google-antigravity': 'Google Antigravity', 'google-vertex': 'Google Vertex AI' }[id] ?? id,
  auth: { ...(['anthropic', 'openai', 'google-antigravity'].includes(id) ? { oauth: true } : {}),
    ...(id !== 'google-antigravity' ? { apiKey: { login: true } } : {}) }
})));
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

export function createProviderStore(dir = credentialsDirectory()) {
  const store = createCredentialStore({ dir });
  let detail;
  return { list() {
    try { detail = undefined; return Object.values(store.read().providers).map((p) => {
      const safe = validateProvider(p);
      return { id: p.id, label: safe.name, baseUrl: safe.baseUrl, api: safe.api, models: safe.models, custom: true, methods: ['api_key'] };
    }); } catch { detail = 'Cannot read Scranton provider configuration'; return []; }
  }, getDetail: () => detail,
  async add(value) {
    const entry = validateProvider(value);
    await store.transaction((data) => {
      if (Object.hasOwn(data.providers, value.id) || Object.hasOwn(data.credentials, value.id)) throw Object.assign(failure(409, 'Provider already exists'), {code:'SCRANTON_PROVIDER_CONFLICT'});
      data.providers[value.id] = { id: value.id, label: entry.name, baseUrl: entry.baseUrl, api: entry.api, models: entry.models };
    });
  }, async remove(id) {
    await store.transaction((data) => {
      if (!Object.hasOwn(data.providers, id)) throw Object.assign(failure(409, 'Provider is not managed by Scranton'), {code:'SCRANTON_PROVIDER_CONFLICT'});
      delete data.providers[id]; delete data.credentials[id]; delete data.renewals[id];
    });
  } };
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
