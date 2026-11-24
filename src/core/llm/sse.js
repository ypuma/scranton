import { protocolError, incompleteStream } from './errors.js';

export async function* parseSSE(body, { signal, maxEventBytes = 2 * 1024 * 1024, maxBytes = 32 * 1024 * 1024 } = {}) {
  if (!body) throw incompleteStream('Missing response body');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decode = (chunk, options) => {
    try { return decoder.decode(chunk, options); } catch { throw protocolError('Invalid SSE UTF-8'); }
  };
  let buffer = '', data = [], event = '', id, size = 0, total = 0, skipLF = false;
  const line = (value) => {
    if (!value) {
      const record = data.length ? { event: event || 'message', data: data.join('\n'), ...(id !== undefined ? { id } : {}) } : null;
      data = []; event = ''; size = 0;
      return record;
    }
    size += Buffer.byteLength(value);
    if (size > maxEventBytes) throw protocolError('SSE event exceeds limit');
    if (value.startsWith(':')) return null;
    const colon = value.indexOf(':');
    const key = colon < 0 ? value : value.slice(0, colon);
    let field = colon < 0 ? '' : value.slice(colon + 1);
    if (field.startsWith(' ')) field = field.slice(1);
    if (key === 'data') data.push(field);
    else if (key === 'event') event = field;
    else if (key === 'id' && !field.includes('\0')) id = field;
    return null;
  };
  for await (const chunk of body) {
    signal?.throwIfAborted();
    total += chunk.byteLength;
    if (total > maxBytes) throw protocolError('SSE response exceeds limit');
    let text = decode(chunk, { stream: true });
    if (skipLF && text.length) { if (text.startsWith('\n')) text = text.slice(1); skipLF = false; }
    buffer += text;
    let match;
    while ((match = /[\r\n]/.exec(buffer))) {
      const at = match.index, cr = buffer[at] === '\r';
      const record = line(buffer.slice(0, at));
      const width = cr && buffer[at + 1] === '\n' ? 2 : 1;
      skipLF = cr && at === buffer.length - 1;
      buffer = buffer.slice(at + width);
      if (record) yield record;
    }
    if (Buffer.byteLength(buffer) + size > maxEventBytes) throw protocolError('SSE event exceeds limit');
  }
  buffer += decode();
  signal?.throwIfAborted();
  // SSE only dispatches records terminated by an empty line; a tail is a truncated transport.
  if (buffer || data.length || event) throw incompleteStream('Truncated SSE record');
}

export async function* jsonEvents(body, options) {
  for await (const record of parseSSE(body, options)) {
    if (record.data === '[DONE]') return;
    let value;
    try { value = JSON.parse(record.data); } catch { throw protocolError('Invalid SSE JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolError('Invalid SSE object');
    if (!value.type && record.event !== 'message') value.type = record.event;
    yield value;
  }
}
