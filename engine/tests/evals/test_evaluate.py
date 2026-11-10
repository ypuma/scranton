"""Real scripted rollouts pin hidden truth and trace-derived regression scores."""
import copy
import json
import re
import shutil
from pathlib import Path

import pytest

from scranton_pipeline.agents.gateway import ChatModelGateway
from scranton_pipeline.cli import main
from scranton_pipeline.evals.evaluate import base_config, evaluate, graph_option, summary
from scranton_pipeline.evals.pack import invalid, load_pack, select
from scranton_pipeline.observability import _rows


@pytest.fixture(scope="module")
def evaluated(tmp_path_factory):
    root = tmp_path_factory.mktemp("evals")
    pack = load_pack("core")
    cfg = base_config(pack, None, "scripted", False)
    prompts = []
    original = ChatModelGateway.complete
    def capture(self, role, *, system, user, schema, **kwargs):
        prompts.append(system + user)
        return original(self, role, system=system, user=user, schema=schema, **kwargs)
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(ChatModelGateway, "complete", capture)
        first = evaluate(pack, root / "one", cfg=cfg)
        second = evaluate(pack, root / "two", cfg=cfg)
    return root, pack, cfg, first, second, prompts


def test_core_exact_scores_and_determinism(evaluated):
    root, pack, _cfg, first, second, _prompts = evaluated
    assert all(t["expect_met"] for t in first["tasks"])
    assert json.dumps(summary(first), sort_keys=True).encode() == json.dumps(summary(second), sort_keys=True).encode()
    assert len(first["tasks"]) == 9
    assert first["mean_adjusted"] == .6732
    serialized = json.dumps(summary(first))
    assert str(root) not in serialized and "duration" not in serialized and "run_id" not in serialized
    assert (root / "one" / "eval.json").is_file()
    for task in pack.manifest.tasks:
        source = root / "one" / task.id / "source"
        assert (source / "calculator.py").read_bytes() == (pack.root / task.fixture / "calculator.py").read_bytes()


def test_hidden_acceptance_never_in_prompts_or_visible_config(evaluated):
    root, _pack, _cfg, first, _second, prompts = evaluated
    secret_check = "assert add(-2,3)==1"
    assert prompts and not any(secret_check in p or '"acceptance"' in p for p in prompts)
    for file in (root / "one").rglob("config.json"):
        text = file.read_text()
        assert secret_check not in text and '"acceptance"' not in text
    hidden = next(t for t in first["tasks"] if t["id"] == "hidden_failure")
    assert hidden["status"] == "succeeded" and hidden["answer"] == 0 and hidden["adjusted"] == .5
    meta = next(m for m in first["meta"]["tasks"] if m["trace"]["id"] == "hidden_failure")
    assert meta["acceptance"][0]["status"] == "failed"
    assert "abs(a)" in (Path(meta["run_dir"]).parents[1] / "accepted-tree" / "calculator.py").read_text()


def test_probe_and_baseline_green_are_not_conflated(evaluated):
    rows = {r["id"]: r for r in evaluated[3]["tasks"]}
    assert rows["already_green"]["criteria"][0]["state"] == "met_not_demonstrated"
    assert rows["probe"]["criteria"][0]["by"] == "probe"
    meta = next(m for m in evaluated[3]["meta"]["tasks"] if m["trace"]["id"] == "already_green")
    report = json.loads((Path(meta["run_dir"]) / "delivery" / "report.json").read_text())
    assert "criteria_not_demonstrated" in json.dumps(report)


@pytest.mark.parametrize("kind", ["false_absence", "unseen_edit", "unknown_citation", "unsupported_assessment", "unseen_target"])
def test_each_violation_is_repaired_but_scored(evaluated, kind):
    row = next(t for t in evaluated[3]["tasks"] if t["id"] == kind)
    assert row["status"] == "succeeded" and row["violations"] == {kind: 1}
    assert row["violation_rate"] > 0 and row["adjusted"] < 1


def test_eval_gates_record_harness_authority(evaluated):
    for meta in evaluated[3]["meta"]["tasks"]:
        events = _rows(Path(meta["run_dir"]) / "events.jsonl")
        gates = [r for r in events if r["type"] == "gate_decided"]
        assert gates and all(r["data"]["by"] == "eval" for r in gates)


@pytest.mark.parametrize("mutation,match", [
    (lambda p: p.update(schema=2), "schema"),
    (lambda p: p.update(schema=True), "schema must be integer"),
    (lambda p: p["tasks"].append(copy.deepcopy(p["tasks"][0])), "Duplicate task"),
    (lambda p: p["tasks"][0].update(fixture="../escape"), "path"),
    (lambda p: p["tasks"][0]["scripts"].update(planner="missing.json"), "missing.json"),
    (lambda p: p["tasks"][0]["acceptance"].update(paths=["C:/escape"]), "path"),
])
def test_invalid_pack_precise(tmp_path, mutation, match):
    pack = load_pack("core")
    shutil.copytree(pack.root, tmp_path / "pack")
    path = tmp_path / "pack" / "pack.json"
    value = json.loads(path.read_text())
    mutation(value)
    path.write_text(json.dumps(value))
    with pytest.raises(Exception, match=match):
        load_pack(str(path.parent))


