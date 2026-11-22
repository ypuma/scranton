"""Upgrade recovery uses the installed bridge, never a saved installation path."""
import json
import sys
from pathlib import Path

import pytest

from scranton_pipeline.config import EngineConfig
from scranton_pipeline.demo.fixture import PLAN
from scranton_pipeline.errors import EngineError
from scranton_pipeline.runner import resume_completion_config

from .conftest import begin, cli, script


@pytest.mark.parametrize("saved_helper", [
    "tools/pipeline-pi-complete.js",
    "Z:\\removed installation\\tools\\pipeline-pi-complete.js",
    "/removed-installation/tools/pipeline-complete.js",
])
@pytest.mark.parametrize("suspended", [False, True])
def test_resume_uses_current_completion_helper(case, monkeypatch, saved_helper, suspended):
    current = case["tmp"] / "current installation" / "pipeline-complete.js"
    current.parent.mkdir()
    answers = {role: json.loads(Path(model["script_path"]).read_text())[0]
               for role, model in case["cfg"]["models"].items()}
    answers_path = case["tmp"] / "answers.json"
    answers_path.write_text(json.dumps(answers))
    current.write_text('''import json, sys
from pathlib import Path
assert sys.argv[1:3] == ["--provider", "fixture"]
request, response = map(Path, sys.argv[-2:])
r = json.loads(request.read_text())
answers = json.loads(Path(sys.argv[3]).read_text())
response.write_text(json.dumps({"text": json.dumps(answers[r["role"]]), "usage": None}))
''')
    monkeypatch.setenv("SCRANTON_PIPELINE_COMPLETION_COMMAND", json.dumps([sys.executable, str(current)]))
    for role in ("implementer", "reviewer"):
        case["cfg"]["models"][role] = {
            "provider": "command", "model": "fixture",
            "command": ["/removed-installation/node", saved_helper, "--provider", "fixture", str(answers_path)],
        }
    if suspended:
        script(case, "planner", [{"__error__": "transient"}] * 3 + [PLAN])
    code, status = begin(case, delivery="apply")
    assert code == (5 if suspended else 3), status
    run_dir = case["root"] / "test0001"
    saved = {name: (run_dir / name).read_bytes() for name in ("config.json", "run.json")}
    if suspended:
        code, status = cli("resume", "--run-dir", run_dir, "--trust-host")
        assert code == 3, status
    for gate in ("plan", "delivery"):
        assert status["pending"]["gate"] == gate, status
        code, status = cli("resume", "--run-dir", run_dir, "--trust-host", "--gate", gate,
                           "--decision", "approve", "--digest", status["pending"]["digest"])
        assert code == (3 if gate == "plan" else 0), status
    assert status["status"] == "succeeded"
    assert "a + b" in (case["source"] / "calculator.py").read_text()
    for name, data in saved.items():
        assert (run_dir / name).read_bytes() == data
    events = [json.loads(line) for line in (run_dir / "events.jsonl").read_text().splitlines()]
    rebound = [event for event in events if event["data"].get("code") == "completion_command_rebound"]
    assert rebound and rebound[0]["data"]["roles"] == ["implementer", "reviewer"]
    assert not list((run_dir / "tmp/provider").iterdir())


@pytest.mark.parametrize("current", [None, "broken", "[]", '["missing", "pipeline-complete.js"]'])
def test_resume_bridge_missing_current_command_fails_closed(case, monkeypatch, current):
    if current is None:
        monkeypatch.delenv("SCRANTON_PIPELINE_COMPLETION_COMMAND", raising=False)
    else:
        monkeypatch.setenv("SCRANTON_PIPELINE_COMPLETION_COMMAND", current)
    case["cfg"]["models"]["implementer"] = {
        "provider": "command", "model": "fixture",
        "command": [sys.executable, "tools/pipeline-pi-complete.js"],
    }
    with pytest.raises(EngineError) as caught:
        resume_completion_config(EngineConfig.model_validate(case["cfg"]))
    assert caught.value.code == "completion_command_missing"


def test_resume_does_not_rebind_custom_commands(case, monkeypatch):
    monkeypatch.setenv("SCRANTON_PIPELINE_COMPLETION_COMMAND", "broken")
    case["cfg"]["models"]["implementer"] = {
        "provider": "command", "model": "fixture", "command": [sys.executable, "custom.py"],
    }
    cfg = EngineConfig.model_validate(case["cfg"])
    effective, roles = resume_completion_config(cfg)
    assert effective is cfg and roles == []
