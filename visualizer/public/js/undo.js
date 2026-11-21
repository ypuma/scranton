// Pure logic of "Undo these changes" for a finished Team run: the chat's restore-point routes, tolerant parsers of
// GET restore-points and POST undo, when the rail offers it, and every text it shows. A run's restore point puts
// back what the run replaced or deleted and removes what it created, only where a file is still as the run left
// it; git history and the chat's runs are not touched. Undo works backwards: only the newest point that is not
// fully undone can be undone. No DOM, so Node can test it.
import { stripBidi, formatWhen, plural } from './format.js';
import { clip, responseError } from './control.js';
import { PROJECT_ID_RE, CHAT_ID_RE, RUN_ID_RE } from './scope.js';

export const UNDO_ACTIONS = ['restore-points', 'undo'];
export const UNDO_LABEL = 'Undo these changes';
export const CONTINUE_LABEL = 'Continue the undo';
export const FORCE_LABEL = 'Overwrite the later changes';
export const ACTIVE_TEXT = 'A run is active in this chat. Stop it or wait, then undo.';
export const RECOVERY_TEXT = 'This chat needs recovery first: an earlier run still holds it. Recover it, then undo.';
export const NO_POINT = 'This run has no restore point any more.';
export const OLDER_TEXT = 'Undo works backwards: undo the later runs of this chat first.';
export const UNREADABLE_POINT = 'The restore point of this run cannot be read, so its changes cannot be undone here.';
export const CONFLICT_CODES = ['changed', 'unrestorable', 'blocked'];
export const UNDOING_TEXT = 'Undoing...';
// a POST without an answer by then is abandoned, never sent again on its own: the server may have undone it all
export const UNDO_TIMEOUT_MS = 120_000;
export const UNKNOWN_TEXT = 'The undo did not answer within 2 minutes, so its result is unknown. Check the folder and reload the page before you try again.';
const POINTS_MAX = 200;
const PATHS_MAX = 1000;
const PATH_MAX = 1024;
const WARNINGS_MAX = 50;
// a refusal can list every newer run of the chat
const ERROR_MAX = 2000;
const AS_DONE = 'The list and the diff below show what the run did, not the folder as it is now.';

const enc = encodeURIComponent;
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const iso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const line = (v, max) => (typeof v === 'string' ? clip(stripBidi(v), max) : '');
const asIs = (n) => (n === 1 ? 'it is' : 'they are');

// -> '/api/projects/:p/chats/:c/restore-points' | '.../undo', or null for a bad id or action
export function undoUrl(projectId, chatId, action) {
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId) || typeof chatId !== 'string' || !CHAT_ID_RE.test(chatId)) return null;
  return UNDO_ACTIONS.includes(action) ? `/api/projects/${enc(projectId)}/chats/${enc(chatId)}/${action}` : null;
}

// GET restore-points -> { valid, points: [{ runId, createdAt, files, undoneAt, remaining, unreadable }] }, one per
// run, newest first as the server lists them. remaining: the files not undone yet; a server from before it says
// nothing, which is all of them while the point is open and none once it is undone.
export function parseRestorePoints(doc) {
  const d = obj(doc);
  const valid = Boolean(d) && Array.isArray(d.points);
  const seen = new Set();
  const points = [];
  for (const p of valid ? d.points.slice(0, POINTS_MAX) : []) {
    const x = obj(p);
    if (!x || typeof x.runId !== 'string' || !RUN_ID_RE.test(x.runId) || seen.has(x.runId)) continue;
    seen.add(x.runId);
    if (x.unreadable === true) {
      points.push({ runId: x.runId, createdAt: null, files: null, undoneAt: null, remaining: null, unreadable: true });
      continue;
    }
    const files = count(x.files);
    const undoneAt = iso(x.undoneAt);
    const left = undoneAt ? 0 : count(x.remaining) ?? files;
    points.push({ runId: x.runId, createdAt: iso(x.createdAt), files, undoneAt, remaining: left === null || files === null ? left : Math.min(left, files), unreadable: false });
  }
  return { valid, points };
}

