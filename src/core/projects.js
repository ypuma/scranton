import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { sleepSync, writeFileAtomicSync } from './util.js';
import { readRunLease } from './run-lease.js';
import { cleanupIsolationStorage } from './worktree.js';
import { createDreaming } from './dreaming/index.js';
import { createDreamingSources } from './dreaming-sources.js';
import { createDreamingReflectionSources } from './dreaming-reflection-sources.js';
import { completeDreaming } from './dreaming-completion.js';

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });
export function validateId(id) {
  if (typeof id !== 'string' || !ID.test(id) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id)) throw fail(400, 'Invalid ID');
  return id;
}
function label(value, max, fallback) {
  value ??= fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw fail(400, 'Invalid name or title');
  return value.trim();
}
export const derivedChatTitle = (request) => request.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ').trim().slice(0, 60) || 'New chat';
const key = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
const within = (p, root) => key(p) === key(root) || key(p).startsWith(key(root) + path.sep);
function canonical(p) {
  if (fs.existsSync(p)) return fs.realpathSync.native(p);
  return path.join(canonical(path.dirname(p)), path.basename(p));
}
function read(file, optional = false) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid metadata');
    return value;
  }
  catch (err) { if (optional && err.code === 'ENOENT') return null; throw fail(409, 'Corrupt registry metadata; file was not changed'); }
}
const write = (file, value) => writeFileAtomicSync(file, JSON.stringify(value, null, 2) + '\n');

