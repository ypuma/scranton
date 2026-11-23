import json
import sys
import threading

import pytest
from pydantic import ValidationError

from scranton_pipeline.cli import main
from scranton_pipeline.config import EngineConfig, SandboxConfig, config_digest, load_config
from scranton_pipeline.demo.fixture import config, run_demo
from scranton_pipeline.errors import EngineError
from scranton_pipeline.observability import _rows
from scranton_pipeline.runner import resume
from scranton_pipeline.tools import native_sandbox as native
from scranton_pipeline.tools.fs import SANDBOX_MARKER, PathPolicy
from scranton_pipeline.tools.git import WorkspaceRepo
from scranton_pipeline.tools.process import StopSignal
from scranton_pipeline.tools.snapshot import snapshot_source

FAKE = r'''
import json, os, sys, subprocess
from pathlib import Path
verb, protocol, version, *args = sys.argv[1:]
assert protocol == '--protocol' and version == '1'
flags = dict(zip(args[::2], args[1::2]))
assert 'NODE_OPTIONS' not in os.environ and 'SCRANTON_PIPELINE_KEY_TEST' not in os.environ

def reply(**fields):
    print(json.dumps(dict(protocol=1, **fields)))

if verb == 'probe':
    mode = flags['--windows-mode']
    reply(available=True, backend='low-integrity' if mode == 'low' else 'appcontainer',
          windows_mode=mode, check_network='allow' if mode == 'low' else 'none',
          setup_network_allowed=mode == 'low', reason=None)
elif verb == 'allocate':
    p = Path(flags['--path']); p.mkdir()
    marker = '.scranton-sandbox-owned'
    (p / marker).write_text('scranton-sandbox-v1')
    p.with_name('.scranton-sandbox-allocation-' + p.name + '.json').write_text('{}')
    reply(path=str(p), marker=marker)
elif verb == 'recover':
    Path(flags['--record']).unlink()
    reply(recovered=True)
else:
    request = json.loads(Path(flags['--request']).read_text())
    assert Path(request['argv'][0]).is_absolute()
    assert 'SCRANTON_PIPELINE_KEY_TEST' not in request['env']
    assert request['deadline_ms'] > 1500
    action = request['argv'][1] if len(request['argv']) > 1 else ''
    receipt = Path(request['receipt'])
    value = dict(protocol=1, state='exited', code=0, error=None)
    if action == 'missing':
        print(json.dumps(value))
        sys.exit(0)
    if action == 'bad-version': value['protocol'] = 2
    if action == 'bad-code': value['code'] = False
    if action == 'bad-error': value.update(state='error', code=None, error={'code':'launch', 'message':'RAW CONTROL DIAGNOSTIC'})
    if action == 'not-zero': sys.exit(7)
    if action == 'wait':
        sys.stdin.buffer.read()
        value.update(state='stopped', code=None)
        print('control EOF')
    if action == 'stopped': value.update(state='stopped', code=None)
    if action == 'timed-out': value.update(state='timed_out', code=None)
    if action in ('124', '125'): value['code'] = int(action)
    if action == '-m':
        value['code'] = subprocess.run(request['argv'], cwd=request['cwd'], env=request['env']).returncode
    tmp = receipt.with_suffix('.tmp'); tmp.write_text(json.dumps(value)); tmp.replace(receipt)
'''


@pytest.fixture
def fake(tmp_path, monkeypatch):
    # Platform is patched at probe/run only; actual subprocess and filesystem still use the test host.
    monkeypatch.setattr(native, "sys", type("Windows", (), {"platform": "win32"}))
    script = tmp_path / "fake.py"
    script.write_text(FAKE, encoding="utf-8")
    monkeypatch.setenv(native.BINDING, json.dumps([sys.executable, str(script)]))
    monkeypatch.setenv("NODE_OPTIONS", "not projected")
    monkeypatch.setenv("SCRANTON_PIPELINE_KEY_TEST", "not projected")
    return tmp_path


@pytest.fixture
def box(fake):
    sandbox = native.NativeSandbox(SandboxConfig(), fake / "work", fake / "run")
    sandbox.preflight()
    sandbox.allocate()
    return sandbox


