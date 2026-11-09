"""Literal, byte-bounded read requests over a supplied file inventory."""
from collections.abc import Sequence
from pathlib import Path

from ..config import Limits
from ..errors import EngineError, FailureClass
from ..models import ContextItem, ContextRequest
from .fs import PathPolicy, read_text
from .secrets import Redactor


def fulfil(requests: Sequence[ContextRequest], *, workspace: Path, policy: PathPolicy, files: Sequence[str],
           limits: Limits, redactor: Redactor) -> list[ContextItem]:
    remaining = limits.max_context_bytes
    results = []
    for request in requests:
        path = policy.resolve(request.path) if request.path else workspace.resolve()
        if request.path and policy.is_protected(request.path):
            results.append(ContextItem(request=request, ok=False, content="", truncated=False, note="Protected path"))
            continue
        if remaining <= 0:
            results.append(ContextItem(request=request, ok=False, content="", truncated=True, note="Context budget exhausted"))
            continue
        content = ""
        truncated = False
        try:
            if request.kind == "read":
                if not request.path:
                    raise EngineError(FailureClass.IMPLEMENTATION, "not_file", "Read requires a file")
                text, truncated = read_text(path, limits.max_file_bytes)
                lines = text.splitlines(keepends=True)
                content = "".join(lines[(request.start_line or 1) - 1:request.end_line])
            elif request.kind == "list":
                prefix = request.path.rstrip("/") + "/" if request.path else ""
                entries = set()
                for rel in files:
                    policy.resolve(rel)
                    if rel.startswith(prefix) and not policy.is_protected(rel):
                        entries.add(rel[len(prefix):].split("/")[0])
                content = "\n".join(sorted(entries))
            else:
                matches: list[str] = []
                for rel in sorted(files):
                    target = policy.resolve(rel)
                    if policy.is_protected(rel) or (request.path and rel != request.path and not rel.startswith(request.path + "/")):
                        continue
                    try:
                        text, cut = read_text(target, limits.max_file_bytes)
                    except (OSError, EngineError):
                        continue
                    truncated = truncated or cut
                    for number, line in enumerate(text.splitlines(), 1):
                        if request.query in line:
                            if len(matches) == limits.max_search_matches:
                                truncated = True
                                break
                            matches.append(f"{rel}:{number}: {line}")
                    if len(matches) == limits.max_search_matches:
                        break
                content = "\n".join(matches)
            data = redactor.redact(content).encode("utf-8")
            cap = min(remaining, limits.max_context_item_bytes)
            truncated = truncated or len(data) > cap
            content = data[:cap].decode("utf-8", errors="ignore")
            remaining -= len(content.encode())
            results.append(ContextItem(request=request, ok=True, content=content, truncated=truncated))
        except EngineError as exc:
            if exc.failure_class == FailureClass.SECURITY:
                raise
            results.append(ContextItem(request=request, ok=False, content="", truncated=False, note=redactor.redact(str(exc))))
        except OSError:
            results.append(ContextItem(request=request, ok=False, content="", truncated=False, note="Path unavailable"))
    return results
