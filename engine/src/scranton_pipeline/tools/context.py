"""Literal, byte-bounded read requests over a supplied file inventory."""
import json
from collections.abc import Sequence
from pathlib import Path

from ..config import Limits
from ..errors import EngineError, FailureClass
from ..models import ContextItem, ContextRequest
from .fs import PathPolicy, read_text, sha256_file
from .secrets import Redactor


def normalize_request(request: ContextRequest, policy: PathPolicy) -> ContextRequest:
    path = request.path.replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    if path == ".":
        path = ""
    elif path.endswith("/"):
        path = path[:-1]
    if path:
        policy.resolve(path)
        if policy.is_protected(path):
            raise EngineError(FailureClass.SECURITY, "protected_path", "Protected path")
    elif request.path.startswith(("/", "\\")):
        raise EngineError(FailureClass.SECURITY, "unsafe_path", "Invalid relative path")
    return request.model_copy(update={"path": path})


def request_error(request: ContextRequest, redactor: Redactor) -> str:
    locator = f'{request.kind} path={json.dumps(redactor.redact(request.path), ensure_ascii=False)}'[:80]
    return locator + ': protected or invalid. Use a relative path inside the project; an empty path searches or lists the whole project.'


def fulfil(requests: Sequence[ContextRequest], *, workspace: Path, policy: PathPolicy, files: Sequence[str],
           limits: Limits, redactor: Redactor) -> list[ContextItem]:
    remaining = limits.max_context_bytes
    results = []
    for request in requests:
        original = request
        try:
            request = normalize_request(request, policy)
        except EngineError:
            results.append(ContextItem(request=original, ok=False, content="", truncated=False, note=request_error(original, redactor)))
            continue
        if remaining <= 0:
            results.append(ContextItem(request=request, ok=False, content="", truncated=True, note="Context budget exhausted"))
            continue
        content = ""
        truncated = False
        try:
            path = policy.resolve(request.path) if request.path else workspace.resolve()
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
            results.append(ContextItem(request=request, ok=False, content="", truncated=False, note=redactor.redact(str(exc))))
        except OSError:
            results.append(ContextItem(request=request, ok=False, content="", truncated=False, note="Path unavailable"))
    from scranton_pipeline.grounding import context_id
    stamped = []
    for item in results:
        sha = sha256_file(policy.resolve(item.request.path)) if item.ok and item.request.kind == "read" else ""
        raw = {**item.model_dump(mode="json"), "sha256": sha}
        stamped.append(item.model_copy(update={"sha256": sha, "evidence_id": context_id(raw)}))
    return stamped
