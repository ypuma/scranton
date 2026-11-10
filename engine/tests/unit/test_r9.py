"""Second-review guards at the prompt, node, gateway and filesystem boundaries."""
import json
import os
import subprocess
import sys
from types import SimpleNamespace

import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from test_grounding import grounded as grounded  # noqa: PLC0414
from test_grounding import items, kinds

from scranton_pipeline.agents.gateway import ChatModelGateway
from scranton_pipeline.agents.prompts import bounded, fresh_evidence
from scranton_pipeline.demo.fixture import EDIT, PLAN
from scranton_pipeline.evals.evolve import evolve
from scranton_pipeline.models import Review
from scranton_pipeline.nodes import grounding, workflow
from scranton_pipeline.observability import _rows
from scranton_pipeline.procedure import GraphEdit, rejection_row, skeleton
from scranton_pipeline.tools.fs import write_bytes_atomic


def test_a_truncated_python_read_never_waives_overwrite(grounded):
    state, deps = grounded
    (deps.workspace / 'calculator.py').write_text('#' + 'x' * 25000)
    evidence = [{**i, 'python_read': True} for i in items(state, deps)]
    assert evidence[0]['truncated']
    prompt = bounded('implementer', {}, evidence, deps.cfg)
    raw = {'kind': 'edits', 'edits': [{'action': 'modify', 'path': 'calculator.py', 'content': 'x = 1\n'}]}
    result = grounding.evaluate(state, deps, 'implementer', prompt, raw)
    assert kinds(result) == {'unseen_edit'}
    assert 'replacements' in result.violations[0]['detail']
    for edit in (EDIT['edits'][0], {'action': 'delete', 'path': 'calculator.py'}):
        assert not grounding.evaluate(state, deps, 'implementer', prompt, {'edits': [edit]}).violations
    omitted = bounded('implementer', {'bulk': 'x' * 200000}, evidence, deps.cfg)
    for edit in (EDIT['edits'][0], {'action': 'delete', 'path': 'calculator.py'}):
        assert kinds(grounding.evaluate(state, deps, 'implementer', omitted, {'edits': [edit]})) == {'unseen_edit'}


def test_a_python_reads_survive_model_context_and_dedup(grounded):
    state, deps = grounded
    own = [{**i, 'python_read': True} for i in items(state, deps)]
    model = [{**own[0], 'python_read': False, 'request': {'kind': 'read', 'path': f'model{n}.py'}, 'content': 'x' * 2000, 'evidence_id': f'E-{n:010x}'} for n in range(30)]
    state['step_evidence'] = [*own, *items(state, deps)]
    refreshed = fresh_evidence(state, deps.cfg, 'step_evidence')
    assert refreshed[0].get('python_read')
    cfg = deps.cfg.model_copy(update={'limits': deps.cfg.limits.model_copy(update={'max_prompt_bytes': 10000})})
    prompt = bounded('implementer', {}, [*own, *model], cfg)
    assert own[0]['evidence_id'] in prompt.shown
    state['step_evidence'] = own
    state['step_requests'] = [{'kind': 'read', 'path': 'bulk.py'}]
    (deps.workspace / 'bulk.py').write_text('x' * 25000)
    deps.cfg = cfg
    update = workflow.context(state, deps, planner=False)
    assert any(i.get('python_read') for i in update['step_evidence'])


def test_b_review_own_not_met_repairs(grounded, monkeypatch):
    state, deps = grounded
    state['plan']['acceptance_criteria'][0]['verified_by'] = 'review'
    raw = Review.model_construct(verdict='approve', summary='contradiction', criteria=[SimpleNamespace(id='sum', status='not_met', model_dump=lambda **kw: {'id': 'sum', 'status': 'not_met', 'citations': []})], findings=[])
    # Bypass the gateway validator to independently guard node semantics.
    deps.gateway = SimpleNamespace(complete=lambda *a, **kw: SimpleNamespace(parsed=raw))
    monkeypatch.setattr(workflow, 'diff_info', lambda *a: ('', []))
    result = workflow.review(state, deps)
    assert result.get('review') is None and result['feedback']['kind'] == 'output_invalid'
    assert result['counters'] == {'review_repairs:0': 1}


