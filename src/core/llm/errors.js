export function protocolError(message = 'Invalid provider stream') {
  return Object.assign(new Error(message), { code: 'PROTOCOL_ERROR' });
}

const credentialErrors = {
  SCRANTON_OAUTH_TEMPORARY: [true, 'Sign-in renewal is temporarily unavailable; retry shortly'],
  SCRANTON_CREDENTIAL_LOCKED: [true, 'Credential store is busy; retry shortly'],
  SCRANTON_AUTH_MISSING: [false, 'Provider credentials are missing; sign in or configure an API key'],
  SCRANTON_OAUTH_REJECTED: [false, 'Sign-in renewal was rejected; sign in again'],
  SCRANTON_CREDENTIAL_INVALID: [false, 'Provider credentials are invalid; sign in again or configure an API key'],
  SCRANTON_CREDENTIAL_STORE: [false, 'Cannot read or write the credential store; check its permissions and contents'],
  SCRANTON_AUTH_ABORTED: [false, 'Credential operation cancelled'],
  SCRANTON_AUTH_LOGIN: [false, 'Sign-in failed; try signing in again'],
  SCRANTON_AUTH_URL: [false, 'Invalid sign-in URL; start sign-in again'],
  SCRANTON_AUTH_BROWSER: [false, 'Could not open the browser; open the sign-in URL manually'],
  SCRANTON_OAUTH_DENIED: [false, 'Sign-in declined; sign in again'],
  SCRANTON_PROVIDER_INVALID: [false, 'Provider configuration is invalid; check its settings'],
  SCRANTON_PROVIDER_CONFLICT: [false, 'Provider already exists; check its settings']
};

export async function httpError(response) {
  let text = '';
  if (response.status === 400 && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let remaining = 65536;
    try {
      while (remaining > 0) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value.subarray(0, remaining), { stream: true });
        remaining -= value.byteLength;
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } else await response.body?.cancel();
  const overflow = response.status === 413 || response.status === 400 &&
    /context[_ -](?:length|window)[_ -]exceeded|prompt is too long|input token count exceeds (?:the )?maximum|maximum context length|context window (?:is )?exceeded|(?:tokens|input|prompt)[^\n]{0,80}exceeds?[^\n]{0,40}(?:context (?:window|length)|token limit)|exceed[^\n]{0,40}(?:context window|context length)/i.test(text);
  return Object.assign(new Error('Provider rejected request'), { status: response.status,
    ...(overflow ? { code: 'CONTEXT_WINDOW_EXCEEDED' } : {}) });
}

export function classifyError(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const code = error?.name === 'TimeoutError' ? 'TIMEOUT' : error?.name === 'AbortError' ? 'ABORTED'
    : String(error?.code ?? error?.cause?.code ?? (error instanceof TypeError ? 'NETWORK_ERROR' : 'PROVIDER_ERROR'));
  if (Object.hasOwn(credentialErrors, code)) {
    const [transient, message] = credentialErrors[code];
    return { transient, status, code, message };
  }
  if (code === 'CONTEXT_WINDOW_EXCEEDED') return { transient: false, status, code, message: 'Provider context window exceeded' };
  const transient = status !== null ? status === 408 || status === 429 || status >= 500 && status <= 599
    : /^(TIMEOUT|NETWORK_ERROR|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_)/.test(code);
  const message = status !== null ? `Provider request failed (HTTP ${status})`
    : code === 'ABORTED' ? 'Request aborted' : transient ? 'Provider connection failed or timed out'
      : code === 'AUTH_REQUIRED' ? 'Provider credentials are missing or invalid' : 'Provider request or stream is invalid';
  return { transient, status, code, message };
}
