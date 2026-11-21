import path from 'node:path';
import { listRestorePoints } from './restore-points.js';

export function quotePathArgument(value, platform = process.platform) {
  value = String(value);
  if (platform === 'win32') return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function formatCommandScope(hiveDir, scope) {
  return scope ? `--data ${quotePathArgument(scope.dataDir)} --project ${scope.projectId} --chat ${scope.chatId}` : `--hive ${quotePathArgument(hiveDir)}`;
}

export function formatRunSummary(orchestrator, result, durationMs, scope) {
  const state = orchestrator.rec.state, trees = orchestrator.worktrees;
  const milestones = state.milestones ?? [];
  const count = (status) => milestones.filter((m) => m.status === status).length;
  const lines = ['', `Outcome: ${result.status}${result.summary ? ` - ${result.summary}` : ''}`,
    `Milestones: ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped, ${count('aborted')} aborted, ${count('blocked')} blocked`];
  if (trees?.initial instanceof Map && trees.integrated instanceof Map) {
    const files = [...new Set([...trees.initial.keys(), ...trees.integrated.keys()])].filter((name) => {
      const before = trees.initial.get(name), after = trees.integrated.get(name);
      return !before || !after || before.mode !== after.mode || !before.data.equals(after.data);
    }).sort();
    lines.push(`Workspace changes: ${files.length} file${files.length === 1 ? '' : 's'}`, ...files.slice(0, 20).map((file) => `  ${file}`));
    if (files.length > 20) lines.push(`  ... and ${files.length - 20} more`);
    if (files.length && !orchestrator.standaloneAgent) {
      try {
        const point = listRestorePoints(orchestrator.config.hiveDir).find((p) => p.runId === orchestrator.runId && !p.unreadable);
        if (point?.remaining > 0) {
          const target = formatCommandScope(orchestrator.config.hiveDir, scope);
          lines.push(`Undo: scranton undo ${target} --run ${orchestrator.runId}`);
        }
        if (point?.unrestorable > 0) lines.push(`Not restorable: ${point.unrestorable} ${point.unrestorable === 1 ? 'file has' : 'files have'} no backup.`);
      } catch { lines.push('Undo: restore point could not be inspected'); }
    }
  } else lines.push('Workspace changes: not recorded');
  if (orchestrator.standaloneAgent) {
    const instance = orchestrator.instances.get(orchestrator.standaloneAgent);
    if (trees && instance?.worktree) lines.push(`Private worktree: ${instance.worktree}`, 'Workspace was not changed; inspect or copy the private files to use this result.');
    else if (instance) lines.push(`Agent directory: ${instance.worktree}`, 'Shared isolation: the agent worked directly in the workspace.');
  }
  lines.push(`Duration: ${(durationMs / 1000).toFixed(1)} s`);
  if (state.usage?.calls > 0) lines.push(`Usage: ${state.usage.input} input + ${state.usage.output} output tokens; recorded cost: ${state.usage.cost}`);
  else lines.push('Usage / cost: not recorded');
  lines.push(`Log: ${path.join(orchestrator.config.hiveDir, 'events.jsonl')}`);
  return lines.join('\n') + '\n';
}
