"""Bundled commands must work when Python excludes the working directory."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

from scranton_pipeline.cli import main
from scranton_pipeline.evals import evaluate as harness
from scranton_pipeline.evals.pack import load_pack


def test_core_isolated_matches_normal(tmp_path, monkeypatch, capsys):
    normal = tmp_path / "normal"
    isolated = tmp_path / "isolated"
    assert main(["eval", "--pack", "core", "--out", str(normal)]) == 0
    normal_stdout = capsys.readouterr().out
    monkeypatch.setattr(harness, "python_command", lambda mode: [sys.executable, "-I"])
    code = main(["eval", "--pack", "core", "--out", str(isolated)])
    captured = capsys.readouterr()
    result = json.loads(captured.out)
    assert code == 0, (code, sum(t["expect_met"] for t in result["tasks"]), result["mean_adjusted"])
    assert len(result["tasks"]) == 9 and all(t["expect_met"] for t in result["tasks"])
    assert captured.out == normal_stdout
    assert result["mean_adjusted"] == .6732


@pytest.mark.parametrize("scenario", ["basic", "replan", "parallel", "evidence"])
def test_demo_checks_isolated(tmp_path, monkeypatch, scenario):
    from scranton_pipeline import runner
    from scranton_pipeline.demo import fixture

    def inspect(**kwargs):
        directory = kwargs["run_root"] / kwargs["run_id"]
        directory.mkdir(parents=True)
        fixture.materialize(directory, scenario)
        source = directory / "demo-source"
        for name, old, new in (("calculator.py", "a - b", "a + b"),
                               ("multiplier.py", "a + b", "a * b")):
            path = source / name
            if path.exists():
                path.write_text(path.read_text().replace(old, new))
        for check in kwargs["cfg"].checks:
            argv = check.argv
            assert argv[0] == sys.executable
            result = subprocess.run([argv[0], "-I", *argv[1:]], cwd=source, check=False,
                                    capture_output=True, text=True, timeout=30)
            assert result.returncode == 0, (scenario, argv, result.stdout, result.stderr)
        return kwargs["cfg"]

    monkeypatch.setattr(runner, "start", inspect)
    fixture.run_demo(tmp_path, run_id="isolateddemo", scenario=scenario)


def test_exit_four_reports_first_acceptance_failure_per_task(tmp_path, monkeypatch, capsys):
    pack = load_pack("core")
    tasks = []
    for task in pack.manifest.tasks[:2]:
        checks = [task.acceptance.checks[0].model_copy(update={
            "id": name, "argv": ["{python}", "-B", "-c", "import missing_project_module"]})
            for name in ("first", "second")]
        tasks.append(task.model_copy(update={"acceptance": task.acceptance.model_copy(update={"checks": checks})}))
    pack = type(pack)(pack.root, pack.manifest.model_copy(update={"tasks": tasks}), True)
    import scranton_pipeline.evals.pack as packs
    monkeypatch.setattr(packs, "load_pack", lambda _: pack)
    out = tmp_path / "out"
    assert main(["eval", "--pack", "core", "--out", str(out)]) == 4
    captured = capsys.readouterr()
    assert len(captured.out.splitlines()) == 1
    value = json.loads((out / "eval.json").read_text())
    assert json.loads(captured.out) == harness.summary(value)
    hints = captured.err.splitlines()
    assert len(hints) == 2
    for task, meta, hint in zip(tasks, value["meta"]["tasks"], hints, strict=True):
        check = meta["acceptance"][0]
        assert task.id in hint and "first" in hint and "second" not in hint
        assert check["log_path"] in hint and str(out.resolve() / "eval.json") in hint
        assert Path(check["log_path"]).is_file()
        assert "ModuleNotFoundError" in check["output_tail"]


@pytest.mark.parametrize("task", load_pack("core").manifest.tasks, ids=lambda task: task.id)
def test_each_pack_command_isolated(tmp_path, task):
    import shutil

    pack = load_pack("core")
    source = tmp_path / "source"
    shutil.copytree(pack.root / task.fixture, source)
    calculator = source / "calculator.py"
    calculator.write_text(calculator.read_text().replace("a - b", "a + b"))
    for check in [*task.checks, *task.acceptance.checks]:
        argv = [part for arg in check.argv for part in
                ([sys.executable, "-I"] if arg == "{python}" else [arg])]
        result = subprocess.run(argv, cwd=source, check=False, capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, (task.id, check.id, result.stdout, result.stderr)


def test_python_expansion_preserves_arguments():
    assert harness.expand_python(["{python}", "-c", "print('{python}')"], "host") == [
        sys.executable, "-c", "print('{python}')"]
    assert harness.expand_python(["{python}", "-m", "unittest"], "docker") == [
        "python", "-m", "unittest"]
