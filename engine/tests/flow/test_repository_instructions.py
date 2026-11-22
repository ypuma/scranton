"""Scripted-provider proof of pinned instructions in every Pipeline role."""
import json

import pytest

from scranton_pipeline import runner
from scranton_pipeline.agents.providers import ScriptedChatModel
from scranton_pipeline.config import EngineConfig
from scranton_pipeline.instructions import MAX_BYTES, discover
from scranton_pipeline.observability import _rows


def start(case):
    return runner.start(source=case["source"], task="Fix addition",
                        cfg=EngineConfig.model_validate(case["cfg"]), run_root=case["root"],
                        run_id="agents0001", delivery="patch", trust_host=True)


def finish(case, status):
    return runner.resume(case["root"] / "agents0001", gate="plan", decision="approve",
                         digest=status.pending["digest"], trust_host=True)


def capture(monkeypatch):
    seen = []
    original = ScriptedChatModel._generate

    def generate(self, messages, *args, **kwargs):
        seen.append((self.role, [m.content for m in messages]))
        return original(self, messages, *args, **kwargs)

    monkeypatch.setattr(ScriptedChatModel, "_generate", generate)
    return seen


@pytest.mark.parametrize("large", [False, True])
def test_all_roles_pinned_before_setup_and_resume_and_outside_budget(case, monkeypatch, large):
    monkeypatch.delenv("SCRANTON_AGENTS_MD", raising=False)
    content = "Preserve the repository conventions.\n" + ("x" * (2 * 1024 * 1024) if large else "")
    (case["source"] / "AGENTS.md").write_text(content, encoding="utf-8")
    (case["source"] / "sub").mkdir()
    (case["source"] / "sub" / "AGENTS.md").write_text("nested must not be inlined", encoding="utf-8")
    found = discover(case["source"], ["AGENTS.md", "sub/AGENTS.md"])
    case["cfg"]["limits"]["max_prompt_bytes"] = 16000
    # Setup may modify tracked files, but cannot change the instruction snapshot.
    import sys
    case["cfg"]["setup"] = [{"id": "mutate", "argv": [sys.executable, "-c",
        "from pathlib import Path; Path('AGENTS.md').write_text('SETUP MUTATION')"]}]
    seen = capture(monkeypatch)
    status = start(case)
    assert status.status == "awaiting_approval", status
    assert status.instructions == found.summary()
    directory = case["root"] / "agents0001"
    (case["source"] / "AGENTS.md").write_text("SOURCE MUTATION", encoding="utf-8")
    (directory / "workspace" / "AGENTS.md").write_text("WORKSPACE MUTATION", encoding="utf-8")
    monkeypatch.setenv("SCRANTON_AGENTS_MD", "0")
    status = finish(case, status)
    assert status.status == "succeeded", status
    assert status.instructions == found.summary()
    assert {role for role, _ in seen} == {"planner", "implementer", "reviewer"}
    for role, messages in seen:
        system, user = messages
        assert found.render() in system, role
        assert system.index("Python owns") < system.index("## Repository instructions")
        assert "nested must not be inlined" not in system
        assert len((system + user).encode()) <= 16000 + len(("\n\n" + found.render()).encode())
        assert "MUTATION" not in system
    events = _rows(directory / "events.jsonl")
    assert [r["data"] for r in events if r["type"] == "run_started"] == [{}]
    assert next(i for i, r in enumerate(events) if r["type"] == "run_started") < next(
        i for i, r in enumerate(events) if r["type"] == "node_started")
    assert [r["data"]["instructions"] for r in events if r["type"] == "instructions"] == [found.summary()]
    assert "Preserve the repository" not in (directory / "events.jsonl").read_text()
    assert status.instructions["bytes"] <= MAX_BYTES


@pytest.mark.parametrize("configured,env", [(False, None), (True, "0"), (False, "1")])
def test_run_opt_out_and_env_precedence(case, monkeypatch, configured, env):
    monkeypatch.delenv("SCRANTON_AGENTS_MD", raising=False)
    if env is not None:
        monkeypatch.setenv("SCRANTON_AGENTS_MD", env)
    case["cfg"]["agentsMd"] = configured
    (case["source"] / "AGENTS.md").write_text("ONLY WHEN ENABLED", encoding="utf-8")
    seen = capture(monkeypatch)
    status = start(case)
    assert status.status == "awaiting_approval", status
    active = env == "1"
    assert bool(status.instructions) is active
    status = finish(case, status)
    assert status.status == "succeeded", status
    assert bool(status.instructions) is active
    assert all(("ONLY WHEN ENABLED" in messages[0]) is active for _, messages in seen)
    saved = json.loads((case["root"] / "agents0001" / "config.json").read_text())
    assert saved.get("agentsMd", True) is active


