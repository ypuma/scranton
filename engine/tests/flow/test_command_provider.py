"""Command protocol against real, owned subprocesses; no provider/network access."""
import json
import os
import sys
import time
from pathlib import Path

import pytest
from langchain_core.messages import HumanMessage, SystemMessage

from scranton_pipeline.agents.gateway import ChatModelGateway
from scranton_pipeline.agents.providers import build_chat_model
from scranton_pipeline.config import EngineConfig, ModelConfig
from scranton_pipeline.errors import EngineError, SuspendRequested, TransientError
from scranton_pipeline.models import PlannerTurn
from scranton_pipeline.observability import EventLog, UsageLedger
from scranton_pipeline.tools.process import StopSignal
from scranton_pipeline.tools.secrets import Redactor

from .conftest import begin, decision

SCRIPT = '''import json, os, sys, time
from pathlib import Path
request, response = map(Path, sys.argv[-2:])
r = json.loads(request.read_text(encoding="utf-8"))
mode = os.environ.get("COMMAND_TEST_MODE", "ok")
Path(os.environ["COMMAND_TEST_OBSERVED"]).write_text(json.dumps({"request": r, "cwd": str(Path.cwd()), "env": list(os.environ), "pid": os.getpid()}))
if mode == "timeout": time.sleep(60)
if mode == "transient": sys.exit(75)
if mode == "reject":
    print("api_key=sk-secret-value-for-test")
    sys.exit(1)
if mode == "missing": sys.exit(0)
if mode == "garbage":
    response.write_text("garbage")
    sys.exit(0)
usage = None if mode == "no_usage" else {"input_tokens": 11, "output_tokens": 17}
if mode == "bad_usage": usage = {"input_tokens": True, "output_tokens": -1}
response.write_text(json.dumps({"text": json.dumps({"kind": "plan", "plan": {"summary": "ok", "acceptance_criteria": [{"id": "sum", "text": "Works", "verified_by": "checks"}], "steps": [{"id": "fix", "title": "Fix", "description": "Fix addition", "files": [{"path": "calculator.py", "action": "modify"}]}]}}), "usage": usage}), encoding="utf-8")
'''


def model(tmp_path, mode="ok", timeout=5, stop=None):
    script = tmp_path / "provider.py"
    script.write_text(SCRIPT)
    cfg = ModelConfig(provider="command", model="test", command=[sys.executable, str(script)], timeout_s=timeout)
    observed = tmp_path / "observed.json"
    ledger = UsageLedger(tmp_path / "usage.jsonl")
    env = {**os.environ, "COMMAND_TEST_MODE": mode, "COMMAND_TEST_OBSERVED": str(observed),
           "SCRANTON_PIPELINE_KEY_PLANNER": "never-forward", "scranton_pipeline_key_other": "also-secret"}
    chat = build_chat_model(cfg, env, ledger=ledger, role="planner", run_dir=tmp_path, stop=stop)
    return chat, cfg, observed, ledger


def clean(tmp_path, observed):
    assert not list((tmp_path / "tmp/provider").iterdir())
    if observed.exists():
        record = json.loads(observed.read_text())
        assert not Path(record["cwd"]).exists()
        assert not any(k.upper().startswith("SCRANTON_PIPELINE_KEY_") for k in record["env"])
        assert record["request"]["v"] == 1
        assert record["request"]["role"] == "planner"
        assert record["request"]["model"] == "test"
        assert record["request"]["max_output_tokens"] == 8192
        assert record["request"]["temperature"] == 0


@pytest.mark.parametrize("mode", ["ok", "no_usage"])
def test_command_success_usage_estimation_and_cleanup(tmp_path, mode):
    chat, cfg, observed, ledger = model(tmp_path, mode)
    engine = EngineConfig(models={r: cfg for r in ("planner", "implementer", "reviewer")}, allow_no_checks=True)
    events = EventLog(tmp_path / "events.jsonl", "command01", Redactor())
    gw = ChatModelGateway({"planner": chat}, engine, ledger, events)
    assert gw.complete("planner", system="private system", user="private user", schema=PlannerTurn).parsed.plan
    request = json.loads(observed.read_text())["request"]
    estimate = (len(request["system"].encode()) + len(request["user"].encode())) // 4
    assert ledger.totals().input_tokens == (estimate if mode == "no_usage" else 11)
    assert json.loads(events.path.read_text().splitlines()[0])["data"]["estimated"] == (mode == "no_usage")
    clean(tmp_path, observed)


@pytest.mark.parametrize("mode", ["reject", "garbage", "missing", "bad_usage", "transient", "timeout"])
def test_command_failure_mapping_and_cleanup(tmp_path, mode):
    chat, _, observed, _ = model(tmp_path, mode, timeout=0.3 if mode == "timeout" else 5)
    error = TransientError if mode in ("transient", "timeout") else EngineError
    started = time.monotonic()
    with pytest.raises(error) as caught:
        chat.invoke([SystemMessage(content="secret"), HumanMessage(content="private")])
    if isinstance(caught.value, EngineError):
        assert caught.value.code == "provider_rejected"
        assert "sk-secret-value-for-test" not in caught.value.detail
    if mode == "timeout":
        assert time.monotonic() - started < 10
        pid = json.loads(observed.read_text())["pid"]
        if os.name != "nt":
            with pytest.raises(ProcessLookupError): os.kill(pid, 0)
    clean(tmp_path, observed)


def test_command_stop_cleanup(tmp_path):
    stop = StopSignal(tmp_path / "cancel")
    stop.request_suspend()
    chat, _, observed, _ = model(tmp_path, "timeout", stop=stop)
    with pytest.raises(SuspendRequested): chat.invoke("private")
    clean(tmp_path, observed)


@pytest.mark.parametrize("retry", [False, True])
def test_command_full_flow_and_node_retry(case, monkeypatch, retry):
    script = case["tmp"] / "replay.py"
    observed = case["tmp"] / "retry.marker"
    script.write_text('''import json, sys
from pathlib import Path
request, response = map(Path, sys.argv[-2:])
r = json.loads(request.read_text())
marker = Path(sys.argv[1])
if sys.argv[2] == "retry" and not marker.exists():
    marker.touch()
    sys.exit(75)
answers = json.loads(Path(sys.argv[3]).read_text())
response.write_text(json.dumps({"text": json.dumps(answers[r["role"]][0]), "usage": None}))
''')
    answers = case["tmp"] / "answers.json"
    answers.write_text(json.dumps({r: json.loads(Path(case["cfg"]["models"][r]["script_path"]).read_text())
                                 for r in ("planner", "implementer", "reviewer")}))
    for role in case["cfg"]["models"]:
        case["cfg"]["models"][role] = {"provider": "command", "model": "test", "command":
            [sys.executable, str(script), str(observed), "retry" if retry else "ok", str(answers)]}
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    code, status = begin(case, delivery="apply")
    assert code == 3, status
    if retry: assert status["usage"]["calls"] == 2
    code, status = decision(case, status)
    assert code == 3 and status["pending"]["gate"] == "delivery", status
    code, status = decision(case, status)
    assert code == 0 and status["status"] == "succeeded", status
    assert "a + b" in (case["source"] / "calculator.py").read_text()
    assert not list((case["root"] / "test0001/tmp/provider").iterdir())
