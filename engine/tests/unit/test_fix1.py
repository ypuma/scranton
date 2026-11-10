"""Round-one regressions; Guard comments name the exact production reversal."""
import os
import sys

import pytest
from test_process_git import _assert_dead

from scranton_pipeline.config import (
    COMMAND_ID_PATTERN,
    CheckConfig,
    CommandConfig,
    Limits,
)
from scranton_pipeline.errors import EngineError
from scranton_pipeline.models import FileEdit
from scranton_pipeline.tools.fs import PathPolicy, is_dependency_manifest
from scranton_pipeline.tools.git import WorkspaceRepo
from scranton_pipeline.tools.patches import validate_and_apply
from scranton_pipeline.tools.process import run_process, scrubbed_env
from scranton_pipeline.tools.secrets import Redactor


def test_git_metadata_hook_filter_and_stray_git_are_untrusted(tmp_path):
    # Guard: WorkspaceRepo._run supplies external git_dir; reverting to workspace/.git executes the payloads.
    workspace = tmp_path / "workspace"
    repo = WorkspaceRepo.init(workspace)
    assert not (workspace / ".git").exists()
    assert not repo.git_dir.is_relative_to(workspace)
    (workspace / "a.txt").write_text("old\n")
    repo.commit_all("baseline")
    rogue = workspace / ".git"
    (rogue / "disabled-hooks").mkdir(parents=True)
    marker = tmp_path / "escaped"
    hook = rogue / "disabled-hooks" / "pre-commit"
    hook.write_text(f'#!/bin/sh\necho hook > "{marker.as_posix()}"\n')
    hook.chmod(0o755)
    (rogue / "config").write_text('[filter "evil"]\n clean = echo escaped > "' + marker.as_posix() + '"\n')
    (workspace / ".gitattributes").write_text("*.txt filter=evil\n")
    (workspace / "a.txt").write_text("new\n")
    repo.commit_paths(["a.txt"], "safe attempt")
    (workspace / "a.txt").write_text("damage\n")
    assert repo.restore_tracked() == ["a.txt"]
    assert (workspace / "a.txt").read_text() == "new\n"
    assert not marker.exists()
    assert (rogue / "config").exists()


@pytest.mark.skipif(os.name != "nt", reason="Windows shim semantics")
def test_real_cmd_safe_args_exit_output_and_owned_tree(tmp_path):
    # Guard: run_process shim command construction plus existing Job assignment before resume.
    shim = tmp_path / "shim with spaces.cmd"
    shim.write_text('@echo off\necho argument=%1\nexit /b 17\n')
    result = run_process([str(shim), "test-safe_1", "--flag=x", "./..."], cwd=tmp_path,
                         env=scrubbed_env(os.environ, []), timeout_s=5)
    assert result.exit_code == 17 and "argument=test-safe_1" in result.output_tail
    child = tmp_path / "child.py"
    child.write_text("import os,time\nfrom pathlib import Path\nPath('child.pid').write_text(str(os.getpid()))\ntime.sleep(60)\n")
    shim.write_text(f'@echo off\n"{sys.executable}" child.py\n')
    result = run_process([str(shim)], cwd=tmp_path, env=scrubbed_env(os.environ, []), timeout_s=2)
    assert result.timed_out
    _assert_dead(int((tmp_path / "child.pid").read_text()))


@pytest.mark.skipif(os.name != "nt", reason="Windows shim semantics")
@pytest.mark.parametrize("arg", ['"quoted"', "a&b", "a|b", "a<b", "a>b", "a^b", "%PATH%", "!VAR!",
                                    "two words", "a\tb", "a\nb", "a\rb", "a\x01b", "", "a(b)"])
def test_shim_unsafe_argument_refused_before_start(tmp_path, arg):
    # Guard: conservative fullmatch in run_process; no Popen may run for any unsafe class.
    shim = tmp_path / "shim.cmd"
    shim.write_text("@echo off\necho started > started\n")
    with pytest.raises(EngineError) as raised:
        run_process([str(shim), arg], cwd=tmp_path, env=scrubbed_env(os.environ, []), timeout_s=5)
    assert raised.value.code == "unsafe_shim_arguments"
    assert raised.value.failure_class == "invalid_input"
    assert not (tmp_path / "started").exists()


@pytest.mark.parametrize("name", ["Package.json", "PYPROJECT.TOML", "requirements-dev.TXT", "SETUP.PY", "setup.CFG",
                                   "Pipfile", "CARGO.TOML", "GO.MOD", "POM.XML", "BUILD.GRADLE", "build.gradle.KTS",
                                   "Gemfile", "COMPOSER.JSON", "App.CSPROJ"])
def test_shared_manifest_guard_case_and_ecosystems(tmp_path, name):
    # Guard: is_dependency_manifest casefold/patterns and patches' resolved declared-path check.
    assert is_dependency_manifest(tmp_path / name)
    result = validate_and_apply([FileEdit(path=name, action="create", content="{}")], workspace=tmp_path,
        policy=PathPolicy(tmp_path, (), ()), declared=[], scope="plan_plus_flagged", undeclared_budget=2, limits=Limits())
    assert not result.ok and not (tmp_path / name).exists()


@pytest.mark.parametrize("name", [".ENV", ".GIT/config", "CARGO.LOCK", "PACKAGE-LOCK.JSON"])
def test_protection_casefold_on_all_hosts(tmp_path, name):
    # Guard: PathPolicy._matches always casefolds; not just on Windows.
    assert PathPolicy(tmp_path, (".env", ".git/**"), ("Cargo.lock", "package-lock.json")).is_write_protected(name)


@pytest.mark.parametrize("action", ["create", "modify", "replacement"])
def test_redaction_marker_never_written_back(tmp_path, action):
    # Guard: patches rejects new marker before adding any proposed write.
    target = tmp_path / "code.py"
    if action != "create":
        target.write_text("password = get_password()\n")
    edit = FileEdit(path="code.py", action="create" if action == "create" else "modify",
                    **({"replacements": [{"search": "password = get_password()", "replace": "[REDACTED]"}]}
                       if action == "replacement" else {"content": "[REDACTED]\n"}))
    result = validate_and_apply([edit], workspace=tmp_path, policy=PathPolicy(tmp_path, (), ()),
        declared=["code.py"], scope="strict", undeclared_budget=0, limits=Limits())
    assert not result.ok and "redaction marker" in result.rejected[0]
    assert not target.exists() if action == "create" else target.read_text() == "password = get_password()\n"


def test_redaction_preserves_code_expressions_but_masks_values():
    # Guard: secrets credential regex requires quoted values or a complete bare value (not calls/expressions).
    redactor = Redactor()
    for code in ("password = get_password()", "secret = settings.secret", "api_key = os.getenv('KEY')"):
        assert redactor.redact(code) == code
    for value in ('password="actual credential"', 'secret:1', "password=hidden"):
        assert "[REDACTED]" in redactor.redact(value)


@pytest.mark.parametrize("model", [CommandConfig, CheckConfig])
def test_command_id_rule_is_shared_and_named(model):
    # Guard: CommandConfig.id Field uses COMMAND_ID_PATTERN (inherited by CheckConfig).
    assert COMMAND_ID_PATTERN == r"^[A-Za-z0-9_-]{1,64}$"
    assert model(id="a_1-Z", argv=["safe"]).id == "a_1-Z"
    with pytest.raises(ValueError, match="id"):
        model(id="bad.id", argv=["safe"])
