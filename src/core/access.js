import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { credentialEntries, hasCredentialName } from './sandbox-native/protected.js';
import { credentialLocations } from './sandbox-native/index.js';

export const containsPath = (root, file) => {
  const fold = value => ['win32', 'darwin'].includes(process.platform) ? value.toLowerCase() : value;
  const rel = path.relative(fold(root), fold(file));
  return !rel || rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const samePath = (a, b) => containsPath(a, b) && containsPath(b, a);
const isBroad = (file, home, realHome) => path.dirname(file) === file || samePath(file, home) || realHome && samePath(file, realHome);

export function canWriteOutside(role) {
  return role.kind === 'developer' && (role.tools ?? []).some(tool => tool === 'write' || tool === 'edit');
}
export function accessPath(input, home = os.homedir()) {
  if (typeof input !== 'string' || !input || /[\x00-\x1f\x7f-\x9f]/.test(input)) throw Error('Invalid access path');
  if (input === '~') input = home;
  else if (/^~[\\/]/.test(input)) input = path.join(home, input.slice(2));
  if (/^[\\/]{2}/.test(input)) throw Error('UNC and device paths are not allowed for access requests');
  if (!path.isAbsolute(input) || process.platform === 'win32' && /^[a-z]:[^\\/]/i.test(input)) throw Error('Access path must be absolute or start with ~/');
  return realPath(path.resolve(input));
}

// Resolve existing ancestors too, so a nonexistent child cannot conceal a protected target.
function realPath(full) {
  let current = full, suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (path.dirname(current) === current) throw error;
      suffix.unshift(path.basename(current)); current = path.dirname(current);
    }
  }
}
function configuredPaths(value) {
  const lexical = path.resolve(value);
  try { return [...new Set([lexical, realPath(lexical)])]; }
  catch { return [lexical]; }
}

const insideProtectedRoot = (category, file, roots, lexical) => roots.some(r => r.category === category && (containsPath(r.path, file) || containsPath(r.path, lexical)));
export const insideStateRoot = (file, roots = [], lexical = file) => insideProtectedRoot('scranton-state', file, roots, lexical);

export function protectedPath(file, roots = [], lexical = file) {
  if (insideProtectedRoot('credentials', file, roots, lexical) || hasCredentialName(file) || hasCredentialName(lexical)) return 'credentials';
  return insideStateRoot(file, roots, lexical) ? 'scranton-state' : null;
}

