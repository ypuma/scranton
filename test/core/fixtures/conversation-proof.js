import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function conversationProof({ hive, workspace, dir, packageRoot }) {
  const eventsText = fs.readFileSync(path.join(hive, 'events.jsonl'), 'utf8');
  const runId = JSON.parse(eventsText.split('\n')[0]).runId;
  const normalize = (text) => {
    for (const [value, label] of [[workspace, '$WORKSPACE'], [hive, '$HIVE'], [path.join(dir, 'iso'), '$ISOLATION'], [dir, '$FIXTURE'], [packageRoot, '$PACKAGE_ROOT']]) {
      for (const variant of [value, value.replaceAll('\\', '/'), value.replaceAll('\\', '\\\\')]) text = text.split(variant).join(label);
    }
    return text.split(runId).join('$RUN_ID')
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '$TIMESTAMP')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '$SESSION_ID')
      .replace(/("durationMs"\s*:\s*)\d+(?:\.\d+)?/g, (_, key) => key + '0');
  };
  const events = eventsText.trim().split('\n').map((line) => JSON.parse(normalize(line)));
  for (const [id, audit] of Object.entries(events[0].prompts ?? {})) {
    const staged = fs.readFileSync(path.join(hive, id, 'system.md'), 'utf8').trimEnd();
    assert.equal(audit.sha256, createHash('sha256').update(staged).digest('hex'), 'prompt audit matches staged bytes before line-ending normalization');
  }
  return {
    events,
    stateBytes: normalize(fs.readFileSync(path.join(hive, 'state.json'), 'utf8')),
    planningInbox: normalize(fs.readFileSync(path.join(hive, 'michael', 'inbox.md'), 'utf8')),
  };
}
