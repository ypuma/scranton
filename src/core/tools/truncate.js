export const DEFAULT_LIMITS = Object.freeze({ maxLines: 200, maxBytes: 10 * 1024, readMaxLines: 2000, readMaxBytes: 50 * 1024, grepMaxLineLength: 500, grepTimeoutMs: 5000 });
export const formatSize = (n) => n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`;

export function limitsFor(ctx, read = false) {
  const limits = { ...DEFAULT_LIMITS, ...ctx.limits };
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid truncation limit ${key}: expected a positive integer`);
  return { maxLines: read ? limits.readMaxLines : limits.maxLines, maxBytes: read ? limits.readMaxBytes : limits.maxBytes, grepMaxLineLength: limits.grepMaxLineLength, grepTimeoutMs: limits.grepTimeoutMs };
}

export function truncate(text, { maxLines, maxBytes }, tail = false) {
  const totalBytes = Buffer.byteLength(text);
  const lines = text ? text.split('\n') : [];
  if (text.endsWith('\n')) lines.pop();
  const totalLines = lines.length;
  let content = text, lastLinePartial = false;
  if (totalLines > maxLines || totalBytes > maxBytes) {
    const selected = [];
    let bytes = 0;
    for (const line of tail ? [...lines].reverse() : lines) {
      const size = Buffer.byteLength(line) + (selected.length ? 1 : 0);
      if (selected.length >= maxLines) break;
      if (bytes + size > maxBytes) {
        if (tail && !selected.length) {
          const buffer = Buffer.from(line);
          let start = Math.max(0, buffer.length - maxBytes);
          while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
          selected.push(buffer.subarray(start).toString('utf8'));
          lastLinePartial = true;
        }
        break;
      }
      selected.push(line); bytes += size;
    }
    content = (tail ? selected.reverse() : selected).join('\n');
  }
  const outputLines = content ? content.split('\n').length - (content.endsWith('\n') ? 1 : 0) : 0;
  return { content, truncated: content !== text, totalLines, totalBytes, outputLines, outputBytes: Buffer.byteLength(content), lastLinePartial, maxLines, maxBytes };
}

export function listOutput(lines, ctx, { limit, noun, empty, notices = [] }) {
  const truncation = truncate(lines.slice(0, limit).join('\n'), limitsFor(ctx));
  if (lines.length > limit) notices.push(`${limit} ${noun} limit reached. Use limit=${limit * 2} for more, or refine pattern`);
  if (truncation.truncated) notices.push(`${truncation.maxLines} lines / ${formatSize(truncation.maxBytes)} limit reached. Use a narrower pattern or path, or higher ctx.limits`);
  return { content: (truncation.content || (lines.length ? '' : empty)) + (notices.length ? `\n\n[${notices.join('. ')}]` : ''), details: { truncation } };
}
