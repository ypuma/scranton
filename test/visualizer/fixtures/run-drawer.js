// The New run drawer with the real model picker and a fake server, for the Workflow and model tests.
import { createControlPanel } from '../../../visualizer/public/js/control-panel.js';
import { createModelPicker } from '../../../visualizer/public/js/accounts-panel.js';
import { createState } from '../../../visualizer/public/js/state.js';
import { WORKFLOW_KEY } from '../../../visualizer/public/js/control.js';
import { installDom } from './fake-dom.js';

export const CATALOG = { providers: [{ id: 'openai', label: 'ChatGPT', signedIn: true, models: [{ id: 'gpt-a', name: 'GPT A' }] }] };
export const CONTROL = {
  v: 1, enabled: true, workspace: 'C:\\work\\core', scenarios: ['happy'], run: null, lastExit: null, pendingHuman: null, instances: {}, recoveryRequired: false,
};

export function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

// stored: the workflow kept from before (a value to stringify, or { raw } text); reject: the 400 message of a POST.
// server.control may be swapped between polls. catalog: GET /api/models (null: it fails with a 500).
// agents: the Agents drawer is available; agentsOpened counts its opens from the model picker.
export function harness({ reject = null, stored, control = CONTROL, models: storedModels, catalog = CATALOG, agents = false } = {}) {
  const $ = installDom();
  const initial = {};
  if (stored !== undefined) initial[WORKFLOW_KEY] = typeof stored?.raw === 'string' ? stored.raw : JSON.stringify(stored);
  if (storedModels) initial['scranton.models'] = JSON.stringify(storedModels);
  const storage = fakeStorage(initial);
  globalThis.localStorage = storage;
  const posts = [];
  const server = { control };
  globalThis.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      posts.push({ url, body: JSON.parse(opts.body) });
      return reject ? { ok: false, status: 400, json: async () => ({ error: reject }) } : { ok: true, status: 202, json: async () => ({ pid: 9 }) };
    }
    if (url === '/api/models') return catalog ? { ok: true, status: 200, json: async () => catalog } : { ok: false, status: 500, json: async () => null };
    return { ok: true, status: 200, json: async () => structuredClone(server.control) };
  };
  const opened = { agents: 0 };
  const models = createModelPicker({
    openAccounts() {}, canOpenAccounts: () => false, openAgents: () => { opened.agents += 1; }, canOpenAgents: () => agents,
  });
  const stub = { setHumanWhere() {}, setRunMode() {} };
  const panel = createControlPanel({ dashboard: stub, pipeline: stub, lanes: stub, models, getState: () => createState(), url: (s) => `/api/projects/core/chats/a/${s}` });
  const tick = () => new Promise((r) => setTimeout(r, 10));
  // one gate row: its check box, its stage number and its name
  const row = (id) => {
    const li = $('f-gate-list').childNodes.find((n) => n.dataset.gate === id);
    return li && { li, box: li.childNodes[0].childNodes[0], stage: li.childNodes[1].childNodes[1], name: li.childNodes[0].childNodes[1].childNodes[0] };
  };
  const ids = () => $('f-gate-list').childNodes.map((n) => n.dataset.gate);
  const toggle = (id, on) => {
    row(id).box.checked = on;
    return row(id).box.fire('change');
  };
  const stage = (id, n) => {
    row(id).stage.value = String(n);
    return row(id).stage.fire('input');
  };
  // { id: stage, 0 when off } as the rows show it
  const shown = () => Object.fromEntries(ids().map((id) => [id, row(id).box.checked ? Number(row(id).stage.value) : 0]));
  const select = (role) => models.field(role);
  const pick = (values) => Promise.all(Object.entries(values).map(([role, v]) => {
    select(role).value = v;
    return select(role).fire('change');
  }));
  const open = async () => {
    panel.setMode('live');
    await tick();
    panel.openRun();
    await tick();
    $('f-request').value = 'Build it';
  };
  // a sandbox as the human picks it: 'scranton' | 'docker' | 'host'; true is the trusted host (acknowledged), false Docker
  const sandbox = async (pick) => {
    const mode = pick === true ? 'host' : pick === false ? 'docker' : pick;
    for (const m of ['scranton', 'docker', 'host']) $(`f-sandbox-${m}`).checked = m === mode;
    await $(`f-sandbox-${mode}`).fire('change');
    $('f-trusted').checked = mode === 'host';
  };
  return { $, panel, models, posts, storage, server, tick, row, ids, toggle, stage, shown, select, pick, open, sandbox, opened };
}
