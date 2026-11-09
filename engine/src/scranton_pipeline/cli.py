"""Machine-readable CLI. stdout is reserved for one result JSON line (except graph)."""
import argparse
import importlib.metadata
import json
import platform
import sys
from pathlib import Path
from typing import Any

from scranton_pipeline.config import Limits, load_config
from scranton_pipeline.errors import EngineError, FailureClass
from scranton_pipeline.observability import configure_logging
from scranton_pipeline.runner import EXIT, cancel, resume, start, status_run


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> Any:
        raise EngineError(FailureClass.INVALID_INPUT, "usage", message)


def parser() -> argparse.ArgumentParser:
    root = Parser(prog="scranton_pipeline")
    sub = root.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--source", type=Path, required=True)
    task = run.add_mutually_exclusive_group(required=True)
    task.add_argument("--task")
    task.add_argument("--task-file", type=Path)
    run.add_argument("--config", type=Path, required=True)
    for name, command in (("run", run), ("demo", sub.add_parser("demo"))):
        command.add_argument("--run-root", type=Path, required=True)
        command.add_argument("--workspace-root", type=Path)
        command.add_argument("--run-id")
        command.add_argument("--delivery", choices=("patch", "apply"), default="patch")
        command.add_argument("--parent-guard", action="store_true")
    run.add_argument("--trust-host", action="store_true")
    res = sub.add_parser("resume")
    res.add_argument("--run-dir", type=Path, required=True)
    res.add_argument("--gate", choices=("plan", "delivery"))
    res.add_argument("--decision", choices=("approve", "reject"))
    res.add_argument("--digest")
    res.add_argument("--comment", default="")
    res.add_argument("--trust-host", action="store_true")
    res.add_argument("--parent-guard", action="store_true")
    for name in ("status", "cancel"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--run-dir", type=Path, required=True)
        if name == "cancel":
            cmd.add_argument("--parent-guard", action="store_true")
    detect = sub.add_parser("detect")
    detect.add_argument("--source", type=Path, required=True)
    graph = sub.add_parser("graph")
    graph.add_argument("--format", choices=("mermaid",), default="mermaid")
    sub.add_parser("version")
    return root


def graph_text() -> str:
    # Compilation does not execute nodes or access dependencies other than configuration.
    from types import SimpleNamespace

    from scranton_pipeline.demo.fixture import config
    from scranton_pipeline.graph import build_graph
    return str(build_graph(SimpleNamespace(cfg=config(Path.cwd()), checkpointer=None)).get_graph().draw_mermaid())  # type: ignore[arg-type]


def main(argv: list[str] | None = None) -> int:
    configure_logging()
    try:
        args = parser().parse_args(argv)
        command = args.command
        result: Any
        if command == "version":
            result = {"version": "0.1.0", "python": platform.python_version(), "langgraph": importlib.metadata.version("langgraph")}
        elif command == "graph":
            print(graph_text())
            return 0
        elif command == "detect":
            from scranton_pipeline.config import DEFAULT_PROTECTED, DEFAULT_WRITE_PROTECTED
            from scranton_pipeline.tools.fs import PathPolicy
            from scranton_pipeline.tools.git import list_source_files
            from scranton_pipeline.tools.repo_index import build_index, detect_checks, detect_setup
            files, git = list_source_files(args.source, timeout_s=30)
            policy = PathPolicy(args.source, DEFAULT_PROTECTED, DEFAULT_WRITE_PROTECTED)
            files = [p for p in files if not policy.is_protected(p) and not policy.resolve(p).is_symlink()]
            index = build_index(args.source, files, limits=Limits())
            result = {"git": git, "languages": index.languages, "checks": detect_checks(index), "setup": detect_setup(index)}
        elif command == "demo":
            from scranton_pipeline.demo.fixture import run_demo
            result = run_demo(args.run_root, run_id=args.run_id, workspace_root=args.workspace_root,
                              delivery=args.delivery, guarded=args.parent_guard)
        elif command == "run":
            cfg = load_config(args.config)
            if args.task_file:
                with args.task_file.open("rb") as stream:
                    task = stream.read(32769).decode("utf-8")
            else:
                task = args.task
            result = start(source=args.source, task=task, cfg=cfg, run_root=args.run_root, run_id=args.run_id,
                           workspace_root=args.workspace_root, delivery=args.delivery,
                           trust_host=args.trust_host, guarded=args.parent_guard)
        elif command == "resume":
            result = resume(args.run_dir, gate=args.gate, decision=args.decision, digest=args.digest,
                            comment=args.comment, trust_host=args.trust_host, guarded=args.parent_guard)
        elif command == "cancel":
            result = cancel(args.run_dir, guarded=args.parent_guard)
        else:
            result = status_run(args.run_dir)
        if hasattr(result, "model_dump"):
            print(json.dumps(result.model_dump(mode="json", by_alias=True)))
            return EXIT[result.status]
        print(json.dumps(result))
        return 0
    except (EngineError, OSError, ValueError) as exc:
        error = exc if isinstance(exc, EngineError) else EngineError(FailureClass.INVALID_INPUT, "invalid_input", "Invalid input or inaccessible run files")
        print(json.dumps({"status": "error", "failure": error.to_failure("cli")}))
        return 2
    except Exception as exc:  # noqa: BLE001 - lifecycle boundary preserves resumability
        print(f"Internal CLI error: {type(exc).__name__}", file=sys.stderr)
        print(json.dumps({"status": "error", "failure": {"failure_class": "infrastructure", "code": "internal_error", "message": "Unexpected CLI failure", "node": "cli"}}))
        return 5
