"""R4 regression guards; each test names the production statement to revert."""
import json
import re
from importlib.resources import files
from types import SimpleNamespace

import pytest

from scranton_pipeline import cli
from scranton_pipeline.config import (
    DEFAULT_PROTECTED,
    DEFAULT_WRITE_PROTECTED,
    CommandConfig,
    Limits,
    Policy,
    SandboxConfig,
)
from scranton_pipeline.demo.fixture import PLAN, REVIEW, config
from scranton_pipeline.errors import EngineError, FailureClass
from scranton_pipeline.models import ContextRequest, FileEdit, Review, RunStatus
from scranton_pipeline.nodes import workflow
from scranton_pipeline.nodes.common import Dependencies
from scranton_pipeline.observability import EventLog, UsageLedger
from scranton_pipeline.report import make_status, write_report
from scranton_pipeline.tools import sandbox as module
from scranton_pipeline.tools.checks import run_checks
from scranton_pipeline.tools.context import fulfil
from scranton_pipeline.tools.fs import PathPolicy
from scranton_pipeline.tools.git import WorkspaceRepo
from scranton_pipeline.tools.patches import validate_and_apply
from scranton_pipeline.tools.process import ProcResult, StopSignal
from scranton_pipeline.tools.sandbox import (
    DockerSandbox,
    HostSandbox,
    default_image,
    sweep_expired,
)
from scranton_pipeline.tools.secrets import Redactor
from scranton_pipeline.tools.snapshot import snapshot_source


def result(code=0, tail=""):
    return ProcResult(code, False, False, 0, tail, len(tail), None)


@pytest.mark.parametrize("rel", [".pipeline/python/bin/python", ".PIPELINE/evil.pth", "nested/.PiPeLiNe/npm/bin/npm"])
def test_state_protected_snapshot_context_edits(tmp_path, rel):
    # Guard: DEFAULT_PROTECTED contains .pipeline/**; all three boundaries share it.
    source, workspace = tmp_path / "source", tmp_path / "workspace"
    source.mkdir()
    target = source / rel
    target.parent.mkdir(parents=True)
    target.write_text("poison")
    copied = snapshot_source(source, workspace, policy=Policy(), limits=Limits(), manifest_path=tmp_path / "manifest")
    assert copied.files == 0 and copied.skipped == [{"path": rel, "reason": "protected"}]
    assert target.read_text() == "poison" and not (workspace / rel).exists()
    target = workspace / rel
    target.parent.mkdir(parents=True)
    target.write_text("poison")
    policy = PathPolicy(workspace, DEFAULT_PROTECTED, DEFAULT_WRITE_PROTECTED)
    items = fulfil([ContextRequest(kind="read", path=rel), ContextRequest(kind="search", query="poison"),
                     ContextRequest(kind="list")], workspace=workspace, policy=policy, files=[rel],
                    limits=Limits(), redactor=Redactor())
    assert not items[0].ok and all("poison" not in i.content and ".pipeline" not in i.content.lower() for i in items)
    with pytest.raises(EngineError) as error:
        validate_and_apply([FileEdit(path=rel, action="modify", content="changed")], workspace=workspace,
                           policy=policy, declared=[rel], scope="strict", undeclared_budget=0, limits=Limits())
    assert error.value.code == "protected_write" and target.read_text() == "poison"


def test_docker_cli_env_is_scrubbed(tmp_path, monkeypatch):
    # Guard: _invoke passes scrubbed_env(os.environ, ()), not the provider environment.
    for key in ("OPENAI_API_KEY", "PIPELINE_TOKEN", "CUSTOM_SECRET", "DOCKER_HOST", "DOCKER_CONTEXT", "PYTHONPATH"):
        monkeypatch.setenv(key, "must-not-reach-docker")
    monkeypatch.setenv("PATH", "kept-path")
    calls = []
    box = DockerSandbox(SandboxConfig(), tmp_path, "12345678", lambda argv, **kw: calls.append(kw) or result())
    box._invoke(["docker", "info"], 2)
    assert calls[0]["env"]["PATH"] == "kept-path"
    assert "must-not-reach-docker" not in calls[0]["env"].values()


