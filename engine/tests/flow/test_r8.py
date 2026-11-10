import os
import subprocess
import sys

import pytest

from scranton_pipeline.demo.fixture import EDIT, PLAN
from scranton_pipeline.observability import _rows

from .conftest import begin, cli, decision, script


def test_refuted_block_once_across_crash_and_resume(case):
    case["cfg"]["grounding"] = {"mode": "enforce"}
    script(case, "planner", [{"kind": "need_context", "context_requests": [{"kind": "read", "path": "calculator.py"}]}, PLAN, PLAN, PLAN])
    blocked = {"kind": "blocked", "blocked_reason": "Missing add", "blocked_claim": {"kind": "missing_symbol", "subject": "add"}}
    script(case, "implementer", [blocked, blocked])
    _, status = begin(case)
    directory = case["root"] / "test0001"
    hook = case["tmp"] / "crash_block.py"
    hook.write_text('''import os, sys
from scranton_pipeline.nodes import workflow
from scranton_pipeline.cli import main
original = workflow.evaluate
def crash(*args, **kwargs):
    result = original(*args, **kwargs)
    if args[2] == "implementer":
        os._exit(91)
    return result
workflow.evaluate = crash
raise SystemExit(main(sys.argv[1:]))
''')
    process = subprocess.run([sys.executable, str(hook), "resume", "--run-dir", str(directory), "--trust-host", "--gate", "plan", "--decision", "approve", "--digest", status["pending"]["digest"]], env=os.environ, capture_output=True, timeout=60, check=False)
    assert process.returncode == 91, process.stderr
    first = [r for r in _rows(directory / "grounding.jsonl") if r.get("role") == "implementer"]
    assert len(first) == 1 and not first[0]["accepted"]
    code, status = cli("resume", "--run-dir", directory, "--trust-host")
    assert code == 3 and status["pending"]["gate"] == "plan", status
    rows = [r for r in _rows(directory / "grounding.jsonl") if r.get("role") == "implementer"]
    assert len(rows) == 2 and all(r["absence"]["refuted"] == 1 for r in rows)
    assert sum(r["type"] == "llm_call" and r["data"]["role"] == "implementer" for r in _rows(directory / "events.jsonl")) == 2
    assert not any(r["data"].get("code") == "output_invalid" for r in _rows(directory / "events.jsonl"))


@pytest.mark.parametrize("role", ["planner", "implementer", "reviewer"])
def test_observe_real_node_paths_accept_and_record(case, role):
    case["cfg"]["grounding"] = {"mode": "observe"}
    if role == "planner":
        script(case, "planner", [PLAN])
        violation = "unseen_target"
    else:
        script(case, "planner", [{"kind": "need_context", "context_requests": [{"kind": "read", "path": "calculator.py"}]}, PLAN])
        if role == "implementer":
            script(case, role, [{"kind": "need_context", "context_requests": [{"kind": "read", "path": ".env"}]}, EDIT])
            violation = "protected_request"
        else:
            script(case, role, [{"verdict": "approve", "summary": "ok", "findings": [{"severity": "minor", "category": "scope", "path": "unchanged.py", "description": "Not changed"}]}])
            violation = "unsupported_finding"
    _, status = begin(case)
    code, status = decision(case, status)
    assert code == 0, status
    rows = [r for r in _rows(case["root"] / "test0001/grounding.jsonl") if r.get("role") == role and r.get("violations")]
    assert len(rows) == 1 and rows[0]["accepted"]
    assert violation in {v["kind"] for v in rows[0]["violations"]}
