"""Explicit runtime dependencies shared by the fixed graph nodes."""
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from scranton_pipeline.agents.gateway import ModelGateway
from scranton_pipeline.config import DEFAULT_PROTECTED, DEFAULT_WRITE_PROTECTED, EngineConfig
from scranton_pipeline.observability import EventLog, UsageLedger
from scranton_pipeline.state import PipelineState, current_step
from scranton_pipeline.tools.fs import PathPolicy
from scranton_pipeline.tools.git import WorkspaceRepo
from scranton_pipeline.tools.process import StopSignal
from scranton_pipeline.tools.secrets import Redactor


@dataclass
class Dependencies:
    cfg: EngineConfig
    run_dir: Path
    workspace: Path
    gateway: ModelGateway
    ledger: UsageLedger
    events: EventLog
    stop: StopSignal
    redactor: Redactor
    trust_host: bool = False
    checkpointer: Any = None
    git_warning_emitted: bool = False

    def policy(self) -> PathPolicy:
        return PathPolicy(self.workspace, [*DEFAULT_PROTECTED, *self.cfg.policy.protected_paths],
                          [*DEFAULT_WRITE_PROTECTED, *self.cfg.policy.write_protected_paths])

    def repo(self) -> WorkspaceRepo:
        if (self.workspace / ".git").exists() and not self.git_warning_emitted:
            self.git_warning_emitted = True
            if not self.events.path.exists() or '"workspace_git_ignored"' not in self.events.path.read_text(encoding="utf-8"):
                self.events.emit("warning", code="workspace_git_ignored", message="Workspace .git entry ignored")
        return WorkspaceRepo(self.workspace, self.run_dir / "git", timeout_s=self.cfg.limits.git_timeout_s)


def scope_id(state: PipelineState) -> str:
    if state.get("mode") == "revision":
        return f"rev:{state.get('review_round', 0)}"
    step = current_step(state)
    return "step:" + step.id if step else "step:unknown"
