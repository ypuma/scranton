export const SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
`;
export const SUMMARY_PREFIX = 'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';
export const textOf = (message) => typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
export function compactLimit(window, configured) {
  const limit = Number(configured);
  return Math.min(Math.floor(window * 0.9), Number.isSafeInteger(limit) && limit > 0 ? limit : Infinity);
}
export function compactHistory(messages, summary, budget = 20000) {
  const kept = [];
  for (const message of messages.filter(m => m.role === 'user' && !textOf(m).startsWith(SUMMARY_PREFIX)).reverse()) {
    if (budget <= 0) break;
    const text = textOf(message), bytes = Buffer.from(text), tokens = Math.ceil(bytes.length / 4);
    let content = text;
    if (tokens > budget) {
      let left = budget * 2, right = bytes.length - budget * 2;
      while (left > 0 && (bytes[left] & 0xc0) === 0x80) left--;
      while (right < bytes.length && (bytes[right] & 0xc0) === 0x80) right++;
      content = bytes.subarray(0, left).toString() + `…${tokens - budget} tokens truncated…` + bytes.subarray(right).toString();
    }
    kept.unshift({ role: 'user', content }); budget -= tokens;
  }
  return [...kept, { role: 'user', content: `${SUMMARY_PREFIX}\n${summary || '(no summary available)'}` }];
}
export function removeOldest(messages) {
  const [first, ...rest] = messages;
  if (first?.role === 'assistant') {
    const ids = new Set(first.content.filter(b => b.type === 'toolCall').map(b => b.id));
    return rest.filter(m => m.role !== 'toolResult' || !ids.has(m.toolCallId));
  }
  if (first?.role === 'toolResult') return rest.map(m => m.role !== 'assistant' ? m : { ...m, content: m.content.filter(b => b.type !== 'toolCall' || b.id !== first.toolCallId) });
  return rest;
}
