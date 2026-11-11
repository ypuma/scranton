"""Explicit opt-in only; every resource is owned and named by these tests."""
import json
import os
import subprocess
import sys
import uuid
import zipfile

import pytest

from scranton_pipeline.config import SandboxConfig
from scranton_pipeline.tools.git import WorkspaceRepo
from scranton_pipeline.tools.process import run_process, scrubbed_env
from scranton_pipeline.tools.sandbox import DockerSandbox, default_image, sweep_expired

pytestmark = pytest.mark.skipif(os.environ.get("SCRANTON_PIPELINE_DOCKER_TEST") != "1",
                                reason="opt-in Docker integration")


@pytest.fixture
def sandbox(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    result = DockerSandbox(SandboxConfig(), workspace, uuid.uuid4().hex[:12])
    result.preflight()
    yield result
    result.cleanup()


def check(sandbox, argv, *, timeout=30, network=False, writable_state=False):
    result = sandbox.run(argv, timeout_s=timeout, log_path=sandbox.workspace.parent / "check.log", network=network,
                         writable_state=writable_state)
    assert result.exit_code == 0 and not result.timed_out, result.output_tail
    return result.output_tail


def test_readonly_uid_workspace_network_and_contents(sandbox, monkeypatch):
    expected_uid = 10001 if sys.platform == "win32" else (getattr(os, "getuid", lambda: 0)() or 10001)
    assert expected_uid > 0
    monkeypatch.setenv("HOST_SECRET", "not-for-the-container")
    output = check(sandbox, ["python", "-c", ("import os,errno,json,pathlib,socket,subprocess; "
        "p=pathlib.Path('/usr/local/root-write-test'); "
        "exec(\"try:\\n p.write_text('bad')\\nexcept OSError as e:\\n assert e.errno == errno.EROFS\\nelse:\\n raise AssertionError('root writable')\"); "
        f"assert os.getuid()=={expected_uid}; "
        "assert os.listdir('/sys/class/net')==['lo']; "
        "pathlib.Path('created.txt').write_bytes(b'container\\n'); "
        "assert 'HOST_SECRET' not in os.environ; "
        "import pytest,venv; "
        "print(json.dumps({'uid':os.getuid(),'python':subprocess.check_output(['python','--version'],text=True).strip(),"
        "'node':subprocess.check_output(['node','--version'],text=True).strip(),"
        "'npm':subprocess.check_output(['npm','--version'],text=True).strip(),"
        "'git':subprocess.check_output(['git','--version'],text=True).strip(),'pytest':pytest.__version__}))")])
    assert (sandbox.workspace / "created.txt").read_bytes() == b"container\n"
    assert json.loads(output)["uid"] == expected_uid
    print("image contents:", output.strip())
    check(sandbox, ["python", "-c", ("import os,socket; assert 'eth0' in os.listdir('/sys/class/net'); "
                   "s=socket.create_connection(('example.com',443),10); s.close(); print('network available')")], network=True, writable_state=True)


def test_python_user_install_persists_and_git_ignores(sandbox):
    wheel = sandbox.workspace / "pipeline_probe-1.0-py3-none-any.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr("pipeline_probe.py", "VALUE = 42\ndef main():\n    print(VALUE)\n")
        archive.writestr("pipeline_probe-1.0.dist-info/entry_points.txt", "[console_scripts]\npipeline-python-probe = pipeline_probe:main\n")
        archive.writestr("pipeline_probe-1.0.dist-info/METADATA", "Metadata-Version: 2.1\nName: pipeline-probe\nVersion: 1.0\n")
        archive.writestr("pipeline_probe-1.0.dist-info/WHEEL", "Wheel-Version: 1.0\nGenerator: pipeline-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
        archive.writestr("pipeline_probe-1.0.dist-info/RECORD", "")
    repo = WorkspaceRepo.init(sandbox.workspace, sandbox.workspace.parent / "git")
    base = repo.commit_all("base")
    check(sandbox, ["python", "-m", "pip", "install", "--user", "--no-index", "--no-deps", wheel.name], writable_state=True)
    check(sandbox, ["python", "-c", ("import pipeline_probe; assert pipeline_probe.VALUE == 42; "
          "assert '/workspace/.pipeline/python/' in pipeline_probe.__file__; print(pipeline_probe.__file__)")])
    assert check(sandbox, ["pipeline-python-probe"]).strip() == "42"
    check(sandbox, ["python", "-c", "import errno,pathlib; exec(\"try:\\n pathlib.Path('.pipeline/injected').write_text('bad')\\nexcept OSError as e:\\n assert e.errno == errno.EROFS\\nelse:\\n raise AssertionError('state writable')\")"])
    assert not (sandbox.state_dir / "injected").exists()
    head = repo.commit_all("after setup")
    assert not repo.diff(base, head)
    assert not repo.changed_files(base, head)
    repo.reset_hard(base)
    assert (sandbox.state_dir / "python").is_dir()
    check(sandbox, ["python", "-c", "import pipeline_probe; assert pipeline_probe.VALUE==42"])
    assert check(sandbox, ["pipeline-python-probe"]).strip() == "42"


def test_npm_user_prefix_persists(sandbox):
    package = sandbox.workspace / "probe"
    package.mkdir()
    (package / "package.json").write_text(json.dumps({"name": "pipeline-probe", "version": "1.0.0", "main": "index.js",
        "bin": {"pipeline-probe": "cli.js"}}))
    (package / "index.js").write_bytes(b"module.exports = 42;\n")
    (package / "cli.js").write_bytes(b"#!/usr/bin/env node\nconsole.log(42);\n")
    check(sandbox, ["npm", "pack", "./probe", "--offline", "--ignore-scripts"])
    check(sandbox, ["npm", "install", "--global", "--offline", "--ignore-scripts", "./pipeline-probe-1.0.0.tgz"], writable_state=True)
    check(sandbox, ["node", "-e", "if(require('pipeline-probe')!==42) process.exit(1)"])
    assert check(sandbox, ["pipeline-probe"]).strip() == "42"


def test_timeout_kills_container(sandbox):
    result = sandbox.run(["python", "-c", "import time; time.sleep(60)"], timeout_s=2,
                         log_path=sandbox.workspace.parent / "timeout.log")
    assert result.timed_out
    remaining = run_process(["docker", "ps", "-a", "-q", "--filter", f"label=scranton.pipeline.run={sandbox.run_id}"],
        cwd=sandbox.workspace, env=scrubbed_env(os.environ, ()), timeout_s=10)
    assert remaining.exit_code == 0 and not remaining.output_tail.strip()


def test_cleanup_only_own_label_with_unlabelled_decoy(sandbox):
    prefix = "scranton-pipeline-live-" + uuid.uuid4().hex[:10]
    names = [prefix + "-leak", prefix + "-decoy", prefix + "-created"]
    env = scrubbed_env(os.environ, ())

    def docker(args):
        return subprocess.run(["docker", *args], cwd=sandbox.workspace, env=env, shell=False,
                              capture_output=True, text=True, timeout=30, check=False)

    try:
        for index, name in enumerate(names[:2]):
            label = ["--label", f"scranton.pipeline.run={sandbox.run_id}"] if index == 0 else []
            result = docker(["run", "-d", "--rm", "--pull", "never", "--name", name, *label,
                             "--network", "none", "--read-only", "--user", "10001:10001",
                             "--entrypoint", "sleep", default_image(), "120"])
            assert result.returncode == 0, result.stderr
        created = docker(["create", "--pull", "never", "--name", names[2], "--label",
                          f"scranton.pipeline.run={sandbox.run_id}", default_image(), "true"])
        assert created.returncode == 0, created.stderr
        sandbox.cleanup()
        assert docker(["inspect", names[2]]).returncode != 0
        assert docker(["inspect", names[0]]).returncode != 0
        decoy = docker(["inspect", "--format", "{{.State.Running}}", names[1]])
        assert decoy.returncode == 0 and decoy.stdout.strip() == "true"
    finally:
        for name in names:
            docker(["rm", "-f", name])


def test_demo_docker_both_gates_separate_processes(tmp_path):
    env = dict(os.environ)
    run_root = tmp_path / "runs"
    run_id = uuid.uuid4().hex[:12]

    def cli(args, expected):
        result = subprocess.run([sys.executable, "-m", "scranton_pipeline", *args], env=env,
                                shell=False, capture_output=True, text=True, timeout=120, check=False)
        assert result.returncode == expected, result.stdout + result.stderr
        lines = result.stdout.splitlines()
        assert len(lines) == 1
        return json.loads(lines[0])

    status = cli(["demo", "--sandbox", "docker", "--run-root", str(run_root), "--run-id", run_id,
                  "--delivery", "apply"], 3)
    for gate, expected in (("plan", 3), ("delivery", 0)):
        assert status["pending"]["gate"] == gate
        status = cli(["resume", "--run-dir", str(run_root / run_id), "--gate", gate,
                      "--decision", "approve", "--digest", status["pending"]["digest"]], expected)
    print("Docker demo separate-process exits: 3 -> 3 -> 0; outcome:", status["status"])
    assert status["status"] == "succeeded" and status["delivery"]["applied"] is True
    assert status["sandbox"]["mode"] == "docker"
    assert all(check["status"] == "passed" for check in status["checks"])


def test_log_driver_none_keeps_attached_capped_output(sandbox):
    # Guard: --log-driver none must retain attached stdout while process.py bounds storage.
    path = sandbox.workspace.parent / "capped.log"
    result = sandbox.run(["python", "-c", "print('x'*100000); print('attached-marker')"],
                         timeout_s=30, log_path=path, max_log_bytes=128, tail_bytes=64)
    assert result.exit_code == 0 and result.output_bytes > 100000
    assert "attached-marker" in result.output_tail and len(result.output_tail.encode()) <= 64
    assert path.stat().st_size <= 128
    print("log-driver none: attached output", result.output_bytes, "bytes; log", path.stat().st_size, "bytes; tail", repr(result.output_tail))


def test_expired_sweep_preserves_unlabelled_future_and_malformed(sandbox):
    # Guard: sweep requires both the run label and a finite expired deadline, across runs.
    prefix = "scranton-pipeline-expiry-" + uuid.uuid4().hex[:10]
    specs = [("expired", "other-run", "1"), ("future", "other-run", "9999999999"),
             ("missing", "other-run", None), ("invalid", "other-run", "nan"), ("unlabelled", None, "1")]
    names = []

    def docker(args):
        return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=30, check=False)

    try:
        for suffix, run, deadline in specs:
            name = prefix + "-" + suffix
            names.append(name)
            labels = (["--label", "scranton.pipeline.run=" + run] if run else [])
            labels += ["--label", "scranton.pipeline.deadline=" + deadline] if deadline else []
            result = docker(["create", "--pull", "never", "--name", name, *labels, default_image(), "true"])
            assert result.returncode == 0, result.stderr
        sweep_expired()
        assert docker(["inspect", names[0]]).returncode != 0
        for name in names[1:]:
            assert docker(["inspect", name]).returncode == 0
        print("expired sweep: removed expired other-run container; preserved future, missing, invalid and unlabelled")
    finally:
        for name in names:
            docker(["rm", "-f", name])


def test_short_timeouts_remove_created_containers(sandbox):
    # Guard: run's finally calls _remove_container (rm -f), not kill on a Created container.
    for trial in range(5):
        result = sandbox.run(["python", "-c", "import time; time.sleep(60)"], timeout_s=.1,
                             log_path=sandbox.workspace.parent / f"short-timeout-{trial}.log")
        assert result.timed_out
        remaining = run_process(["docker", "ps", "-a", "-q", "--filter",
                                 f"label=scranton.pipeline.run={sandbox.run_id}"],
                                cwd=sandbox.workspace, env=scrubbed_env(os.environ, ()), timeout_s=10)
        assert remaining.exit_code == 0 and not remaining.output_tail.strip(), remaining.output_tail


def test_state_alias_and_mountpoint_attacks_do_not_poison_later_checks_or_lanes(sandbox):
    check(sandbox, ["python", "-c", "from pathlib import Path; Path('.pipeline/trusted').write_text('setup')"], writable_state=True)
    attack = """from pathlib import Path
for spelling in ('.pipeline', '.PIPELINE', '.PiPeLiNe'):
    p=Path('/workspace')/spelling
    try:
        p.mkdir(exist_ok=True)
        (p/'trusted').write_text('poison')
    except OSError:
        pass
    try:
        p.rename('/workspace/displaced-'+spelling)
        p.mkdir()
        (p/'trusted').write_text('replacement')
    except OSError:
        pass
print('alias and rename attacks attempted')
"""
    check(sandbox, ["python", "-c", attack])
    assert (sandbox.state_dir / "trusted").read_text() == "setup"
    check(sandbox, ["python", "-c", "from pathlib import Path; assert Path('.pipeline/trusted').read_text() == 'setup'"])
    lane = sandbox.workspace.with_name("lane")
    lane.mkdir()
    box = DockerSandbox(sandbox.cfg, lane, sandbox.run_id, state_dir=sandbox.state_dir, name_suffix="lane")
    check(box, ["python", "-c", "from pathlib import Path; assert Path('.pipeline/trusted').read_text() == 'setup'"])
    check(box, ["python", "-c", attack])
    check(sandbox, ["python", "-c", "from pathlib import Path; assert Path('.pipeline/trusted').read_text() == 'setup'"])
    repo = WorkspaceRepo.init(sandbox.workspace, sandbox.workspace.parent / "git")
    repo.commit_all("after attacks")
    assert not any(p.casefold().startswith('.pipeline/') for p in repo._run(["ls-files", "-z"]).split('\0'))