// a path is shown as it is: spaces inside it are part of the name
const pathOf = (v) => (typeof v === 'string' ? stripBidi(v).slice(0, PATH_MAX) : '');
const paths = (v) => (Array.isArray(v) ? v.slice(0, PATHS_MAX).map(pathOf).filter((p) => p.trim()) : []);

const REASONS = { changed: 'changed after the run', unrestorable: 'no usable backup', blocked: 'could not be written right now' };

// a conflict without a code is a changed file, the one kind force can overwrite; a code this page does not know is
// one that undoing again may get past, never one to force
function conflictOf(c) {
  const code = c.code === undefined || c.code === null ? 'changed' : CONFLICT_CODES.includes(c.code) ? c.code : 'blocked';
  return { path: pathOf(c.path), reason: line(c.reason, 300) || REASONS[code], code };
}

// POST undo -> { valid, runId, restored, removed, conflicts: [{ path, reason, code }] }
export function parseUndo(doc, runId = null) {
  const d = obj(doc);
  const valid = Boolean(d) && Array.isArray(d.restored) && Array.isArray(d.removed);
  const conflicts = (Array.isArray(d?.conflicts) ? d.conflicts.slice(0, PATHS_MAX) : []).map(obj)
    .map((c) => c && conflictOf(c)).filter((c) => c?.path.trim());
  return { valid, runId: typeof d?.runId === 'string' ? d.runId : runId, restored: paths(d?.restored), removed: paths(d?.removed), conflicts };
}

// POST undo's warnings (a directory that could not be removed): plain lines, [] without any
export const undoWarnings = (doc) => (Array.isArray(obj(doc)?.warnings) ? doc.warnings.slice(0, WARNINGS_MAX).map((w) => line(w, PATH_MAX + 300)).filter((w) => w.trim()) : []);

export function buildUndo(runId, force = false) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return { error: 'There is no run to undo.' };
  return { body: force ? { runId, force: true } : { runId } };
}

// nothing left to undo is undone, also from a server that did not set undoneAt then
const undone = (p) => Boolean(p.undoneAt) || (p.remaining === 0 && p.files !== 0);
const open = (p) => !undone(p);
const partly = (p) => !p.unreadable && !undone(p) && p.files !== null && p.remaining !== null && p.remaining < p.files;

// What the outcome says for the run on screen. run: { runId, over (finished, not live), team }; points: the chat's,
// newest first. -> 'none' | 'offer' | 'partial' (both can be undone) | 'older' (a later run is not fully undone) |
// 'undone' | 'unreadable'. Whether a run of the chat is going is the caller's: it only hides the control.
export function undoState(run, points) {
  const list = Array.isArray(points) ? points : [];
  const at = run?.runId && run.over && run.team ? list.findIndex((p) => p.runId === run.runId) : -1;
  if (at < 0) return 'none';
  const point = list[at];
  if (point.unreadable) return 'unreadable';
  if (undone(point)) return 'undone';
  if (list.slice(0, at).some(open)) return 'older';
  return partly(point) ? 'partial' : 'offer';
}

// How far the point on the outcome's files line is undone: 'undone' | 'partial' | ''
export const undoneMark = (point) => (!point || point.unreadable ? '' : undone(point) ? 'undone' : partly(point) ? 'partial' : '');

export const undoneText = (at, fmt = formatWhen) => (at ? `These changes were undone at ${fmt(at)}.` : 'These changes were undone.');
export const partialText = (p) => `Partly undone: ${p.remaining} of ${plural(p.files, 'file')} kept as ${asIs(p.remaining)}.`;

// The Changes panel of an undone run: its diff and list are what the run did. '' for a run that is not undone.
export function changesNote(point, fmt = formatWhen) {
  const mark = undoneMark(point);
  if (mark === 'undone') return `${undoneText(point.undoneAt, fmt)} ${AS_DONE}`;
  if (mark === 'partial') return `These changes were partly undone: ${point.remaining} of ${plural(point.files, 'file')} kept as ${asIs(point.remaining)}. ${AS_DONE}`;
  return '';
}

