import './isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/core/config.js';
import { resolvePrompt } from '../../src/core/prompts.js';
import { KEYWORDS, extractKeyword } from '../../src/core/keywords.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const readPrompt = (role) => fs.readFileSync(path.join(root, 'agents', role, 'SKILL.md'), 'utf8');
const angela = readPrompt('angela');
const prompts = Object.fromEntries(['oscar', 'hank'].map((role) => [role, readPrompt(role)]));

for (const role of ['oscar', 'hank']) {
  test(`${role} built-in keywords survive frontmatter stripping`, (t) => {
    const scratch = path.join(root, '.scratch', 'prompt-fix', 'role-prompts');
    fs.mkdirSync(scratch, { recursive: true });
    const dir = fs.mkdtempSync(path.join(scratch, 'config-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const config = loadConfig({ cwd: dir, env: {}, hasBash: true, fileConfig: {} });
    const prompt = resolvePrompt(config, role);
    assert.equal(prompt.source, 'builtin');
    assert.equal(prompt.text, prompt.builtinText);
    assert.doesNotMatch(prompt.text, /^---/);
    for (const keyword of KEYWORDS[role]) {
      assert.ok(prompts[role].includes(`[${keyword}]`), `${role} declares ${keyword}`);
      assert.ok(prompt.text.includes(`[${keyword}]`), `${role} retains ${keyword} in delivered text`);
    }
    assert.deepEqual(prompt.missingKeywords, []);
  });

  test(`${role} defers change discovery to the handoff in both isolation modes`, () => {
    const text = prompts[role];
    assert.match(text, /follow the handoff's "How to see the changes" section/i, 'handoff guidance takes priority');
    assert.match(text, /if it is missing.*Changed files list.*git status --short.*git diff.*git diff HEAD\^ HEAD/i, 'fallback order is explicit');
    assert.match(text, /say which source was used/i);
    assert.match(text, /default isolated mode/i);
    assert.match(text, /shared workspace in trusted-host mode/i);
  });

  test(`${role} report skeleton is fail-closed when copied literally`, () => {
    const text = prompts[role];
    const template = text.slice(text.lastIndexOf('```markdown'));
    const pass = role === 'hank' ? 'SECURITY_PASSED' : 'REVIEW_APPROVED';
    assert.ok(!template.includes(`[${pass}]`), 'no pass keyword after the last markdown fence');
    const skeleton = template.split('```')[1].replace(/^markdown\r?\n/, '').trim();
    assert.doesNotMatch(skeleton.split(/\r?\n/).at(-1), /^\[[A-Z_]+\]$/, 'final skeleton line is not a keyword');
    assert.equal(extractKeyword(template, KEYWORDS[role]), null, 'literal template produces no verdict');
  });

  test(`${role} findings take precedence over incomplete inspection`, () => {
    const text = prompts[role];
    assert.match(text, /wins over incompleteness/i, 'findings outrank incomplete inspection');
    assert.match(text, /list the gaps under Limitations/i);
    assert.match(text, /\[BLOCKED\] only when no meaningful (?:audit|review) was possible/);
    assert.match(text, role === 'hank' ? /medium-or-above finding wins.*\[SECURITY_ISSUES\]/ : /blocking finding wins.*\[CHANGES_REQUESTED\]/);
  });

  test(`${role} contains no copied QA instructions`, () => {
    assert.doesNotMatch(prompts[role], /QA role|the QA report|every criterion passes|Judge only this milestone against its criteria/i);
  });

  test(`${role} is distinct from Angela and the other gate`, () => {
    assert.notEqual(prompts[role], angela);
    assert.notEqual(prompts[role], prompts[role === 'oscar' ? 'hank' : 'oscar']);
    const angelaLines = new Set(angela.split(/\r?\n/));
    for (const line of prompts[role].split(/\r?\n/).filter((line) => line.length >= 60)) {
      assert.equal(angelaLines.has(line), false, `${role} must not copy Angela's long line: ${line}`);
    }
  });

  test(`${role} specifies read-only isolation and a final-line report template`, () => {
    const text = prompts[role];
    assert.match(text, /^---\r?\nname: \w+\r?\ndescription: .+\r?\n---/);
    for (const tool of ['read', 'grep', 'find', 'ls', 'bash', 'powershell']) assert.ok(text.includes(`\`${tool}\``), tool);
    assert.match(text, /read-only/i);
    assert.match(text, /installs/i);
    assert.match(text, /network access beyond what .+ strictly needs/i);
    assert.match(text, /own fresh checkout of Dwight's immutable developer snapshot/);
    assert.match(text, /(?:nothing a gate changes is ever integrated|Gate modifications are never integrated)/);
    assert.match(text, /```markdown\r?\n## /);
    assert.match(text, /- Location: <file:line>/);
    assert.match(text, /last line.*(?:only|nowhere else)|last line only/i);
    assert.match(text, /cannot (?:audit|review)/);
    assert.equal(text.trim().split(/\r?\n/).at(-1), '```', 'template ends without an example verdict');
  });
}

test('Michael warns only about keywords absent from the run-effective prompt', (t) => {
  const scratch = path.join(root, '.scratch', 'prompt-fix', 'role-prompts');
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'michael-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig({ cwd: dir, env: {}, hasBash: true, fileConfig: {} });
  assert.deepEqual(resolvePrompt(config, 'michael').missingKeywords, []);
  const customDir = config.promptsDir ?? path.join(config.hiveDir, 'prompts');
  fs.mkdirSync(customDir, { recursive: true });
  fs.writeFileSync(path.join(customDir, 'michael.md'), 'Plan the requested work.');
  const custom = resolvePrompt(config, 'michael');
  assert.equal(custom.source, 'custom');
  assert.deepEqual(custom.missingKeywords, ['PLAN_READY']);
});

test('Hank audits every security category with severity-based verdicts', () => {
  const text = prompts.hank;
  for (const category of [/command, SQL and template injection/i, /path traversal/i, /authentication and authorization \(authn\/authz\)/i, /secrets in code or logs/i, /unsafe deserialization/i, /eval or command execution/i, /SSRF/, /new or unsafe dependencies/i, /insecure defaults/i, /fail-open handling/i]) {
    assert.match(text, category);
  }
  for (const severity of ['critical', 'high', 'medium', 'low']) assert.match(text, new RegExp(`\\b${severity}\\b`));
  assert.match(text, /\[SECURITY_ISSUES\] if any finding is medium or above/);
  assert.match(text, /\[SECURITY_PASSED\] if there are no medium-or-above findings/);
  assert.match(text, /low\/info notes are allowed/i);
  assert.match(text, /- Attack scenario or reproducer:/);
  assert.match(text, /- Concrete fix:/);
  assert.doesNotMatch(text, /acceptance criteri/i);
});

test('Oscar reviews code and test coverage with blocking-based verdicts', () => {
  const text = prompts.oscar;
  for (const category of ['correctness', 'edge cases', 'error handling', 'regressions', 'maintainability', 'test coverage']) assert.ok(text.toLowerCase().includes(category), category);
  assert.match(text, /\[CHANGES_REQUESTED\] if any finding is blocking/);
  assert.match(text, /\[REVIEW_APPROVED\] otherwise; non-blocking notes are allowed/);
  assert.match(text, /- Classification: <blocking\/non-blocking>/);
  assert.match(text, /- Suggested fix:/);
});