def test_selection_and_output_admission(tmp_path):
    pack = load_pack("core")
    for ids in ("missing", "baseline,baseline", ""):
        with pytest.raises(Exception, match="unique, known"):
            select(pack, ids, "all")
    assert [t.id for t in select(pack, "baseline", "val")] == ["baseline"]
    with pytest.raises(Exception, match="empty"):
        select(pack, "baseline", "train")
    from scranton_pipeline.evals.evaluate import output_dir
    with pytest.raises(Exception, match="overlap"):
        output_dir(pack.root / "nested", pack)
    (tmp_path / "occupied").write_text("preserve")
    with pytest.raises(Exception, match="empty"):
        output_dir(tmp_path, pack)
    assert (tmp_path / "occupied").read_text() == "preserve"


def test_real_call_guard_before_execution(tmp_path, monkeypatch, capsys):
    pack = load_pack("core")
    cfg = base_config(pack, None, "scripted", False).model_dump(mode="json", by_alias=True)
    cfg["models"]["planner"] = {"provider": "openai_compatible", "model": "paid"}
    path = tmp_path / "config.json"
    path.write_text(json.dumps(cfg))
    import scranton_pipeline.evals.evaluate as module
    monkeypatch.setattr(module, "start", lambda **kw: pytest.fail("must never call a model"))
    assert main(["eval", "--pack", "core", "--models", "config", "--config", str(path), "--out", str(tmp_path / "out")]) == 2
    assert "--real-calls" in capsys.readouterr().out
    assert not (tmp_path / "out").exists()
    with pytest.raises(Exception, match="requires --config"):
        base_config(pack, None, "config", False)
    assert base_config(pack, path, "config", True).models.planner.provider == "openai_compatible"


def test_wrong_expect_exits_four(tmp_path, capsys):
    pack = load_pack("core")
    shutil.copytree(pack.root, tmp_path / "pack")
    path = tmp_path / "pack" / "pack.json"
    value = json.loads(path.read_text())
    value["tasks"][0]["expect"]["adjusted"] = 0
    path.write_text(json.dumps(value))
    assert main(["eval", "--pack", str(path.parent), "--tasks", "baseline", "--trust-host", "--out", str(tmp_path / "out")]) == 4
    output = capsys.readouterr().out.splitlines()
    assert len(output) == 1 and json.loads(output[0])["tasks"][0]["expect_met"] is False


def test_graph_option_and_guidance_rollout(tmp_path):
    assert graph_option(None) is None
    graph = graph_option("default")
    pack = load_pack("core")
    value = evaluate(pack, tmp_path / "guidance", cfg=base_config(pack, None, "scripted", False), graph=graph, tasks="baseline")
    assert value["tasks"][0]["expect_met"]
    events = _rows(Path(value["meta"]["tasks"][0]["run_dir"]) / "events.jsonl")
    assert any(e["type"] == "procedure" and e["data"]["matched"] for e in events)
    assert value["graph_digest"]


def test_invalid_pack_cli_exit_two(tmp_path, capsys):
    assert main(["eval", "--pack", str(tmp_path)]) == 2
    assert "Invalid pack" in capsys.readouterr().out
    assert invalid("example").code == "invalid_eval"


def test_pack_survives_desktop_staging():
    engine = Path(__file__).resolve().parents[2]
    staging = engine.parent / "scripts" / "prepare-desktop.mjs"
    if not staging.is_file():
        pytest.skip("Desktop staging rule unavailable outside the Project Scranton repository")
    literal = re.search(r"^const pipelineForbidden = /(.+)/([a-z]*);$",
        staging.read_text(encoding="utf-8"), re.MULTILINE)
    assert literal is not None, "Cannot locate pipelineForbidden JavaScript regex"
    assert literal[2] == "i", "Update the Python translation for changed JavaScript flags"
    # JavaScript's non-Unicode /i uses ASCII folding; its dot excludes all line terminators.
    forbidden = re.compile(literal[1].replace(".*", r"[^\r\n\u2028\u2029]*"),
        re.IGNORECASE | re.ASCII)
    for name in ("Scripts", "scripts", "bin", "test", "tests", "pip", "pip-24.0.dist-info",
                 "ruff_cache", "wheel", "x.pyc", ".env", ".env.local", "auth.json"):
        assert forbidden.search(name), name
    for name in ("turns", "test_calculator.py", "fixture", "pack.json", "scripting", "tests_extra"):
        assert not forbidden.search(name), name
    package = engine / "src" / "scranton_pipeline"
    removed = [p.relative_to(package).as_posix() for p in package.rglob("*")
        if not (p.is_dir() and p.name == "__pycache__")
        and not (p.is_file() and p.suffix in {".pyc", ".pyo"})
        and forbidden.search(p.name)]
    assert not removed, f"Desktop staging would remove package paths: {removed}"