def test_mount_deadline_and_setup_state(tmp_path, monkeypatch):
    # Guards: nested :ro mount by default; only writable_state removes it; deadline uses timeout + grace.
    monkeypatch.setattr(module.time, "time", lambda: 1234.25)
    calls = []
    box = DockerSandbox(SandboxConfig(), tmp_path, "12345678", lambda argv, **kw: calls.append(list(argv)) or result())
    for writable in (False, True):
        box.run(["python"], timeout_s=7, log_path=tmp_path / "log", writable_state=writable)
    runs = [c for c in calls if c[1] == "run"]
    assert calls == [part for command in runs for part in (
        command, ["docker", "ps", "-a", "-q", "--filter", f"name=^/{command[command.index('--name') + 1]}$"])]
    assert f"{box.state_dir.resolve()}:/workspace/.pipeline:ro" in runs[0]
    assert f"{box.state_dir.resolve()}:/workspace/.pipeline:rw" in runs[1]
    assert box.state_dir.is_dir() and not box.state_dir.is_relative_to(tmp_path)
    for command in runs:
        assert command[command.index("--log-driver") + 1] == "none"
        assert "scranton.pipeline.deadline=1272" in command


@pytest.mark.parametrize(("code", "tail", "error"), [
    (125, "docker: daemon rejected password=private-value", "docker_failed"),
    (126, "docker: Error response from daemon: exec: permission denied", "executable_not_found"),
    (127, 'docker: Error response from daemon: exec: "missing": executable file not found in $PATH', "executable_not_found"),
    (127, "test script failed", None), (126, "permission denied from my test", None), (1, "test failed", None),
])
def test_docker_failure_classification(tmp_path, code, tail, error):
    # Guard: exit125 infrastructure; 126/127 require Docker's anchored daemon error prefix.
    box = DockerSandbox(SandboxConfig(), tmp_path, "12345678", lambda argv, **kw: result(code, tail))
    if error:
        with pytest.raises(EngineError) as raised:
            box.run(["missing"], timeout_s=1, log_path=tmp_path / "log")
        assert raised.value.code == error and raised.value.failure_class == FailureClass.INFRASTRUCTURE
        assert "private-value" not in str(raised.value)
    else:
        assert box.run(["test"], timeout_s=1, log_path=tmp_path / "log").exit_code == code


def test_checks_keep_docker_infrastructure_out_of_repairs(tmp_path):
    # Guard: run_checks re-raises docker_failed, but records executable_not_found as error.
    cfg = config(tmp_path)
    for code, expected in ((125, "docker_failed"), (127, "executable_not_found")):
        box = DockerSandbox(SandboxConfig(), tmp_path, "12345678", lambda argv, code=code, **kw: result(code,
            "docker: Error response from daemon: executable file not found"))
        if expected == "docker_failed":
            with pytest.raises(EngineError, match="docker:") as error:
                run_checks(cfg.checks, sandbox=box, log_dir=tmp_path, label="check", stop=None)
            assert error.value.code == expected
        else:
            checks = run_checks(cfg.checks, sandbox=box, log_dir=tmp_path, label="check", stop=None)
            assert checks[0].status == "error" and "Cannot start executable" in checks[0].output_tail


