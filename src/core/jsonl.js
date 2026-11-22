import { StringDecoder } from 'node:string_decoder';

/**
 * Strict JSONL framing: split on LF only (optional CR stripped).
 * node:readline is unsuitable because it also splits on U+2028/U+2029, which are legal inside JSON strings.
 */
export class JsonlSplitter {
  #decoder = new StringDecoder('utf8');
  #buffer = '';

  /** Feed a Buffer/string chunk; returns the complete lines it finished. */
  push(chunk) {
    this.#buffer += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
    const lines = [];
    let start = 0;
    let at;
    while ((at = this.#buffer.indexOf('\n', start)) !== -1) {
      lines.push(stripCr(this.#buffer.slice(start, at)));
      start = at + 1;
    }
    this.#buffer = this.#buffer.slice(start);
    return lines;
  }

  /** Flush a trailing line that had no LF (and any bytes held by the decoder). */
  end() {
    this.#buffer += this.#decoder.end();
    const rest = stripCr(this.#buffer);
    this.#buffer = '';
    return rest ? [rest] : [];
  }
}

function stripCr(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Parse one line to an object, or null when it is blank / not a JSON object. */
export function parseJsonLine(line) {
  if (!line || !line.trim()) return null;
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}