@pytest.mark.parametrize("raw", [None, "bad", "[]", '["node", "bridge.js"]', '["Z:/missing.exe", "Z:/missing.js"]'])
def test_missing_binding(fake, monkeypatch, raw):
    if raw is None:
        monkeypatch.delenv(native.BINDING)
    else:
        monkeypatch.setenv(native.BINDING, raw)
    result = native.probe_native("low", fake)
    assert result["available"] is False and result["reason"].startswith("runner_missing:")


@pytest.mark.parametrize("action", ["missing", "bad-version", "bad-code", "bad-error", "not-zero"])
def test_invalid_or_error_receipt(box, action):
    with pytest.raises(EngineError) as caught:
        box.run([sys.executable, action], timeout_s=3, log_path=box.control / "log")
    assert caught.value.code == "sandbox_failed"
    assert "RAW CONTROL DIAGNOSTIC" not in str(caught.value)
    assert list(box.control.glob("call-*")) == []


@pytest.mark.parametrize("code", [124, 125])
def test_exit_codes_are_literal(box, code):
    result = box.run([sys.executable, str(code)], timeout_s=3, log_path=box.control / "log")
    assert (result.exit_code, result.stopped, result.timed_out) == (code, False, False)


@pytest.mark.parametrize("cancel", [False, True])
def test_engine_stop_or_timeout_closes_control_stdin(box, cancel):
    stop = StopSignal(box.control / "cancel")
    timer = threading.Timer(.7, stop.cancel_file.touch)
    if cancel:
        timer.start()
    try:
        result = box.run([sys.executable, "wait"], timeout_s=4 if cancel else 1.2,
                         log_path=box.control / "log", stop=stop)
    finally:
        timer.cancel()
    assert (result.exit_code, result.stopped, result.timed_out) == (None, cancel, not cancel)
    assert "control EOF" in result.output_tail


def test_output_not_closed_kept(box, monkeypatch):
    def broken(*args, **kwargs):
        raise EngineError(native.FailureClass.INFRASTRUCTURE, "output_not_closed", "Process output did not close")
    monkeypatch.setattr(native, "run_process", broken)
    with pytest.raises(EngineError) as caught:
        box.run([sys.executable], timeout_s=3, log_path=box.control / "log")
    assert caught.value.code == "output_not_closed"


def test_recovery_is_scoped_to_run(box):
    call = box.control / "call-orphan"
    call.mkdir()
    (call / "record.json").write_text("{}")
    sibling = box.control.parent.parent / "unrelated-record.json"
    sibling.write_text("{}")
    box.cleanup()
    assert not call.exists() and sibling.read_text() == "{}"


def test_marker_excluded_from_snapshot_git_and_copy(box):
    from scranton_pipeline.nodes.parallel import copy_workspace
    source = box.workspace.parent / "source"
    source.mkdir()
    (source / "file.py").write_text("x = 1\n")
    (source / SANDBOX_MARKER.upper()).write_text("forged")
    (source / ".gitignore").write_text("!.scranton-sandbox-owned\n")
    cfg = config(box.control.parent)
    result = snapshot_source(source, box.workspace, policy=cfg.policy, limits=cfg.limits,
                             manifest_path=box.control / "source.json", allocated=True)
    assert result.files == 2
    assert (box.workspace / SANDBOX_MARKER).read_text() == "scranton-sandbox-v1"
    repo = WorkspaceRepo.init(box.workspace)
    repo.commit_all("snapshot")
    assert SANDBOX_MARKER not in repo._run(["ls-files"])
    repo.reset_hard(repo.head())
    assert (box.workspace / SANDBOX_MARKER).is_file()
    policy = PathPolicy(box.workspace, (), ())
    assert policy.is_write_protected(SANDBOX_MARKER) and policy.is_protected("nested/" + SANDBOX_MARKER.upper())
    target = box.workspace.with_name("lane")
    lane = native.NativeSandbox(box.cfg, target, box.control.parent)
    copy_workspace(box.workspace, target, lane)
    lane.verify_ownership()
    assert (target / "file.py").is_file()


def test_strict_network_validation(tmp_path, capsys):
    cfg = config(tmp_path, windows_mode="strict").model_dump(mode="json", by_alias=True)
    cfg["setup"] = [{"id": "offline", "argv": ["python"]}, {"id": "online", "argv": ["python"], "network": True}]
    with pytest.raises(ValidationError, match=r"setup\[1\]\.network"):
        EngineConfig.model_validate(cfg)
    path = tmp_path / "config.json"
    path.write_text(json.dumps(cfg))
    assert main(["run", "--config", str(path), "--task", "test", "--source", str(tmp_path), "--run-root", str(tmp_path / "runs")]) == 2
    assert "setup[1].network" in json.loads(capsys.readouterr().out)["failure"]["message"]
    cfg["sandbox"]["windows_mode"] = "low"
    assert EngineConfig.model_validate(cfg).setup[1].network