def test_expired_sweep_and_own_cleanup(tmp_path, monkeypatch):
    # Guards: ps -a, explicit label+finite expired deadline, rm -f (also removes created containers).
    monkeypatch.setattr(module.time, "time", lambda: 1000)
    rows = ["abcdef123451\tother\t999", "abcdef123452\tother\t1001", "abcdef123453\tother\t",
            "abcdef123454\tother\tnan", "abcdef123455\tother\tbad", "abcdef123456\t\t1",
            "invalid-id\tother\t1", "abcdef123457\tother\tinf"]
    calls = []
    def runner(argv, **kwargs):
        calls.append(list(argv))
        return result(tail="\n".join(rows)) if argv[1] == "ps" else result()
    monkeypatch.setattr(module, "run_process", runner)
    sweep_expired()
    assert calls[0][0:6] == ["docker", "ps", "-a", "--filter", "label=scranton.pipeline.run", "--format"]
    assert calls[1:] == [["docker", "rm", "-f", "abcdef123451"]]
    calls.clear()
    box = DockerSandbox(SandboxConfig(), tmp_path, "12345678", lambda argv, **kw: calls.append(list(argv)) or result(tail="abcdef123456"))
    box.cleanup()
    assert calls == [["docker", "ps", "-a", "-q", "--filter", "label=scranton.pipeline.run=12345678"],
                     ["docker", "rm", "-f", "abcdef123456"]]


@pytest.mark.parametrize("args", [["run"], ["resume"], ["demo"], ["sandbox", "check"]])
def test_cli_start_sweeps_before_dispatch(tmp_path, monkeypatch, capsys, args):
    # Guard: main dispatch calls sweep_expired for every start/resume/demo/check, even host mode.
    calls = []
    monkeypatch.setattr(module, "sweep_expired", lambda: calls.append("sweep"))
    monkeypatch.setattr(module, "check_image", lambda image: {})
    monkeypatch.setattr(cli, "start", lambda **kw: {})
    monkeypatch.setattr(cli, "resume", lambda *a, **kw: {})
    monkeypatch.setattr(cli, "load_config", lambda p: config(tmp_path))
    from scranton_pipeline.demo import fixture
    monkeypatch.setattr(fixture, "run_demo", lambda *a, **kw: {})
    flags = {"run": ["--source", str(tmp_path), "--task", "fix", "--config", "unused", "--run-root", str(tmp_path)],
             "resume": ["--run-dir", str(tmp_path)], "demo": ["--run-root", str(tmp_path)], "sandbox": []}
    assert cli.main([*args, *flags[args[0]]]) == 0
    assert calls == ["sweep"]
    assert json.loads(capsys.readouterr().out) == {}


@pytest.mark.parametrize("image", ["python:3.14", "scranton-sandbox:1.5.0", "registry/scranton-pipeline-sandbox:v1", "scranton-pipeline-sandbox", "scranton-pipeline-sandbox:bad/tag"])
def test_build_refuses_unrelated_tags(image, monkeypatch, capsys):
    # Guard: build_image fullmatch namespace check runs before subprocess/Docker.
    import subprocess
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: pytest.fail("must not build"))
    assert cli.main(["sandbox", "build", "--image", image]) == 2
    answer = json.loads(capsys.readouterr().out)
    assert answer["failure"]["code"] == "invalid_build_image"
    assert "scranton-pipeline-sandbox:<tag>" in answer["failure"]["message"]


def test_image_digest_and_hashed_pip_closure():
    # Guards: both FROM digests and all five exact, hashed pip requirements (no unpinned transitives).
    text = files("scranton_pipeline").joinpath("sandbox_image/Dockerfile").read_text()
    bases = [line for line in text.splitlines() if line.startswith("FROM ")]
    assert len(bases) == 2 and all(re.search(r"@sha256:[a-f0-9]{64}(?: AS node)?$", b) for b in bases)
    assert "--require-hashes -r /tmp/sandbox-requirements.txt" in text
    assert set(re.findall(r"'([a-z]+)==[^']+ --hash=sha256:[a-f0-9]{64}'", text)) == {"pytest", "iniconfig", "packaging", "pluggy", "pygments"}


def dependencies(tmp_path, gateway=None):
    cfg = config(tmp_path, sandbox="docker").model_copy(update={"setup": [CommandConfig(id="deps", argv=["python"], network=True)]})
    return Dependencies(cfg, tmp_path, tmp_path / "workspace", gateway, UsageLedger(tmp_path / "usage.jsonl"),
                        EventLog(tmp_path / "events.jsonl", "12345678", Redactor()), StopSignal(tmp_path / "cancel"), Redactor())


