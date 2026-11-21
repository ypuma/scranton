import { createHash } from 'node:crypto';

const PAIR = '/_relay/pair';

const styles = `
  :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #131313; color: #f5f5f5; }
  body { margin: 0; padding: clamp(16px, 5vw, 48px); }
  main { max-width: 27rem; margin: 10vh auto 0; }
  h1 { margin: 0 0 12px; font-size: clamp(1.75rem, 6vw, 2.375rem); letter-spacing: -.035em; }
  p { color: #bdbdbd; line-height: 1.5; margin: 0 0 24px; }
  form { display: grid; gap: 12px; }
  label { font-weight: 600; }
  .entry { display: flex; gap: 8px; }
  input, button { box-sizing: border-box; min-height: 48px; border-radius: 6px; font: inherit; padding: 10px 14px; }
  input { flex: 1; min-width: 0; width: 100%; border: 1px solid #8b8b8b; background: #202020; color: inherit;
    font-family: ui-monospace, "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace; font-size: 1.0625rem; letter-spacing: .04em; }
  input[aria-invalid=true] { border: 2px solid #f5f5f5; }
  button { border: 0; background: #f5f5f5; color: #131313; font-weight: 650; cursor: pointer; }
  .reveal { flex: none; border: 1px solid #8b8b8b; background: transparent; color: inherit; font-weight: 500; }
  .hint { margin: 0; font-size: .9375rem; }
  .note { margin: 24px 0 0; font-size: .875rem; }
  :focus-visible { outline: 2px solid #fff; outline-offset: 4px; }
  [role=alert] { margin: 0; padding: 12px 14px; border-radius: 6px; background: #f5f5f5; color: #131313; font-weight: 600; }
`;

// Progressive: without scripts the code stays masked and the form still posts.
const script = `
  const code = document.getElementById('code');
  const reveal = document.getElementById('reveal');
  reveal.hidden = false;
  reveal.addEventListener('click', () => {
    const show = code.type === 'password';
    code.type = show ? 'text' : 'password';
    reveal.textContent = show ? 'Hide code' : 'Show code';
    code.focus();
  });
  code.addEventListener('input', () => {
    const clean = code.value.replace(/\\s+/g, '');
    if (clean !== code.value) code.value = clean;
  });
`;

const hash = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
export const PAIR_POLICY = `default-src 'none'; style-src ${hash(styles)}; script-src ${hash(script)}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

function waitText(res) {
  const seconds = Number(res.getHeader?.('retry-after'));
  if (!Number.isInteger(seconds) || seconds <= 0) return 'a minute';
  if (seconds < 120) return seconds === 1 ? '1 second' : `${seconds} seconds`;
  if (seconds < 7200) return `${Math.ceil(seconds / 60)} minutes`;
  return `${Math.ceil(seconds / 3600)} hours`;
}

function alertFor(res, status) {
  if (status === 401) {
    return '<p role="alert" id="code-error">That code did not match. The code changes whenever the relay restarts: check the current relay terminal and enter it again.</p>';
  }
  if (status === 429) {
    return `<p role="alert" id="code-error">Pairing is paused for ${waitText(res)}, after several wrong codes or because the most browsers are paired already. Wait, or disconnect another phone under Settings, Phone relay, then enter the code again.</p>`;
  }
  return '';
}

// The relay sets the shared headers (Cache-Control, framing, sniffing, any Retry-After) before calling this.
export function pairPage(res, status = 200) {
  const error = alertFor(res, status);
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': PAIR_POLICY
  });
  res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${status === 200 ? '' : 'Try again - '}Pair with Scranton</title>
  <style>${styles}</style>
</head>
<body>
  <main>
    <h1>Pair with Scranton</h1>
    <p>Enter the pairing code shown in the relay terminal on your computer.</p>
    <form method="post" action="${PAIR}">
      <label for="code">Pairing code</label>
      <div class="entry">
        <input id="code" name="code" type="password" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" required maxlength="64"
          pattern="[A-Za-z0-9_\\-]+" title="Letters, digits, - and _ only, without spaces" aria-describedby="code-hint${error ? ' code-error' : ''}"${status === 401 ? ' aria-invalid="true" autofocus' : ''}>
        <button type="button" class="reveal" id="reveal" aria-controls="code" hidden>Show code</button>
      </div>
      <p class="hint" id="code-hint">Copy it exactly: letters are case-sensitive, and it may contain - and _.</p>
      ${error}
      <button type="submit">Connect to Scranton</button>
    </form>
    <p class="note">This browser stays paired for up to 12 hours, until the relay stops, or until you disconnect it under Settings, Phone relay.</p>
  </main>
  <script>${script}</script>
</body>
</html>`);
}