// the confirmation before the POST: what happens, where, and that later edits are kept
export function undoQuestion(folder, point = null) {
  const where = folder ? ` in ${folder}` : '';
  const kept = 'A file that is no longer as the run left it is kept as it is and listed afterwards. Git history and the chat stay as they are.';
  if (partly(point ?? {})) {
    const n = point.remaining;
    return {
      title: 'Continue the undo of this run?',
      detail: `The ${plural(n, 'file')} of this run that ${n === 1 ? 'was' : 'were'} kept${where} ${n === 1 ? 'is' : 'are'} tried again: what the run replaced or deleted is put back, and what it created is removed. ${kept}`,
      ok: 'Undo changes',
    };
  }
  const many = Number.isInteger(point?.files) && point.files > 0 ? ` The restore point holds ${plural(point.files, 'file')}.` : '';
  return {
    title: 'Undo the changes of this run?',
    detail: `The files this run replaced or deleted${where} are put back, and the files it created are removed.${many} A file that was changed after the run is kept as it is and listed afterwards. Git history and the chat stay as they are.`,
    ok: 'Undo changes',
  };
}

// changed: the conflicts force can overwrite. Who changed them the server does not say, so neither does this.
export function forceQuestion(changed, folder) {
  const n = changed.length;
  const one = n === 1;
  return {
    title: 'Overwrite the later changes?',
    detail: `${one ? 'The file listed as changed was' : `The ${n} files listed as changed were`} changed after the run${folder ? ` in ${folder}` : ''}. Those changes may be your own edits or the work of a later run in another chat of this project. Undoing ${one ? 'it' : 'the files'} anyway puts ${one ? 'it' : 'them'} back or removes ${one ? 'it' : 'them'} as the run found ${one ? 'it' : 'them'}, and those changes are lost. Git history and the chat stay as they are.`,
    ok: 'Overwrite changes',
  };
}

export const changedOf = (conflicts) => conflicts.filter((c) => c.code === 'changed');
export const stuckOf = (conflicts) => conflicts.filter((c) => c.code === 'unrestorable');
// files that could not be written now (open in another program): the point stays open and undoing again retries them
export const blockedOf = (conflicts) => conflicts.filter((c) => c.code === 'blocked');

// -> 'Undone: 2 files put back, 1 removed.' plus the changed files' heading, as one sentence for the page
export function undoResult(r) {
  const k = r.restored.length;
  const done = k || r.removed.length
    ? `Undone: ${plural(k, 'file')} put back, ${r.removed.length} removed.`
    : 'Undone: no file had to be put back or removed.';
  const n = changedOf(r.conflicts).length;
  if (!n) return done;
  return `${done} ${n === 1 ? '1 file was' : `${n} files were`} changed after the run and kept as ${asIs(n)}:`;
}

// the heading of the files force cannot help, '' without any
export function stuckText(conflicts) {
  const n = stuckOf(conflicts).length;
  return n ? `${n === 1 ? '1 file' : `${n} files`} could not be undone and ${n === 1 ? 'was' : 'were'} kept as ${asIs(n)}:` : '';
}

// the heading of the files undoing again may restore, '' without any
export function blockedText(conflicts) {
  const n = blockedOf(conflicts).length;
  return n ? `${n === 1 ? '1 file' : `${n} files`} could not be restored right now. Undo again later to retry ${n === 1 ? 'it' : 'them'}:` : '';
}

export const conflictText = (c) => `${c.path} - ${c.reason}`;

// status: HTTP code (0 = no answer); data: the server's JSON error body. Every 409 says why in the server's words.
export function undoError(status, data) {
  if (status === 0) return 'The server did not answer. Is it still running?';
  const msg = typeof data?.error === 'string' ? line(data.error, ERROR_MAX) : '';
  if (status === 409) return msg || ACTIVE_TEXT;
  if (status === 404) return msg && msg !== 'Not found' ? msg : NO_POINT;
  return responseError(status, data);
}

// a server from before restore points
export const unsupported = (status) => [404, 405, 501].includes(status);
