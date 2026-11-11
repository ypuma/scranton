import { createProvider } from '@earendil-works/pi-ai/models';
import { createOAuth, responseJson } from './oauth.js';
import { createStream } from './stream.js';

export const ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
// Public desktop-client identity, not an account credential. See the developer contract.
export const USER_AGENT = 'antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)';
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function antigravityProvider({ fetcher = (...args) => fetch(...args), now = Date.now, redirectUri = 'http://localhost:51121/oauth-callback' } = {}) {
  const provision = async (access, signal) => {
    const response = await fetcher(`${ENDPOINT}/v1internal:loadCodeAssist`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } })
    });
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(Error('Google Antigravity project discovery failed'), { code: 'SCRANTON_ANTIGRAVITY_SETUP' }); }
    const data = await responseJson(response);
    const project = typeof data.cloudaicompanionProject === 'string' ? data.cloudaicompanionProject : data.cloudaicompanionProject?.id;
    if (typeof project !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/.test(project)) throw Object.assign(Error('No Google Antigravity project assigned; complete account setup in Antigravity and sign in again'), { code: 'SCRANTON_ANTIGRAVITY_SETUP' });
    return project;
  };
  const oauth = createOAuth({
    clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    clientSecret: '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', redirectUri,
    scopes: ['cloud-platform', 'userinfo.email', 'userinfo.profile', 'cclog', 'experimentsandconfigs'].map((s) => `https://www.googleapis.com/auth/${s}`),
    provision, fetcher, now
  });
  const stream = createStream({ fetcher, endpoint: ENDPOINT, userAgent: USER_AGENT });
  return createProvider({ id: 'google-antigravity', name: 'Google Antigravity', baseUrl: ENDPOINT, auth: { oauth },
    models: ['gemini-3-pro', 'gemini-3-flash'].map((id) => ({ id, name: `${id} (Antigravity)`, provider: 'google-antigravity', api: 'google-generative-ai', baseUrl: ENDPOINT,
      input: ['text', 'image'], reasoning: true, contextWindow: 1048576, maxTokens: 65536, cost,
      thinkingLevelMap: { minimal: 'low', low: 'low', medium: 'high', high: 'high' } })),
    api: { stream, streamSimple: stream }
  });
}