export function orderedPath(file, texts, home = os.homedir()) {
  let realHome;
  try { realHome = accessPath(home, home); } catch { /* A missing or inaccessible home cannot authorize a path. */ }
  if (isBroad(file, home, realHome)) return null;
  for (const text of texts) {
    // Quoted paths allow spaces; unquoted paths end at whitespace or sentence punctuation.
    const candidates = [...text.matchAll(/"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`/g)].map(m => m[1] ?? m[2] ?? m[3]);
    candidates.push(...[...text.matchAll(/(?<![\w:/\\])(?:[a-z]:[\\/][^\s<>"'`;,!?)]*|(?:~[\\/]|\/)[^\s<>"'`;,!?)\\/][^\s<>"'`;,!?)]*)/gi)].map(m => m[0]));
    for (const match of text.matchAll(/(?<![\w/\\-])(Documents|Desktop|Downloads|Pictures|Music|Videos)(?![\w/\\-])/gi)) candidates.push(path.join(home, match[1][0].toUpperCase() + match[1].slice(1).toLowerCase()));
    for (const candidate of candidates) {
      const token = candidate.replace(/[.:]$/, '');
      if (/^(?:[\\/]|~)$/.test(token)) continue;
      try {
        const ordered = accessPath(token, home);
        if (!isBroad(ordered, home, realHome) && containsPath(ordered, file)) return text.slice(0, 200);
      } catch { /* Ordinary prose is not a path. */ }
    }
  }
  return null;
}

export function createAccess({ permissions = 'ask', home = os.homedir(), hiveDir, dataDir, env = process.env, emit = () => {}, humanTexts = [], events = [], protectedRoots: suppliedRoots } = {}) {
  if (!['ask', 'auto', 'bypass'].includes(permissions)) throw Error('permissions must be ask, auto or bypass');
  const rootsFor = (values, category) => [...new Set(values.filter(Boolean).flatMap(configuredPaths))].map(p => ({ path: p, category }));
  const protectedRoots = suppliedRoots ?? [
    ...rootsFor(credentialLocations({ home, env }), 'credentials'),
    ...rootsFor([hiveDir, dataDir, env.SCRANTON_DATA, env.SCRANTON_SETTINGS_DIR, path.dirname(credentialLocations({ home, env: { ...env, SCRANTON_CREDENTIALS_DIR: undefined } })[0])], 'scranton-state'),
  ];
  const texts = [...humanTexts], grants = [], scans = new Map();
  const register = (decision, category = protectedPath(decision.path, protectedRoots)) => {
    const { path: file, mode, by } = decision;
    const existing = grants.find(g => g.path === file && g.mode === mode && g.by === by && g.protected === category);
    if (existing) return existing.ready;
    const grant = { path: file, mode, by, protected: category, shellMasks: null, ready: null };
    if (!scans.has(file)) scans.set(file, credentialEntries(file, dir => protectedPath(dir, protectedRoots) === 'credentials').catch(() => null));
    grant.ready = scans.get(file).then(masks => { grant.shellMasks = masks; return masks; });
    grants.push(grant);
    return grant.ready;
  };
  const observe = (type, fields) => {
    if (type === 'hitl_response' && typeof fields.feedback === 'string') texts.push(fields.feedback);
    if (type === 'chat_message' && fields.from === 'human' && fields.delivery !== 'rejected' && typeof fields.text === 'string') texts.push(fields.text);
    if (type === 'access_decision' && fields.decision === 'granted' && !grants.some(g => g.path === fields.path && g.mode === fields.mode && g.by === fields.by)) return register(fields);
  };
  for (const e of events) observe(e.type, e);
  return {
    permissions, home, protectedRoots, observe,
    snapshot: () => ({ permissions, home, protectedRoots: structuredClone(protectedRoots), humanTexts: [...texts] }),
    roots: () => structuredClone(grants.map(({ ready, ...grant }) => grant)),
    prepare(args, { root, writable, instanceId, agent }) {
      const file = accessPath(args.path, home);
      const lexical = path.resolve(args.path.replace(/^~(?=$|[\\/])/, home));
      const already = containsPath(root, file);
      const category = already ? null : protectedPath(file, protectedRoots, lexical);
      if (category !== (already ? null : protectedPath(file, protectedRoots))) throw Error('Use the direct path instead of a protected path alias');
      const request = { instanceId, agent, path: file, mode: args.mode, reason: args.reason, protected: category };
      const quote = category ? null : orderedPath(file, texts, home);
      const refused = args.mode === 'write' && (!writable || insideStateRoot(file, protectedRoots, lexical));
      let realHome;
      try { realHome = accessPath(home, home); } catch { /* Use the lexical home if inaccessible. */ }
      const broad = isBroad(file, home, realHome);
      if (!already || refused) emit('access_request', request);
      const automatic = !category && !broad && (permissions === 'bypass' || args.mode === 'read' && (permissions === 'auto' || quote !== null));
      return { ...request, quote, refused, already, ask: !refused && !already && !automatic,
        by: quote !== null && args.mode === 'read' ? 'order' : 'mode' };
    },
    async decide(request, reply) {
      if (request.already && !request.refused) return { content: 'Path is already accessible', isError: false };
      const granted = !request.refused && (request.already || !request.ask || reply?.approved === true);
      const mode = granted && request.ask ? reply.grant ?? request.mode : request.mode;
      if (!['read', 'write'].includes(mode) || mode === 'write' && request.mode !== 'write') throw Error('Invalid access grant');
      const decision = { instanceId: request.instanceId, path: request.path, mode, decision: granted ? 'granted' : 'denied',
        by: request.ask ? reply ? 'human' : 'timeout' : request.by, quote: request.quote, permissions };
      const masks = granted ? await register(decision, request.protected) : null;
      emit('access_decision', decision);
      const shellWarning = masks === null ? '; not added to macOS/Linux shell permissions because the shell exclusions could not be verified' : '';
      return { content: granted ? `Granted ${mode} access to ${request.path}${mode === 'write' ? '; outside writes are not covered by undo' : ''}${shellWarning}` : request.refused ? 'Access refused: read-only role or scranton-state write' : 'Access denied by the human', isError: !granted, details: decision };
    },
  };
}