def test_setup_writable_but_checks_default_readonly(tmp_path, monkeypatch):
    # Guard: prepare_workspace's setup run explicitly passes writable_state=True; checked never opts in.
    deps = dependencies(tmp_path)
    source = tmp_path / "source"
    source.mkdir()
    (source / "file").write_text("x")
    calls = []
    box = SimpleNamespace(preflight=lambda: None, run=lambda *a, **kw: calls.append(kw) or result())
    monkeypatch.setattr(workflow, "sandbox", lambda deps: box)
    state = {"source_dir": str(source)}
    update = workflow.prepare_workspace(state, deps)
    assert calls[0]["writable_state"] is True and calls[0]["network"] is True
    def runner(argv, **kw):
        calls.append(list(argv))
        return result()
    monkeypatch.setattr(workflow, "sandbox", lambda deps: DockerSandbox(deps.cfg.sandbox, deps.workspace, "12345678", runner))
    workflow.checked({**state, **update}, deps, baseline=True)
    assert any("/workspace/.pipeline:ro" in arg for arg in calls[1])


def test_status_report_isolation_and_legacy_defaults(tmp_path):
    # Guards: make_status uses full description; write_report includes Docker/setup network limitations.
    deps = dependencies(tmp_path)
    state = {"run_id": "12345678", "task": "fix", "source_dir": str(tmp_path / "source"), "delivery_mode": "patch"}
    status = make_status(state, deps)
    assert status.sandbox["image"] == default_image() and status.sandbox["setup_network"] is True
    text = status.sandbox["isolation"]
    assert all(part in text for part in ("read-only root", "no network for checks", "VM kernel", "read-write", "host.docker.internal"))
    write_report(state, deps, status="failed")
    report = json.loads((tmp_path / "delivery/report.json").read_text())
    assert text in report["limitations"] and any("control API" in v for v in report["limitations"])
    old = RunStatus(run_id="old00000", status="succeeded", phase="done", sandbox={"mode": "docker", "isolated": True})
    assert old.sandbox["image"] is None and "Unknown" in old.sandbox["isolation"]
    assert HostSandbox(SandboxConfig(mode="host"), tmp_path).describe()["isolation"] == "No OS isolation."


def test_reviewer_diff_redacted_but_deliverables_raw(tmp_path):
    # Guard: workflow.review redacts diff BEFORE build_reviewer_prompt; package/partial keep bytes raw.
    observed = []
    gateway = SimpleNamespace(complete=lambda role, **kw: observed.append(kw["user"]) or SimpleNamespace(parsed=Review.model_validate(REVIEW)))
    deps = dependencies(tmp_path, gateway)
    repo = WorkspaceRepo.init(deps.workspace, tmp_path / "git")
    path = deps.workspace / "calculator.py"
    path.write_text("# before\n")
    base = repo.commit_all("base")
    secret = "review-private-value"
    deps.redactor = Redactor([secret])
    path.write_text("# " + secret + "\n")
    head = repo.commit_paths(["calculator.py"], "edit")
    state = {"run_id": "12345678", "task": "fix", "source_dir": str(tmp_path / "source"), "delivery_mode": "patch",
             "plan": PLAN["plan"], "checks": [{"id": "unit", "kind": "test", "required": True, "duration_s": 0.0, "status": "passed", "commit": head}],
             "workspace": {"base_commit": base, "head_commit": head, "green_commit": head}}
    raw, _ = workflow.diff_info(state, deps)
    assert secret in raw
    assert workflow.review(state, deps)["review"]["verdict"] == "approve"
    assert observed and secret not in observed[0] and "[REDACTED]" in observed[0]
    workflow.package(state, deps)
    assert (tmp_path / "delivery/candidate.diff").read_bytes() == raw.encode()
    from scranton_pipeline.report import finalize_out_of_band
    deps.cfg = deps.cfg.model_copy(update={"sandbox": SandboxConfig(mode="host")})
    finalize_out_of_band({**state, "outcome": "cancelled"}, deps)
    assert (tmp_path / "delivery/partial.diff").read_bytes() == raw.encode()
