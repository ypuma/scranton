// The tone of a status badge (styles.css .badge[data-tone]): the same word reads the same on the run line, the
// agent cards, the lanes and the board. A status that says nothing yet (idle, pending, to do, unused) is quiet.
const TONES = {
  ok: ['done', 'passed', 'succeeded', 'success', 'finished'],
  run: ['starting', 'thinking', 'working', 'running', 'planning'],
  warn: ['waiting', 'paused', 'blocked', 'stopped', 'cancelled', 'rejected', 'interrupted', 'needs_human'],
  bad: ['failed', 'error', 'aborted', 'exited'],
};
const BY_STATUS = new Map(Object.entries(TONES).flatMap(([tone, words]) => words.map((w) => [w, tone])));

export const statusTone = (status) => BY_STATUS.get(status) ?? 'quiet';

// node: a .badge. Written only when it changes, so a redraw leaves an unchanged badge alone.
export function setTone(node, tone) {
  if (node.dataset.tone !== tone) node.dataset.tone = tone;
}
