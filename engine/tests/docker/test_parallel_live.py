"""Explicit opt-in, existing image only; exercises both lanes through real containers."""
import json
import os
import subprocess
import sys
import uuid

import pytest

pytestmark = pytest.mark.skipif(os.environ.get("SCRANTON_PIPELINE_DOCKER_TEST") != "1",
                                reason="opt-in Docker parallel integration")


def test_parallel_demo_docker(tmp_path):
    # Guards lane-specific sandbox bindings and copied workspace across real Docker checks.
    root = tmp_path / "runs"
    run_id = uuid.uuid4().hex[:12]

    def cli(args, expected):
        proc = subprocess.run([sys.executable, "-m", "scranton_pipeline", *args],
                              capture_output=True, text=True, timeout=180, check=False)
        assert proc.returncode == expected, proc.stdout + proc.stderr
        return json.loads(proc.stdout)

    status = cli(["demo", "--scenario", "parallel", "--sandbox", "docker", "--run-root", str(root),
                  "--run-id", run_id, "--delivery", "apply"], 3)
    for gate, expected in (("plan", 3), ("delivery", 0)):
        assert status["pending"]["gate"] == gate
        status = cli(["resume", "--run-dir", str(root / run_id), "--gate", gate, "--decision", "approve",
                      "--digest", status["pending"]["digest"]], expected)
    print("parallel final status:", json.dumps(status))
    assert status["status"] == "succeeded" and status["delivery"]["applied"]
    rows = [json.loads(s) for s in (root / run_id / "events.jsonl").read_text().splitlines()]
    assert sum(e["type"] == "lane_finished" and e["data"]["status"] == "passed" for e in rows) == 2
    assert sum(e["type"] == "wave_merged" for e in rows) == 1
