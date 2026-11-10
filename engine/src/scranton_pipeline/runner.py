"""Synchronous, single-owner run lifecycle over durable SQLite checkpoints."""
import importlib
import json
import logging
import os
import re
import sqlite3
import sys
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, cast

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.errors import GraphRecursionError
from langgraph.types import Command

from scranton_pipeline.agents.gateway import ChatModelGateway
from scranton_pipeline.agents.providers import Role, build_chat_model
from scranton_pipeline.config import EngineConfig, config_digest, load_config
from scranton_pipeline.errors import EngineError, FailureClass
from scranton_pipeline.graph import build_graph
from scranton_pipeline.grounding import append_trace
from scranton_pipeline.guidance import pinned
from scranton_pipeline.limits import recursion_limit
from scranton_pipeline.models import RunStatus
from scranton_pipeline.nodes.common import Dependencies, cleanup_provider
from scranton_pipeline.nodes.workflow import cleanup_sandbox, json_write
from scranton_pipeline.observability import EventLog, UsageLedger, read_status, write_status
from scranton_pipeline.procedure import digest as procedure_digest
from scranton_pipeline.procedure import load as load_procedure
from scranton_pipeline.report import finalize_out_of_band, make_status, now
from scranton_pipeline.state import PipelineState
from scranton_pipeline.tools.process import StopSignal
from scranton_pipeline.tools.secrets import Redactor

EXIT = {"succeeded": 0, "awaiting_approval": 3, "failed": 4, "suspended": 5, "cancelled": 6, "rejected": 6, "running": 0}
TERMINAL = {"succeeded", "failed", "cancelled", "rejected"}


def invalid(code: str, message: str) -> EngineError:
    return EngineError(FailureClass.INVALID_INPUT, code, message)


@contextmanager
def owner(run_dir: Path) -> Iterator[None]:
    stream = (run_dir / "lock").open("a+b")
    try:
        if stream.seek(0, 2) == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl: Any = importlib.import_module("fcntl")
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise invalid("run_active", "Run already has an owner") from None
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl = importlib.import_module("fcntl")
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
    finally:
        stream.close()


def parent_guard(stop: StopSignal) -> None:
    def watch() -> None:
        for line in sys.stdin:
            if line.strip() == "stop":
                break
        stop.request_suspend()
    threading.Thread(target=watch, daemon=True).start()


