"""Explicit runtime dependencies shared by the fixed graph nodes."""
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from scranton_pipeline.agents.gateway import ModelGateway
from scranton_pipeline.config import DEFAULT_PROTECTED, DEFAULT_WRITE_PROTECTED, EngineConfig
from scranton_pipeline.observability import EventLog, UsageLedger
from scranton_pipeline.procedure import Graph
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
    procedure: Graph | None = field(default=None, kw_only=True)
    trust_host: bool = False
    checkpointer: Any = None
    git_warning_emitted: bool = False
    lane_suffix: str = ""
    git_dir: Path | None = None
    wave_clocks: dict[int, tuple[float, float]] = field(default_factory=dict)

    def procedure_event(self, role: str, state: PipelineState) -> None:
        from scranton_pipeline.guidance import situation
        active = situation(role, state)
        self.events.emit("procedure", role=role, scope=f"plan:r{state.get('plan_revision', 0)}" if role == "planner" else f"review:{state.get('review_round', 0)}" if role == "reviewer" else scope_id(state), situation=active,
                         matched=self.procedure is not None and any(n.id == active for n in self.procedure.nodes))

    def policy(self) -> PathPolicy:
        return PathPolicy(self.workspace, [*DEFAULT_PROTECTED, *self.cfg.policy.protected_paths],
                          [*DEFAULT_WRITE_PROTECTED, *self.cfg.policy.write_protected_paths])

    def repo(self) -> WorkspaceRepo:
        if (self.workspace / ".git").exists() and not self.git_warning_emitted:
            self.git_warning_emitted = True
            if not self.events.path.exists() or '"workspace_git_ignored"' not in self.events.path.read_text(encoding="utf-8"):
                self.events.emit("warning", code="workspace_git_ignored", message="Workspace .git entry ignored")
        return WorkspaceRepo(self.workspace, self.git_dir or self.run_dir / "git", timeout_s=self.cfg.limits.git_timeout_s)


def scope_id(state: PipelineState) -> str:
    if state.get("mode") == "integration":
        return f"int:{state['wave']['number']}"
    if state.get("mode") == "revision":
        return f"rev:{state.get('review_round', 0)}"
    step = current_step(state)
    return "step:" + step.id if step else "step:unknown"


def cleanup_provider(deps: Dependencies) -> None:
    import shutil
    for path in (deps.run_dir / "tmp" / "provider").glob("call-*"):
        try:
            if path.is_symlink() or path.is_file():
                path.unlink()
            else:
                shutil.rmtree(path)
        except OSError:
            deps.events.emit("warning", code="cleanup_failed", message="Provider scratch cleanup failed")


def planning_key(state: PipelineState, kind: str) -> str:
    return f"plan_{kind}:r{state.get('plan_revision', 0)}"