@pytest.mark.parametrize('payload', [{'criteria': [{'id': 'sum', 'status': 'not_met'}]}, {'findings': [{'severity': 'blocking', 'category': 'tests', 'description': 'broken'}]}])
def test_b_review_schema_rejects_contradiction(payload):
    with pytest.raises(ValueError, match='contradicts'):
        Review(verdict='approve', summary='contradiction', **payload)


@pytest.mark.parametrize('subject', ['picture.bin', 'folder', 'absent.txt'])
def test_c_missing_file_uses_names_not_contents(grounded, monkeypatch, subject):
    _, deps = grounded
    (deps.workspace / 'picture.bin').write_bytes(b'\0\xff')
    (deps.workspace / 'folder').mkdir()
    (deps.workspace / 'large.txt').write_text('x' * 100)
    deps.cfg = deps.cfg.model_copy(update={'limits': deps.cfg.limits.model_copy(update={'max_file_bytes': 10})})
    monkeypatch.setattr(grounding, 'read_text', lambda *a: pytest.fail('missing_file read contents'))
    result = grounding.absence({'kind': 'missing_file', 'subject': subject}, deps)
    assert result['status'] == ('verified' if subject == 'absent.txt' else 'refuted')


@pytest.mark.parametrize('kind', ['missing_file', 'missing_symbol'])
def test_f_empty_search_is_unverifiable(grounded, kind):
    _, deps = grounded
    result = grounding.absence({'kind': kind, 'subject': 'anything', 'paths': ['nothing/*.py']}, deps)
    assert result['files_searched'] == 0 and result['status'] == 'unverifiable'


@pytest.mark.parametrize('guided', [False, True])
def test_d_gateway_keeps_exact_prompt_allowance(grounded, monkeypatch, guided):
    _, deps = grounded
    cfg = deps.cfg.model_copy(update={'procedure': deps.cfg.procedure.model_copy(update={'enabled': guided})})
    base = bounded('planner', {'bulk': 'x' * 1000}, [], cfg)
    cfg = cfg.model_copy(update={'limits': cfg.limits.model_copy(update={'max_prompt_bytes': len((base.system + base.user).encode())})})
    prompt = bounded('planner', {'bulk': 'x' * 1000}, [], cfg, guidance='Procedural guidance (advisory)\nRead first.')
    seen = []
    model = FakeListChatModel(responses=[json.dumps(PLAN)])
    original = FakeListChatModel.invoke
    def capture(self, messages, **kw):
        seen.append(messages)
        return original(self, messages, **kw)
    monkeypatch.setattr(FakeListChatModel, 'invoke', capture)
    gateway = ChatModelGateway({'planner': model}, cfg, deps.ledger, deps.events)
    from scranton_pipeline.models import PlannerTurn
    gateway.complete('planner', system=prompt.system, user=prompt.user, schema=PlannerTurn, guidance_bytes=prompt.guidance_bytes)
    assert seen[0][1].content == prompt.user
    assert str(seen[0][1].content).endswith('<<<END>>>\n') or str(seen[0][1].content).endswith('<<<END>>>')
    if guided:
        assert 'Read first.' in seen[0][1].content
    else:
        assert seen[0][1].content == base.user


def test_e_full_rejected_round_and_prompt_edit_budget(grounded):
    _, deps = grounded
    edit = GraphEdit(delete_nodes=['done'] * 60, rationale='x' * 400)
    seen = []
    def refine(text):
        seen.append(json.loads(text))
        return edit
    evolve(skeleton(), deps.run_dir / 'evolve', rollout=lambda *a: [{'adjusted': 1}], refine=refine, rounds=2)
    for name in ('rejected.jsonl', 'evolution.jsonl'):
        row = _rows(deps.run_dir / 'evolve' / name)[0]
        assert row['edit'] == edit.model_dump(mode='json', by_alias=True)
        assert 'candidate' in row and row['candidate_digest'] is None
    row = rejection_row({'round': 1, 'edit': {'rationale': 'x' * 1200}, 'candidate': {'bulk': 'x' * 5000}, 'reason': 'invalid', 'diagnostics': []})
    assert len(json.dumps(row).encode()) <= 2048
    assert 'x' * 1200 in json.dumps(row['edit'])
    assert seen[1]['rejected']