def test_deadline_prevents_next_task(tmp_path, monkeypatch):
    import scranton_pipeline.evals.evaluate as module
    pack = load_pack("core")
    monkeypatch.setattr(module.time, "monotonic", lambda: 10)
    monkeypatch.setattr(module, "evaluate_task", lambda *a, **kw: pytest.fail("expired task"))
    with pytest.raises(TimeoutError, match="between tasks"):
        evaluate(pack, tmp_path / "out", cfg=base_config(pack, None, "scripted", False), deadline=9)


def test_expired_acceptance_never_runs_hidden_checks(tmp_path, monkeypatch):
    import scranton_pipeline.evals.evaluate as module
    pack = load_pack("core")
    monkeypatch.setattr(module.time, "monotonic", lambda: 10)
    monkeypatch.setattr(module.WorkspaceRepo, "init", lambda *a: pytest.fail("expired acceptance touched git"))
    assert module.acceptance(pack, pack.manifest.tasks[0], tmp_path, tmp_path,
        base_config(pack, None, "scripted", False), True, True, deadline=9) == (0, [])


@pytest.mark.parametrize("allowed,passed,answer", [(True, True, 1), (False, True, 0), (True, False, 0)])
def test_hidden_acceptance_path_and_check_conjunction(tmp_path, monkeypatch, allowed, passed, answer):
    import scranton_pipeline.evals.evaluate as module
    from scranton_pipeline.config import CheckConfig
    from scranton_pipeline.models import CheckResult
    pack = load_pack("core")
    task = pack.manifest.tasks[0].model_copy(update={"acceptance": pack.manifest.tasks[0].acceptance.model_copy(update={"paths": ["calculator.py"] if allowed else ["other.py"]})})
    delivery = tmp_path / "run" / "delivery"
    delivery.mkdir(parents=True)
    (delivery / "candidate.diff").write_text("patch")
    class Repo:
        def commit_all(self, message):
            return "commit"
        def _run(self, argv):
            assert argv[:2] == ["apply", "--index"]
        def changed_files(self, base, head):
            return [("M", "calculator.py")]
    class Box:
        def preflight(self):
            pass
    monkeypatch.setattr(module.WorkspaceRepo, "init", lambda *a: Repo())
    boxes, checks = [], []
    def sandbox(cfg, **kwargs):
        boxes.append(kwargs)
        return Box()
    def run(configured, **kwargs):
        checks.extend(configured)
        assert kwargs["sandbox"].__class__ == Box and kwargs["fail_fast"] is False
        return [CheckResult(id=c.id, kind=c.kind, status="passed" if passed else "failed", exit_code=0 if passed else 1,
            duration_s=0, output_tail="", log_path="log", required=c.required) for c in configured]
    monkeypatch.setattr(module, "build_sandbox", sandbox)
    monkeypatch.setattr(module, "run_checks", run)
    monkeypatch.setattr(module.time, "monotonic", lambda: 10)
    score, _ = module.acceptance(pack, task, tmp_path, tmp_path / "run", base_config(pack, None, "scripted", False), True, True, deadline=12)
    assert score == answer and boxes[0]["workspace"] == tmp_path / "accepted-tree"
    assert all(isinstance(c, CheckConfig) and c.timeout_s == 2 for c in checks)
    assert boxes[0]["workspace"] != pack.root / task.fixture


def test_all_pack_files_are_declared_package_data():
    import fnmatch
    import tomllib
    engine = Path(__file__).resolve().parents[2]
    config = tomllib.loads((engine / "pyproject.toml").read_text())
    patterns = config["tool"]["setuptools"]["package-data"]["scranton_pipeline"]
    package = engine / "src" / "scranton_pipeline"
    files = [p.relative_to(package).as_posix() for p in (package / "evals" / "packs").rglob("*") if p.is_file() and "__pycache__" not in p.parts]
    assert files and all(any(fnmatch.fnmatchcase(p, g) for g in patterns) for p in files)


def test_baseline_fulfils_project_wide_context(evaluated):
    meta = next(m for m in evaluated[3]["meta"]["tasks"] if m["trace"]["id"] == "baseline")
    directory = Path(meta["run_dir"])
    turn = json.loads((directory.parent.parent / "scripts" / "planner.json").read_text())[0]
    assert {(r["kind"], r["path"]) for r in turn["context_requests"]} >= {("search", ""), ("list", "")}
    registry = _rows(directory / "evidence.jsonl")
    assert {r["query"] for r in registry if r["kind"] == "context" and r["path"] == "" and r["ok"]} >= {"", "add"}
    assert any(r["type"] == "context" and r["data"] == {"requests": 3, "fulfilled": 3} for r in _rows(directory / "events.jsonl"))
    assert any(r.get("role") == "planner" and r["accepted"] and not r["violations"] for r in _rows(directory / "grounding.jsonl"))