export function createProjectRegistry({ dataDir, projectsRoot = path.join(os.homedir(), 'Documents', 'Scranton', 'projects') } = {}) {
  if (!dataDir) throw fail(400, 'Data directory required');
  const data = path.resolve(dataDir);
  fs.mkdirSync(data, { recursive: true });
  const realData = fs.realpathSync.native(data);
  const file = path.join(data, 'projects.json');
  const lock = path.join(data, '.registry-lock');
  function locked(fn) {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const fd = fs.openSync(lock, 'wx');
        try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try {
          const stat = fs.statSync(lock);
          const raw = fs.readFileSync(lock, 'utf8');
          let owner;
          try { owner = JSON.parse(raw); } catch { if (raw.trim()) throw fail(409, 'Corrupt registry lock'); }
          let stale = !raw.trim() && Date.now() - stat.mtimeMs > 30000;
          if (Number.isInteger(owner?.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); } catch (e) { stale = e.code === 'ESRCH'; }
          }
          if (stale) {
            const current = fs.statSync(lock);
            if (current.ino === stat.ino && current.mtimeMs === stat.mtimeMs && fs.readFileSync(lock, 'utf8') === raw) fs.rmSync(lock, { force: true });
            continue;
          }
        } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        if (Date.now() >= deadline) throw fail(409, 'Registry is busy');
        sleepSync(20);
      }
    }
    try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
  }
  function safePath(...parts) {
    const target = path.join(data, 'projects', ...parts);
    if (!within(canonical(target), realData)) throw fail(409, 'Registry path escapes data directory');
    return target;
  }
  function listProjects() {
    const record = read(file, true);
    if (!record) return [];
    if (record.v !== 1 || !Array.isArray(record.projects)) throw fail(409, 'Corrupt projects.json');
    const ids = new Set(), workspaces = new Set();
    for (const p of record.projects) {
      if (!p || !ID.test(p.id) || typeof p.name !== 'string' || !p.name.trim() || typeof p.workspace !== 'string' || !path.isAbsolute(p.workspace) || typeof p.createdAt !== 'string' || ids.has(p.id) || workspaces.has(key(p.workspace))) throw fail(409, 'Corrupt projects.json');
      ids.add(p.id); workspaces.add(key(p.workspace));
    }
    return record.projects;
  }
  function getProject(id) {
    validateId(id);
    const project = listProjects().find((p) => p.id === id);
    if (!project) throw fail(404, 'Project not found');
    return project;
  }
  function listChats(projectId) {
    getProject(projectId);
    const dir = safePath(projectId, 'chats');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((id) => ID.test(id)).flatMap((id) => {
      try {
        const chat = read(path.join(safePath(projectId, 'chats', id), 'chat.json'), true);
        if (!chat) return [];
        if (chat.id !== id || chat.projectId !== projectId || typeof chat.title !== 'string' || typeof chat.hiveDir !== 'string' || !path.isAbsolute(chat.hiveDir) || typeof chat.createdAt !== 'string' || typeof chat.updatedAt !== 'string') throw fail(409, 'Corrupt chat metadata');
        return [chat];
      } catch { return [{ id, projectId, title: 'Unreadable chat', error: 'Corrupt chat metadata', hiveDir: safePath(projectId, 'chats', id, 'hive'), createdAt: '', updatedAt: null }]; }
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  function getChat(projectId, id) {
    validateId(id);
    const chat = listChats(projectId).find((c) => c.id === id);
    if (!chat) throw fail(404, 'Chat not found');
    if (chat.error) throw fail(409, chat.error);
    return chat;
  }
  function workspacePath(workspace, create) {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw fail(400, 'Workspace must be absolute');
    const real = canonical(path.resolve(workspace));
    const forbidden = [path.parse(real).root, os.homedir(), process.env.WINDIR].filter(Boolean).map((p) => canonical(path.resolve(p)));
    if (within(real, realData) || within(realData, real) || within(canonical(path.join(os.homedir(), '.pi')), real) || within(real, canonical(path.join(os.homedir(), '.pi'))) || forbidden.some((p) => key(real) === key(p)) || (process.env.WINDIR && within(real, canonical(process.env.WINDIR)))) throw fail(400, 'Forbidden workspace');
    if (!fs.existsSync(real)) {
      if (!create) throw fail(400, 'Workspace does not exist');
      fs.mkdirSync(real, { recursive: true });
    }
    if (!fs.statSync(real).isDirectory()) throw fail(400, 'Workspace must be a directory');
    return fs.realpathSync.native(real);
  }
  function addProject({ name, workspace, create = false } = {}) {
    return locked(() => {
      const projects = listProjects();
      name = label(name, 120);
      if (typeof create !== 'boolean') throw fail(400, 'Invalid create');
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 25) || 'project';
      const id = `${slug}-${randomUUID().slice(0, 8)}`;
      const ws = workspacePath(workspace ?? path.join(projectsRoot, id), create || workspace === undefined);
      if (projects.some((p) => within(canonical(p.workspace), ws) || within(ws, canonical(p.workspace)))) throw fail(409, 'Workspace already registered or nested');
      const project = { id, name, workspace: ws, createdAt: new Date().toISOString() };
      write(file, { v: 1, projects: [...projects, project] });
      return project;
    });
  }
  function renameProject(id, name) {
    return locked(() => {
      getProject(id); name = label(name, 120);
      const projects = listProjects().map((p) => p.id === id ? { ...p, name } : p);
      write(file, { v: 1, projects }); return projects.find((p) => p.id === id);
    });
  }
  function createChat(projectId, { title, hiveDir, engine } = {}) {
    return locked(() => {
      getProject(projectId);
      if (engine !== undefined && engine !== 'pipeline') throw fail(400, 'Invalid chat engine');
      const id = randomUUID();
      const now = new Date().toISOString();
      const chat = { id, projectId, ...(engine ? { engine } : {}), title: label(title, 120, 'New chat'), hiveDir: hiveDir ? path.resolve(hiveDir) : safePath(projectId, 'chats', id, 'hive'), createdAt: now, updatedAt: now };
      write(path.join(safePath(projectId, 'chats', id), 'chat.json'), chat); return chat;
    });
  }
  function updateChat(projectId, id, changes) {
    return locked(() => {
      const chat = getChat(projectId, id);
      if (changes.title !== undefined) chat.title = label(changes.title, 120);
      chat.updatedAt = new Date().toISOString();
      write(path.join(safePath(projectId, 'chats', id), 'chat.json'), chat); return chat;
    });
  }
  function removeChat(projectId, id, isRunning = () => false) {
    return locked(() => {
      const chat = getChat(projectId, id);
      if (readRunLease(chat.hiveDir) || isRunning(chat)) throw fail(409, 'Chat is running or requires recovery');
      try { cleanupIsolationStorage(chat.hiveDir); }
      catch (err) { throw fail(409, `Cannot remove chat isolation storage: ${err.message}`); }
      fs.rmSync(path.join(safePath(projectId, 'chats', id), 'chat.json'));
    });
  }
  function removeProject(id, { deleteHistory = false, isRunning = () => false } = {}) {
    return locked(() => {
      getProject(id);
      if (typeof deleteHistory !== 'boolean') throw fail(400, 'Invalid deleteHistory');
      if (listChats(id).some((c) => c.error || readRunLease(c.hiveDir) || isRunning(c))) throw fail(409, 'Project has running chats or requires recovery');
      if (deleteHistory) {
        for (const chat of listChats(id)) {
          try { cleanupIsolationStorage(chat.hiveDir); }
          catch (err) { throw fail(409, `Cannot remove project isolation storage: ${err.message}`); }
        }
      }
      write(file, { v: 1, projects: listProjects().filter((p) => p.id !== id) });
      if (deleteHistory) fs.rmSync(safePath(id), { recursive: true, force: true });
    });
  }
  // Called only for desktop startup; existing history stays exactly where it is.
  function importLegacy(workspace) {
    if (fs.existsSync(file) || !fs.existsSync(path.join(data, 'hive'))) return;
    locked(() => {
      if (fs.existsSync(file)) return;
      const project = { id: 'scranton', name: 'Scranton', workspace: workspacePath(workspace, true), createdAt: new Date().toISOString() };
      const chat = { id: 'legacy', projectId: project.id, title: 'Previous runs', hiveDir: path.join(data, 'hive'), createdAt: project.createdAt, updatedAt: project.createdAt };
      write(path.join(safePath(project.id, 'chats', chat.id), 'chat.json'), chat);
      write(file, { v: 1, projects: [project] });
    });
  }
  function dreaming(projectId, options = {}) {
    getProject(projectId);
    const source = createDreamingSources({ dataDir: data, projectId });
    const reflection = createDreamingReflectionSources({ dataDir: data, projectId });
    return createDreaming({ dataDir: data, projectId, collect: source.collect, collectReflection: reflection.collectReflection,
      completeReflection: options.completeReflection ?? ((request) => completeDreaming({ ...request, dataDir: data })), isBusy: () => source.isBusy() || Boolean(options.isBusy?.()), ...(options.now ? { now: options.now } : {}) });
  }
  return { dreaming, dataDir: data, locked, listProjects, getProject, addProject, renameProject, removeProject, listChats, getChat, createChat, updateChat, removeChat, importLegacy };
}