@pytest.mark.parametrize("kind,reason", [("binary", "binary"), ("invalid", "invalid_utf8"),
                                        ("directory", "not_regular")])
def test_warning_reason_and_nested_only_status(case, monkeypatch, kind, reason):
    monkeypatch.delenv("SCRANTON_AGENTS_MD", raising=False)
    path = case["source"] / "AGENTS.md"
    if kind == "directory":
        path.mkdir()
    else:
        path.write_bytes(b"x\0" if kind == "binary" else b"\xff")
    (case["source"] / "sub").mkdir()
    (case["source"] / "sub" / "AGENTS.md").touch()
    for rel in (".scratch", "node_modules", "build"):
        (case["source"] / rel).mkdir()
        (case["source"] / rel / "AGENTS.md").touch()
    seen = capture(monkeypatch)
    status = start(case)
    assert status.status == "awaiting_approval", status
    assert status.instructions == {"file": None, "nested": 1}
    events = _rows(case["root"] / "agents0001" / "events.jsonl")
    warnings = [r["data"] for r in events if r["type"] == "log"]
    assert warnings == [{"level": "warn", "reason": reason, "file": "AGENTS.md"}]
    assert "sub/AGENTS.md" in seen[0][1][0]


def test_nested_uses_gitignore_and_snapshot_protection(case, monkeypatch):
    monkeypatch.delenv("SCRANTON_AGENTS_MD", raising=False)
    source = case["source"]
    # The standalone source uses walk exclusions. Initialise a real source git worktree here.
    from scranton_pipeline.tools.git import _git
    _git(source, ["init", "--template=", "--initial-branch=main"])
    (source / ".gitignore").write_text("ignored/\n", encoding="utf-8")
    for directory in ("visible", "ignored", "secret"):
        (source / directory).mkdir()
        (source / directory / "AGENTS.md").touch()
    case["cfg"]["policy"] = {"protected_paths": ["secret/**"]}
    status = start(case)
    assert status.status == "awaiting_approval", status
    assert status.instructions == {"file": None, "nested": 1}
    receipt = json.loads((case["root"] / "agents0001" / "artifacts" / "instructions.json").read_text())
    assert "visible/AGENTS.md" in receipt["block"] and "ignored/AGENTS.md" not in receipt["block"]


def test_setup_failure_retains_instruction_audit(case, monkeypatch):
    monkeypatch.delenv("SCRANTON_AGENTS_MD", raising=False)
    import sys
    (case["source"] / "AGENTS.md").write_text("Keep this audit.", encoding="utf-8")
    case["cfg"]["setup"] = [{"id": "fail", "argv": [sys.executable, "-c", "raise SystemExit(1)"]}]
    status = start(case)
    assert status.status == "failed" and status.failure["code"] == "setup_failed"
    assert status.instructions["file"] == "AGENTS.md"


def test_absent_status_is_null(case, monkeypatch):
    monkeypatch.delenv("SCRANTON_AGENTS_MD", raising=False)
    status = start(case)
    assert status.status == "awaiting_approval" and status.instructions is None
    rows = _rows(case["root"] / "agents0001" / "events.jsonl")
    assert next(r for r in rows if r["type"] == "run_started")["data"] == {}
    assert next(r for r in rows if r["type"] == "instructions")["data"] == {"instructions": None}


def test_parallel_lanes_receive_original_instructions(case, monkeypatch):
    monkeypatch.delenv("SCRANTON_AGENTS_MD", raising=False)
    from .test_parallel import setup
    setup(case)
    (case["source"] / "AGENTS.md").write_text("ORIGINAL LANE RULES", encoding="utf-8")
    seen = capture(monkeypatch)
    status = start(case)
    assert status.status == "awaiting_approval", status
    status = finish(case, status)
    assert status.status == "succeeded", status
    assert len([role for role, _ in seen if role == "implementer"]) >= 2
    assert all("ORIGINAL LANE RULES" in messages[0] for _, messages in seen)


