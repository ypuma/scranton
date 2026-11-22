import { tailLines } from './util.js';
import { cleanActivity } from './live-activity.js';

export function errorText(value, env, cut = false) {
  let text = String(value ?? '');
  cut ||= text.length > 8192;
  const original = text, start = Math.max(0, text.length - 8192);
  text = text.slice(-8192);
  let marked = false;
  if (cut) {
    text = text.replace(/[\r\n]+$/, '');
    const newline = text.indexOf('\n');
    if (newline !== -1) {
      const p = start + (start > 0 && original[start - 1] === '\n' && !/^\r?\n/.test(text) && !/[:=][ \t"'\r]*$/.test(text.slice(0, newline)) ? 0 : newline + 1);
      let end = p;
      const limit = Math.max(0, p - 4096);
      while (end > limit && /\s/.test(original[end - 1])) end--;
      let previous = end > limit ? original.slice(Math.max(0, end - 256), end) : '';
      previous = previous.slice(previous.lastIndexOf('\n') + 1);
      text = text.slice(p - start);
      if (/[:=][ \t"'\r]*$/.test(previous)) text = text.replace(/^\s*[^\n]*(?:\n|$)/, '[redacted]\n');
    } else {
      // A label may precede the cut; the 256-character floor must not weaken quoted-value masking.
      const a = text.match(/^[^"']*["']|^\S+/)?.[0].length ?? 0;
      const b = text.match(/^[\s\S]{0,256}\S*/)[0].length;
      text = '[redacted]' + text.slice(Math.max(a, b));
      marked = true;
    }
  }
  for (const [key, secret] of Object.entries(env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[redacted]');
  }
  text = text.replace(/\b(?:set-cookie|cookie)\s*:[^\r\n]*/gi, (header) => header.slice(0, header.indexOf(':') + 1) + ' [redacted]')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:key|signature|credential)=)[^&#\s"']*/gi, '$1[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|(?:access[_-]?|refresh[_-]?|id[_-]?)?token|(?:client[_-]?)?secret|password|authorization)\s*(?:["']\s*)?[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
  return (marked ? '[cut] ' : '') + cleanActivity(text).slice(marked ? -2042 : -2048);
}

export function errorTail(value, env, cut = false) {
  return tailLines(errorText(value, env, cut), 8).slice(-2048);
}

