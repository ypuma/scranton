"""A retained stdout writer must not turn bounded cleanup into an infinite wait."""
import os
import threading
from types import SimpleNamespace

import pytest

from scranton_pipeline.errors import EngineError
from scranton_pipeline.tools import process


@pytest.mark.parametrize("mode", ["parent_exit", "timeout", "cancel"])
def test_retained_stdout_writer_has_bounded_cleanup(tmp_path, monkeypatch, mode):
    read_fd, write_fd = os.pipe()
    output = os.fdopen(read_fd, "rb")
    stopped = process.StopSignal(tmp_path / "cancel")
    if mode == "cancel":
        stopped.cancel_file.touch()
    root = SimpleNamespace(pid=123456789, stdout=output, returncode=None)
    root.poll = lambda: 0 if mode == "parent_exit" else root.returncode
    root.wait = lambda timeout: setattr(root, "returncode", 0)
    root.kill = lambda: setattr(root, "returncode", -9)
    monkeypatch.setattr(process.subprocess, "Popen", lambda *args, **kwargs: root)
    monkeypatch.setattr(process, "_Job", lambda: SimpleNamespace(assign_resume=lambda proc: None, close=lambda: None))
    monkeypatch.setattr(process.os, "killpg", lambda *args: None, raising=False)
    failures = []
    finished = threading.Event()

    def invoke():
        try:
            process.run_process(["fixture"], cwd=tmp_path, env={}, timeout_s=0.01, stop=stopped)
        except EngineError as exc:
            failures.append(exc)
        finally:
            finished.set()

    worker = threading.Thread(target=invoke, daemon=True)
    worker.start()
    try:
        assert finished.wait(12), "stdout.close() waited on the blocked reader after its join deadline"
        assert len(failures) == 1
        assert isinstance(failures[0], EngineError)
        assert failures[0].code == "output_not_closed"
    finally:
        # Release only our own pipe, including when testing the old deadlocking implementation.
        os.close(write_fd)
        worker.join(3)
    assert not worker.is_alive()
    assert output.closed


@pytest.mark.parametrize("source", [
    "import os,time; os.close(1); os.close(2); time.sleep(60)",
    "import os\nwhile True: os.write(1, b'x' * 4096)",
])
def test_real_check_deadline_with_closed_or_busy_stdout(tmp_path, source):
    import sys

    from scranton_pipeline.config import CheckConfig, SandboxConfig
    from scranton_pipeline.tools.checks import run_checks
    from scranton_pipeline.tools.sandbox import build_sandbox

    sandbox = build_sandbox(SandboxConfig(mode="host"), workspace=tmp_path,
                            run_id="abcdefgh", trust_host=True)
    results = run_checks([CheckConfig(id="fixture", argv=[sys.executable, "-c", source], timeout_s=0.3)],
                         sandbox=sandbox, log_dir=tmp_path / "logs", label="baseline", stop=None,
                         tail_bytes=64, max_log_bytes=128)
    assert len(results) == 1
    assert results[0].status == "timed_out"
    assert results[0].duration_s < 4
    assert len(results[0].output_tail.encode()) <= 64
    assert (tmp_path / "logs" / "baseline-fixture.log").stat().st_size <= 128