def test_oversized_root_snapshot_never_reads_full_file(case, monkeypatch):
    import io
    from pathlib import Path
    monkeypatch.delenv("SCRANTON_AGENTS_MD", raising=False)
    path = case["source"] / "AGENTS.md"
    path.write_bytes(b"policy\n" + b"x" * (2 * 1024 * 1024))
    original = Path.open
    reads = []

    class Limited(io.BufferedReader):
        def read(self, size=-1):
            reads.append(size)
            assert 0 <= size <= MAX_BYTES
            return super().read(size)

    def open_file(self, *args, **kwargs):
        if self == path:
            return Limited(io.FileIO(path, "r"))
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", open_file)
    status = start(case)
    assert status.status == "awaiting_approval", status
    assert status.instructions["truncated"] is True and reads == [MAX_BYTES]


def test_skipped_root_escape_is_warning_not_security_failure(case, monkeypatch):
    from scranton_pipeline.nodes import workflow
    monkeypatch.delenv("SCRANTON_AGENTS_MD", raising=False)
    original_snapshot, original_regular = workflow.snapshot_source, workflow.regular

    def snapshot(*args, **kwargs):
        result = original_snapshot(*args, **kwargs)
        return result.model_copy(update={"skipped": [*result.skipped,
            {"path": "AGENTS.md", "reason": "symlink"}]})

    def regular(root, path):
        if root == case["source"]:
            return "escape"
        return original_regular(root, path)

    def protected(self, rel):
        pytest.fail("Escaping instruction path must be rejected before checking source protection")

    monkeypatch.setattr(workflow, "snapshot_source", snapshot)
    monkeypatch.setattr(workflow, "regular", regular)
    # Only forbid the source fallback policy, not normal snapshot/model path checks.
    original_protected = workflow.PathPolicy.is_protected
    monkeypatch.setattr(workflow.PathPolicy, "is_protected", lambda self, rel:
        protected(self, rel) if self.root == case["source"] and rel == "AGENTS.md"
        else original_protected(self, rel))
    status = start(case)
    assert status.status == "awaiting_approval", status
    assert status.instructions is None
    rows = _rows(case["root"] / "agents0001" / "events.jsonl")
    assert any(r["type"] == "log" and r["data"]["reason"] == "escape" for r in rows)


def test_snapshot_failure_still_emits_original_run_started(case, monkeypatch):
    from scranton_pipeline.errors import EngineError, FailureClass
    from scranton_pipeline.nodes import workflow

    def fail_snapshot(*args, **kwargs):
        raise EngineError(FailureClass.LIMIT, "workspace_too_large", "Snapshot limit reached")

    monkeypatch.delenv("SCRANTON_AGENTS_MD", raising=False)
    monkeypatch.setattr(workflow, "snapshot_source", fail_snapshot)
    status = start(case)
    assert status.status == "failed" and status.failure["code"] == "workspace_too_large"
    rows = _rows(case["root"] / "agents0001" / "events.jsonl")
    starts = [r for r in rows if r["type"] == "run_started"]
    assert len(starts) == 1 and starts[0]["data"] == {} and starts[0]["node"] is None
    assert rows.index(starts[0]) < next(i for i, r in enumerate(rows) if r["type"] == "node_started")
    assert not any(r["type"] == "instructions" for r in rows)
    assert status.instructions is None


def test_invalid_environment_exits_two_before_run_creation(case, monkeypatch, capsys):
    from scranton_pipeline.cli import main
    from scranton_pipeline.nodes.workflow import json_write
    path = case["source"].parent / "config.json"
    json_write(path, case["cfg"])
    monkeypatch.setenv("SCRANTON_AGENTS_MD", "invalid")
    assert main(["run", "--source", str(case["source"]), "--task", "Fix addition",
                 "--config", str(path), "--run-root", str(case["root"]),
                 "--run-id", "agents0001", "--trust-host"]) == 2
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == "error"
    assert result["failure"]["failure_class"] == "invalid_input"
    assert result["failure"]["code"] == "invalid_config"
    assert not (case["root"] / "agents0001").exists()
