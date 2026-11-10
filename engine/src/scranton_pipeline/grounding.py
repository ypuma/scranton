"""Content-addressed evidence and deterministic trace scoring (no model or clock)."""
import hashlib
import json
import re
from collections import Counter
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from scranton_pipeline.observability import _append, _rows
from scranton_pipeline.tools._locking import file_lock
from scranton_pipeline.tools.secrets import Redactor


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


def evidence_id(prefix: str, item: Any) -> str:
    return prefix + "-" + digest(item)[:10]


def context_id(item: dict[str, Any]) -> str:
    return evidence_id("E", {k: item.get(k) for k in ("request", "sha256", "content", "ok", "truncated")})


def check_id(item: dict[str, Any], stage: str, commit: str) -> str:
    return evidence_id("K", {"check_id": item["id"], "stage": stage, "commit": commit,
        "status": item["status"], "exit_code": item["exit_code"], "sha256": hashlib.sha256(item.get("output_tail", "").encode()).hexdigest()})


def diff_hunks(diff: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    path = ""
    header: list[str] = []
    chunk: list[str] = []
    def finish() -> None:
        if chunk:
            text = "".join(header + chunk)
            result.append({"evidence_id": evidence_id("H", {"path": path, "content": text}), "path": path, "content": text})
    for line in diff.splitlines(keepends=True):
        if line.startswith("diff --git "):
            finish()
            header, chunk = [line], []
            path = line.rstrip().split(" b/", 1)[-1].strip('"')
        elif line.startswith("@@"):
            finish()
            chunk = [line]
        elif chunk:
            chunk.append(line)
        else:
            header.append(line)
    finish()
    return result


def register(run_dir: Path, rows: Iterable[dict[str, Any]]) -> None:
    path = run_dir / "evidence.jsonl"
    with file_lock(path.with_suffix(".lock")):
        seen = {r["id"] for r in _rows(path)}
        for row in rows:
            if row["id"] not in seen:
                _append(path, row)
                seen.add(row["id"])


def registry_row(item: dict[str, Any], *, kind: str, stage: str = "", commit: str = "") -> dict[str, Any]:
    request = item.get("request", {})
    content = item.get("content", item.get("output_tail", ""))
    redactor = Redactor()
    return {"id": item["evidence_id"], "kind": kind, "path": redactor.redact(request.get("path", item.get("path", ""))),
        "start_line": request.get("start_line"), "end_line": request.get("end_line"), "query": redactor.redact(request.get("query", "")),
        "check_id": item.get("id", "") if kind == "check" else "", "stage": stage, "commit": commit,
        "sha256": item.get("sha256") or hashlib.sha256(content.encode()).hexdigest(), "bytes": len(content.encode()),
        "truncated": item.get("truncated", False), "ok": item.get("ok", item.get("status", "passed") == "passed")}


def append_trace(run_dir: Path, row: dict[str, Any]) -> None:
    path = run_dir / "grounding.jsonl"
    with file_lock(path.with_suffix(".lock")):
        _append(path, {"seq": len(_rows(path)) + 1, **row})


def score_trace(rows: Iterable[dict[str, Any]], *, answer: float | None = None) -> dict[str, Any]:
    records = list(rows)
    outputs = [r for r in records if r.get("type") == "output"]
    last: dict[str, Any] = next((r for r in reversed(records) if r.get("type") == "criteria"), {})
    settings = next((r for r in records if "mode" in r), {})
    criteria = last.get("criteria", [])
    met = sum(c["state"] in {"demonstrated", "met_not_demonstrated", "attested"} for c in criteria)
    counts = Counter(v["kind"] for r in outputs for v in r.get("violations", []))
    v = sum(bool(r.get("violations")) for r in outputs) / len(outputs) if outputs else 0.0
    components = []
    cited = sum(len(r.get("cited", [])) for r in outputs)
    if cited:
        components.append(sum(sum(c in r["shown"] for c in r.get("cited", [])) for r in outputs) / cited)
    total = sum(r.get("targets", {}).get("total", 0) for r in outputs)
    if total:
        components.append(sum(r.get("targets", {}).get("seen", 0) for r in outputs) / total)
    absence = Counter({k: sum(r.get("absence", {}).get(k, 0) for r in outputs) for k in ("verified", "refuted", "unverifiable")})
    if sum(absence.values()):
        components.append(absence["verified"] / sum(absence.values()))
    if met:
        components.append(sum(c["state"] in {"demonstrated", "attested"} for c in criteria) / met)
    trajectory = sum(components) / len(components) if components else 1.0
    a = answer if answer is not None else met / len(criteria) if criteria else 0.0
    weights = settings.get("weights", {"answer": 0.5, "trajectory": 0.5})
    unadjusted = weights["answer"] * a + weights["trajectory"] * trajectory
    return {"mode": settings.get("mode", "enforce"), "answer": round(a, 4), "trajectory": round(trajectory, 4),
        "unadjusted": round(unadjusted, 4), "violation_rate": round(v, 4), "adjusted": round(unadjusted * (1 - v) ** 2, 4),
        "tier": "clean" if v == 0 else "minor" if v <= .1 else "major" if v <= .25 else "failing",
        "outputs": len(outputs), "violations": dict(sorted(counts.items())), "criteria": criteria,
        "probe": last.get("probe", {"status": "not_needed"})}


def recompute_summary(run_dir: Path) -> dict[str, Any]:
    return score_trace(_rows(run_dir / "grounding.jsonl"))


def cited_ids(value: Any) -> list[str]:
    if isinstance(value, dict):
        return [*value.get("citations", []), *[c for k, v in value.items() if k != "citations" for c in cited_ids(v)]]
    if isinstance(value, list):
        return [c for v in value for c in cited_ids(v)]
    return []


def shown_ids(text: str) -> list[str]:
    return sorted(set(re.findall(r'"evidence_id": "([EKH]-[0-9a-f]{10})"', text)))