@pytest.mark.parametrize("name", ["node_options", "NODE_PATH", "SCRANTON_SANDBOX_HELPER", "MY_API_KEY", "PI_CODING_AGENT_DIR", "\u017fCRANTON_X"])
def test_native_rejects_disallowed_passthrough_before_execution(tmp_path, name):
    cfg = config(tmp_path).model_dump(mode="json", by_alias=True)
    cfg["sandbox"]["env_passthrough"] = [name]
    path = tmp_path / "config.json"
    path.write_text(json.dumps(cfg))
    with pytest.raises(EngineError, match=rf"env_passthrough.*{name}"):
        load_config(path)
    cfg["sandbox"]["mode"] = "host"
    assert EngineConfig.model_validate(cfg).sandbox.env_passthrough == [name]


def test_cli_native_probe_does_not_sweep_docker(fake, monkeypatch, capsys):
    from scranton_pipeline.tools import sandbox
    monkeypatch.setattr(sandbox, "sweep_expired", lambda: pytest.fail("unexpected Docker sweep"))
    assert main(["sandbox", "check", "--mode", "scranton"]) == 0
    result = json.loads(capsys.readouterr().out)["native"]
    assert result["platform"] == "win32" and result["low"]["check_network"] == "allow"
    assert result["strict"]["check_network"] == "none"
    assert main(["sandbox", "check", "--mode", "scranton", "--windows-mode", "strict"]) == 0
    assert set(json.loads(capsys.readouterr().out)["native"]) == {"platform", "strict"}


def test_status_and_events(fake, monkeypatch):
    good = run_demo(fake, run_id="native001")
    assert good.status == "awaiting_approval"
    assert good.sandbox == {"mode": "scranton", "windows_mode": "low", "image": None, "backend": "low-integrity",
                            "isolated": True, "check_network": "allow", "setup_network": False}
    directory = fake / good.run_id
    ready = [r["data"] for r in _rows(directory / "events.jsonl") if r["type"] == "sandbox_ready"]
    assert ready == [{k: good.sandbox[k] for k in ("mode", "backend", "windows_mode", "check_network")}]
    monkeypatch.delenv(native.BINDING)
    assert good.pending
    failed = resume(directory, gate="plan", digest=good.pending["digest"], decision="approve")
    assert failed.status == "failed" and failed.failure["code"] == "sandbox_failed"
    errors = [r["data"] for r in _rows(directory / "events.jsonl") if r["type"] == "sandbox_failed"]
    assert len(errors) == 1 and errors[0]["message"].startswith("runner_missing:")


@pytest.mark.parametrize(("mode", "digest"), [
    ("host", "c6728c16977f90ea2d80fcb7b2a80f07a4cdd511c6b2fcd284a6b5b121305f08"),
    ("docker", "9638a139f74f059e627fab52a49af06c85e3481db89ed0f1c1a699d83e2fdefb"),
])
def test_previous_config_digest_and_terminal_resume(tmp_path, mode, digest):
    # Digests measured before adding windows_mode. Old persisted sandbox had no such member.
    fixture = {"models": {r: {"provider": "scripted", "script_path": "legacy.json"}
                          for r in ("planner", "implementer", "reviewer")},
               "sandbox": {"mode": mode}, "allow_no_checks": True}
    path = tmp_path / "config.json"
    path.write_text(json.dumps(fixture))
    cfg = load_config(path)
    assert "windows_mode" not in cfg.model_dump()["sandbox"]
    assert config_digest(cfg) == digest
    (tmp_path / "run.json").write_text(json.dumps({"workspace": str(tmp_path / "workspace"), "config_digest": digest}))
    from scranton_pipeline.models import RunStatus
    from scranton_pipeline.observability import read_status, write_status
    actual = run_demo(tmp_path, sandbox="host", run_id="legacy001")
    stored: RunStatus | None = read_status(tmp_path / actual.run_id)
    assert stored
    write_status(tmp_path, stored.model_copy(update={"status": "succeeded", "pending": None}))
    assert resume(tmp_path, trust_host=(mode == "host")).status == "succeeded"