@pytest.mark.skipif(os.name != 'nt', reason='Windows delete-sharing semantics')
@pytest.mark.parametrize('relative', ['status.json', 'artifacts/plan.json'])
def test_g_second_process_without_delete_sharing(tmp_path, relative):
    target = tmp_path / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b'old')
    script = tmp_path / 'holder.py'
    script.write_text('''import ctypes, sys, time
from ctypes import wintypes
k = ctypes.WinDLL('kernel32', use_last_error=True)
k.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
k.CreateFileW.restype = wintypes.HANDLE
k.CloseHandle.argtypes = [wintypes.HANDLE]
h = k.CreateFileW(sys.argv[1], 0x80000000, 3, None, 3, 0, None)
assert h != wintypes.HANDLE(-1).value, ctypes.get_last_error()
print('held', flush=True)
time.sleep(.6)
k.CloseHandle(h)
''')
    process = subprocess.Popen([sys.executable, str(script), str(target)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert process.stdout.readline().strip() == 'held'
        write_bytes_atomic(target, b'new')
        assert target.read_bytes() == b'new'
    finally:
        process.communicate(timeout=10)
    assert process.returncode == 0
    assert not list(target.parent.glob('.pipeline-*'))


def test_g_suspension_warning_and_log_are_diagnosable(grounded, monkeypatch, caplog):
    from scranton_pipeline import runner
    state, deps = grounded
    secret = 'very-private-token-value'
    from scranton_pipeline.tools.secrets import Redactor
    deps.redactor = Redactor([secret])
    def invoke(*args, **kwargs):
        write_bytes_atomic(deps.run_dir / 'status.json', b'new')
    error = PermissionError(13, secret, str(deps.run_dir / 'status.json'))
    error.winerror = 5
    from scranton_pipeline.tools import fs
    monkeypatch.setattr(fs.os, 'replace', lambda *a: (_ for _ in ()).throw(error))
    monkeypatch.setattr(fs.time, 'sleep', lambda *a: None)
    monkeypatch.setattr(runner, 'build_graph', lambda *a: SimpleNamespace(get_state=lambda *a: SimpleNamespace(values=state, next=('plan',)), invoke=invoke))
    monkeypatch.setattr(runner, 'write_status', lambda *a: None)
    monkeypatch.setattr(runner, 'make_status', lambda *a, **kw: kw)
    result = runner.drive(deps)
    assert result['status'] == 'suspended'
    row = [r for r in _rows(deps.run_dir / 'events.jsonl') if r['type'] == 'warning'][-1]['data']
    assert row['errno'] == 13 and row['winerror'] == 5
    assert row['engine_frame'] == 'scranton_pipeline.tools.fs:write_bytes_atomic'
    assert 'status.json' in row['exception_message']
    assert str(deps.run_dir) not in row['exception_message'] and secret not in row['exception_message']
    assert 'status.json' in caplog.text and secret not in caplog.text and str(deps.run_dir) not in caplog.text


def test_g_retry_exhaustion_raises_original_error(tmp_path, monkeypatch):
    from scranton_pipeline.tools import fs
    first = PermissionError(13, 'held')
    first.winerror = 5
    calls, sleeps = [], []
    def replace(*a):
        calls.append(a)
        error = first if len(calls) == 1 else PermissionError(13, 'still held')
        error.winerror = 5
        raise error
    monkeypatch.setattr(fs.os, 'replace', replace)
    monkeypatch.setattr(fs.time, 'sleep', sleeps.append)
    with pytest.raises(PermissionError) as caught:
        write_bytes_atomic(tmp_path / 'status.json', b'new')
    assert caught.value is first
    assert len(calls) == (41 if os.name == 'nt' else 1)
    assert sum(sleeps) <= 2.01
    assert not list(tmp_path.glob('.pipeline-*'))