@contextmanager
def dependencies(run_dir: Path, cfg: EngineConfig, *, trust_host: bool,
                 guarded: bool = False, models: bool = True) -> Iterator[Dependencies]:
    metadata = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
    procedure = pinned(run_dir, cfg.procedure.enabled)
    secrets = [value for name, value in os.environ.items() if name.startswith("SCRANTON_PIPELINE_KEY_") or (
        re.search("KEY|TOKEN|SECRET|PASSWORD", name, re.IGNORECASE) and len(value) >= 12
        and value.casefold() not in {"true", "false", "none", "null", "yes", "no", "enabled", "disabled", "undefined", "development", "production", "default", "password", "changeme"}
        and not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", value) and not Path(value).exists())]
    secrets += [os.environ.get(getattr(cfg.models, role).api_key_env, "") for role in ("planner", "implementer", "reviewer")]
    redactor = Redactor(v for v in secrets if v)
    ledger = UsageLedger(run_dir / "usage.jsonl")
    events = EventLog(run_dir / "events.jsonl", run_dir.name, redactor)
    stop = StopSignal(run_dir / "cancel.requested")
    if guarded:
        parent_guard(stop)
    roles: tuple[Role, ...] = ("planner", "implementer", "reviewer")
    chat = {r: build_chat_model(getattr(cfg.models, r), os.environ, ledger=ledger, role=r, run_dir=run_dir, stop=stop) for r in roles} if models else {}
    gateway = ChatModelGateway(chat, cfg, ledger, events)
    connection = sqlite3.connect(run_dir / "checkpoints.sqlite", check_same_thread=False)
    try:
        yield Dependencies(cfg, run_dir, Path(metadata["workspace"]), gateway, ledger, events, stop, redactor,
                           trust_host=trust_host, checkpointer=SqliteSaver(connection), procedure=procedure)
    finally:
        connection.close()


def validate_trust(cfg: EngineConfig, trust_host: bool) -> None:
    if cfg.sandbox.mode == "host" and not trust_host:
        raise invalid("host_trust_required", "Host sandbox requires --trust-host on every invocation")


def start(*, source: Path, task: str, cfg: EngineConfig, run_root: Path, run_id: str | None = None,
          workspace_root: Path | None = None, delivery: str = "patch", trust_host: bool = False,
          guarded: bool = False, demo: bool = False, demo_scenario: str = "basic") -> RunStatus:
    procedure = load_procedure(Path(cfg.procedure.graph) if cfg.procedure.graph else None) if cfg.procedure.enabled else None
    validate_trust(cfg, trust_host)
    run_id = run_id or uuid.uuid4().hex[:12]
    if not re.fullmatch("[a-z0-9]{8,32}", run_id):
        raise invalid("invalid_run_id", "run-id must be 8..32 lowercase letters/digits")
    if not task.strip() or len(task.encode()) > 32768 or (not demo and not source.is_dir()):
        raise invalid("invalid_request", "Task must be nonempty (<=32768 bytes), source must be a directory")
    source = source.resolve()
    run_dir = (run_root / run_id).resolve()
    workspace = ((workspace_root / run_id) if workspace_root else run_dir / "workspace").resolve()
    if not demo and any(a.is_relative_to(b) or b.is_relative_to(a) for a, b in ((source, run_dir), (source, workspace))):
        raise invalid("overlapping_paths", "Source, run directory and workspace must not overlap")
    if workspace != run_dir / "workspace" and (workspace.is_relative_to(run_dir) or run_dir.is_relative_to(workspace)):
        raise invalid("overlapping_paths", "External workspace overlaps run directory")
    if workspace.exists():
        raise invalid("workspace_exists", "Workspace already exists")
    # Validate model construction before creating a run directory.
    for role in ("planner", "implementer", "reviewer"):
        model = getattr(cfg.models, role)
        if model.provider == "scripted" and not demo:
            try:
                script = json.loads(Path(model.script_path).read_text(encoding="utf-8"))
                if not isinstance(script, (list, dict)):
                    raise invalid("invalid_script", "Script must be an array or a scope map")
            except (OSError, ValueError) as exc:
                raise invalid("invalid_script", "Cannot load scripted model responses") from exc
        elif model.provider == "openai_compatible" and not os.environ.get(model.api_key_env):
            raise invalid("api_key_missing", "Configured API key environment variable is missing")
    try:
        run_dir.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        raise invalid("run_exists", "Run directory already exists") from None
    (run_dir / "artifacts" / "logs").mkdir(parents=True)
    (run_dir / "delivery").mkdir()
    if procedure is not None:
        json_write(run_dir / "artifacts" / "procedure.json", procedure.model_dump(mode="json", by_alias=True))
    if demo:
        from scranton_pipeline.demo.fixture import materialize
        materialize(run_dir, demo_scenario)
    json_write(run_dir / "config.json", cfg.model_dump(mode="json", by_alias=True))
    json_write(run_dir / "run.json", {"run_id": run_id, "task": task, "source_dir": str(source), "delivery_mode": delivery,
        "created_at": now(), "config_digest": config_digest(cfg), "engine_version": "0.1.0", "workspace": str(workspace), "demo": demo,
        **({"procedure": {"enabled": True, "name": procedure.name, "digest": procedure_digest(procedure)}} if procedure is not None else {})})
    initial: PipelineState = {"run_id": run_id, "task": task, "source_dir": str(source), "delivery_mode": delivery,
        "step_index": -1, "mode": "step", "counters": {}, "active_seconds": 0.0, "history": [],
        "plan_revision": 0, "plan_revisions": [], "steps_done": [], "failure": None, "outcome": "", "review_round": 0}
    with owner(run_dir), dependencies(run_dir, cfg, trust_host=trust_host, guarded=guarded) as deps:
        append_trace(run_dir, {"type": "settings", "mode": cfg.grounding.mode, "weights": cfg.grounding.weights.model_dump()})
        cleanup_provider(deps)
        cleanup_sandbox(deps)
        deps.events.emit("run_started")
        return drive(deps, initial)


def suspension_detail(exc: Exception, deps: Dependencies) -> dict[str, Any]:
    def local(match: re.Match[str]) -> str:
        value = match.group(0)
        try:
            return Path(value).relative_to(deps.run_dir).as_posix()
        except ValueError:
            return "[external-path]"
    message = re.sub(r"[A-Za-z]:[\\/][^'\"\r\n]*|(?<![\w:])/[^'\"\s]*", local, str(exc))
    frame = ""
    trace = exc.__traceback__
    while trace is not None:
        module = trace.tb_frame.f_globals.get("__name__", "")
        if module.startswith("scranton_pipeline."):
            frame = module + ":" + trace.tb_frame.f_code.co_name
        trace = trace.tb_next
    return {"exception": type(exc).__name__, "exception_message": deps.redactor.redact(message)[:2000],
        "errno": getattr(exc, "errno", None), "winerror": getattr(exc, "winerror", None), "engine_frame": frame}


def drive(deps: Dependencies, value: Any = None) -> RunStatus:
    graph = build_graph(deps)
    config = {"configurable": {"thread_id": deps.run_dir.name}, "recursion_limit": recursion_limit(deps.cfg.limits),
              "max_concurrency": max(2, deps.cfg.execution.max_parallel_steps)}
    existing = graph.get_state(config).values
    if existing:
        write_status(deps.run_dir, make_status(existing, deps, node=(graph.get_state(config).next or ("prepare_workspace",))[0]))
    elif isinstance(value, dict):
        write_status(deps.run_dir, make_status(cast(PipelineState, value), deps, node="prepare_workspace"))
    try:
        result = graph.invoke(value, config, durability="sync")
        state = graph.get_state(config).values
        if result.get("__interrupt__"):
            payload = result["__interrupt__"][0].value
            pending = {**payload, "path": payload.get("plan_path", payload.get("diff_path"))}
            pending.pop("plan_path", None)
            pending.pop("diff_path", None)
            node = "approve_plan" if payload["gate"] == "plan" else "approve_delivery"
            status = make_status(state, deps, status="awaiting_approval", node=node, pending=pending)
            deps.events.emit("gate_waiting", gate=payload["gate"], digest=payload["digest"])
            write_status(deps.run_dir, status)
            return status
        finished = read_status(deps.run_dir)
        assert finished is not None
        return finished
    except GraphRecursionError:
        state = graph.get_state(config).values
        state["failure"] = EngineError(FailureClass.LIMIT, "recursion_limit", "Graph recursion backstop reached").to_failure("runner")
        finalize_out_of_band(state, deps)
        finished = read_status(deps.run_dir)
        assert finished is not None
        return finished
    except Exception as exc:  # noqa: BLE001 - lifecycle boundary preserves resumability
        state = graph.get_state(config).values or (value if isinstance(value, dict) else {})
        detail = suspension_detail(exc, deps)
        deps.events.emit("warning", code="suspended", message=f"Execution suspended ({type(exc).__name__})", **detail)
        logging.getLogger(__name__).warning(json.dumps({"run_id": deps.run_dir.name, "code": "suspended", **detail}))
        status = make_status(cast(PipelineState, state), deps, status="suspended", node=(graph.get_state(config).next or ("",))[0])
        write_status(deps.run_dir, status)
        return status


def resume(run_dir: Path, *, gate: str | None = None, decision: str | None = None, digest: str | None = None,
           comment: str = "", trust_host: bool = False, guarded: bool = False, cancelling: bool = False, by: str = "human") -> RunStatus:
    if by not in {"human", "eval"}:
        raise invalid("invalid_decider", "Gate decider must be human or eval")
    run_dir = run_dir.resolve()
    cfg = load_config(run_dir / "config.json")
    metadata = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
    pinned(run_dir, cfg.procedure.enabled)
    validate_trust(cfg, trust_host or metadata.get("demo", False) or cancelling)
    if config_digest(cfg) != metadata["config_digest"]:
        raise invalid("config_changed", "Copied run configuration changed")
    with owner(run_dir):
        pinned(run_dir, cfg.procedure.enabled)
        status = read_status(run_dir)
        if status is None:
            raise invalid("missing_status", "Run status missing")
        if status.status in TERMINAL:
            if gate:
                raise invalid("not_waiting", "Run is already terminal")
            with dependencies(run_dir, cfg, trust_host=trust_host or metadata.get("demo", False), models=False) as deps:
                cleanup_provider(deps)
            return status
        value: Any = None
        if not cancelling:
            if status.pending:
                if gate != status.pending["gate"] or digest != status.pending["digest"] or decision not in {"approve", "reject"}:
                    raise invalid("stale_digest", "Decision must match the pending gate and digest")
                # Also bind to the checkpoint payload, not only an editable status snapshot.
                value = Command(resume={"decision": decision, "digest": digest, "comment": comment, "by": by})
            elif gate or decision or digest:
                raise invalid("not_waiting", "Run is not waiting at a gate")
        with dependencies(run_dir, cfg, trust_host=trust_host or metadata.get("demo", False), guarded=guarded, models=not cancelling) as deps:
            if status.pending and not cancelling:
                graph = build_graph(deps)
                snapshot = graph.get_state({"configurable": {"thread_id": run_dir.name}})
                payloads = [i.value for t in snapshot.tasks for i in t.interrupts]
                if not payloads or payloads[0]["digest"] != digest or payloads[0]["gate"] != gate:
                    raise invalid("stale_digest", "Decision disagrees with checkpoint gate")
                path = Path(status.pending["path"])
                from scranton_pipeline.tools.fs import sha256_file
                artifact_digest = sha256_file(path)
                if gate == "delivery":
                    from scranton_pipeline.grounding import digest as grounding_digest
                    artifact_digest = grounding_digest({"diff_sha256": artifact_digest, "grounding": payloads[0]["grounding"], "risk_flags": payloads[0]["risk_flags"]})
                if artifact_digest != digest:
                    raise invalid("stale_digest", "Gate artifact changed")
            cleanup_provider(deps)
            cleanup_sandbox(deps)
            deps.events.emit("run_resumed")
            return drive(deps, value)


def status_run(run_dir: Path) -> RunStatus:
    status = read_status(run_dir)
    if status is None:
        raise invalid("missing_run", "Run status does not exist")
    if status.status == "running":
        try:
            with owner(run_dir):
                status = status.model_copy(update={"status": "suspended", "resumable": True, "pid": None, "updated_at": now()})
                write_status(run_dir, status)
        except EngineError as exc:
            if exc.code != "run_active":
                raise
    return status


def cancel(run_dir: Path, *, guarded: bool = False) -> RunStatus:
    status = status_run(run_dir)
    if status.status in TERMINAL:
        return status
    (run_dir / "cancel.requested").touch()
    try:
        return resume(run_dir, cancelling=True, guarded=guarded)
    except EngineError as exc:
        if exc.code != "run_active":
            raise
        return status_run(run_dir)
