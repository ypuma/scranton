"""A baseline-red required check can still be repaired through the scripted loop."""
import json
import sys

from scranton_pipeline import runner
from scranton_pipeline.agents.gateway import ChatModelGateway
from scranton_pipeline.config import EngineConfig

from .conftest import script


def test_saved_early_diagnostic_reaches_scripted_repair_without_bypassing_gates(case, monkeypatch):
    (case["source"] / "check.py").write_text(
        "from calculator import add\nimport sys\n"
        "if add(2, 3) != 5:\n"
        "    print('AssertionError: early-sum-diagnostic', flush=True)\n"
        "    print('progress\\n' * 4000, flush=True)\n"
        "    sys.exit(1)\n", encoding="utf-8")
    case["cfg"]["checks"][0]["argv"] = [sys.executable, "check.py"]
    script(case, "implementer", [
        {"kind": "edits", "edits": [{"action": "modify", "path": "calculator.py", "content": "def add(a, b):\n    return 0\n"}]},
        {"kind": "edits", "edits": [{"action": "modify", "path": "calculator.py", "content": "def add(a, b):\n    return a + b\n"}]},
    ])
    seen = []
    original = ChatModelGateway.complete

    def capture(self, role, **kwargs):
        if role == "implementer":
            seen.append(kwargs["user"])
        return original(self, role, **kwargs)

    monkeypatch.setattr(ChatModelGateway, "complete", capture)
    status = runner.start(source=case["source"], task="Fix addition", cfg=EngineConfig.model_validate(case["cfg"]),
                          run_root=case["root"], run_id="robust001", delivery="patch", trust_host=True)
    assert status.status == "awaiting_approval" and status.pending["gate"] == "plan"
    assert not seen
    directory = case["root"] / "robust001"
    status = runner.resume(directory, gate="plan", decision="approve", digest=status.pending["digest"], trust_host=True)
    assert status.status == "succeeded", status
    assert len(seen) == 2
    assert '"checks_failed"' in seen[1] and "early-sum-diagnostic" in seen[1]
    assert "current status=failed" in seen[1] and "baseline status=failed" in seen[1]
    assert "pre-existing check failure" in seen[1] and "root cause relationship unknown" in seen[1]
    rows = [json.loads(line) for line in (directory / "events.jsonl").read_text().splitlines()]
    assert [r["data"]["status"] for r in rows if r["type"] == "check_finished"] == ["failed", "failed", "passed"]
    assert any(r["type"] == "node_started" and r["node"] == "review" for r in rows)
    assert "early-sum-diagnostic" not in (directory / "events.jsonl").read_text()
    assert "early-sum-diagnostic" not in (directory / "usage.jsonl").read_text()
    assert "return a - b" in (case["source"] / "calculator.py").read_text()
