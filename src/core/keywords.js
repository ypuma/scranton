/** Status keywords each agent may end its final message with (written in brackets in the text). */
export const KEYWORDS = {
  michael: ['PLAN_READY'],
  dwight: ['TASK_COMPLETE', 'BLOCKED'],
  oscar: ['REVIEW_APPROVED', 'CHANGES_REQUESTED', 'BLOCKED'],
  hank: ['SECURITY_PASSED', 'SECURITY_ISSUES', 'BLOCKED'],
  angela: ['TEST_PASSED', 'TEST_FAILED', 'BLOCKED']
};

const BRACKETED = /\[([A-Z][A-Z0-9_]*)\]/g;

/**
 * The LAST known bracketed keyword in `text`, without brackets, or null.
 * Markdown around it (`**[TEST_PASSED]**`, backticks) is irrelevant; only final assistant text belongs here.
 */
export function extractKeyword(text, allowed) {
  const known = new Set(allowed);
  let found = null;
  for (const match of String(text ?? '').matchAll(BRACKETED)) {
    if (known.has(match[1])) found = match[1];
  }
  return found;
}
