"""Pure, advisory procedural graphs; no execution or routing authority."""
import hashlib
import json
import unicodedata
from collections import deque
from collections.abc import Sequence
from copy import deepcopy
from importlib.resources import files
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import Field, StrictStr, field_validator

from scranton_pipeline.errors import EngineError, FailureClass
from scranton_pipeline.models import LlmModel, StrictModel

VOCABULARY: frozenset[str] = frozenset({
    "plan.start", "plan.context", "plan.repair", "plan.replan",
    "implement.start", "implement.context", "implement.repair", "implement.edits_rejected",
    "implement.checks_failed", "implement.review_changes", "implement.integration",
    "review.start", "review.repair", "review.recheck",
})
TERMINALS: frozenset[str] = frozenset({"done", "blocked"})
Relation = Literal["LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO"]
_RELATIONS = ("LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO")
_INTRO = "Procedural guidance (advisory - the rules and the schema always win)"
EditText = Annotated[StrictStr, Field(max_length=400)]
Triple = tuple[StrictStr, Relation, StrictStr]


class Node(StrictModel):
    id: StrictStr
    type: Literal["SITUATION", "TERMINAL"]
    description: StrictStr


class Edge(StrictModel):
    source: StrictStr = Field(alias="from")
    relation: Relation
    target: StrictStr = Field(alias="to")
    condition: StrictStr
    guidance: StrictStr
    pitfalls: StrictStr


class Graph(StrictModel):
    schema_version: Literal[1] = Field(default=1, alias="schema")
    name: StrictStr
    nodes: list[Node]
    edges: list[Edge]

    @field_validator("schema_version", mode="before")
    @classmethod
    def schema_number(cls, value: Any) -> Any:
        if type(value) is not int:
            raise ValueError("schema must be integer 1")
        return value


class GraphEdit(LlmModel):
    add_nodes: list[Node] = Field(default_factory=list, max_length=64)
    delete_nodes: list[EditText] = Field(default_factory=list, max_length=64)
    add_edges: list[Edge] = Field(default_factory=list, max_length=160)
    delete_edges: list[tuple[EditText, Relation, EditText]] = Field(default_factory=list, max_length=160)
    rationale: EditText


def _key(edge: Edge) -> Triple:
    return edge.source, edge.relation, edge.target


def _json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def problems(graph: Graph) -> list[str]:
    """Report semantic rules separately so candidate diagnostics can include every violation."""
    result: list[str] = []
    if len(graph.nodes) > 64:
        result.append("Graph exceeds 64 nodes.")
    if len(graph.edges) > 160:
        result.append("Graph exceeds 160 edges.")
    ids: set[str] = set()
    for node in sorted(graph.nodes, key=lambda n: (n.id, n.type, n.description)):
        if node.id in ids:
            result.append(f"Duplicate node id: {node.id}.")
        ids.add(node.id)
        allowed = VOCABULARY if node.type == "SITUATION" else TERMINALS
        if node.id not in allowed:
            result.append(f"Unknown {node.type} id: {node.id}.")
    keys: set[Triple] = set()
    for edge in sorted(graph.edges, key=lambda e: (*_key(e), e.condition, e.guidance, e.pitfalls)):
        key = _key(edge)
        if key in keys:
            result.append(f"Duplicate edge: {key}.")
        keys.add(key)
        for endpoint in (edge.source, edge.target):
            if endpoint not in ids:
                result.append(f"Edge endpoint does not exist: {endpoint}.")
    reachable = {n.id for n in graph.nodes if n.type == "TERMINAL"}
    while True:
        expanded = reachable | {e.source for e in graph.edges if e.target in reachable and e.source in ids}
        if expanded == reachable:
            break
        reachable = expanded
    for node_id in sorted(ids - reachable):
        result.append(f"Node does not reach a terminal: {node_id}.")
    texts = [("name", graph.name)]
    for index, node in enumerate(sorted(graph.nodes, key=lambda n: (n.id, n.type, n.description))):
        texts.extend((f"nodes[{index}].{k}", v) for k, v in node.model_dump().items())
    for index, edge in enumerate(sorted(graph.edges, key=lambda e: (*_key(e), e.condition, e.guidance, e.pitfalls))):
        texts.extend((f"edges[{index}].{k}", v) for k, v in edge.model_dump(by_alias=True).items())
    for label, text in texts:
        if len(text) > 400:
            result.append(f"Text exceeds 400 characters: {label}.")
        if any(unicodedata.category(c) in {"Cc", "Cf", "Cs"} for c in text):
            result.append(f"Text contains control characters: {label}.")
        if "<<<" in text or ">>>" in text:
            result.append(f"Text contains prompt delimiters: {label}.")
    return result


def load(path: Path | None) -> Graph:
    try:
        text = (files(__package__).joinpath("default.json").read_text(encoding="utf-8")
                if path is None else path.read_text(encoding="utf-8"))
        graph = Graph.model_validate_json(text)
        issues = problems(graph)
        if issues:
            raise ValueError("; ".join(issues))
        return graph
    except (OSError, ValueError) as exc:
        raise EngineError(FailureClass.INVALID_INPUT, "invalid_procedure", "Invalid procedural graph", detail=str(exc)) from exc


def digest(graph: Graph) -> str:
    value = graph.model_dump(mode="json", by_alias=True)
    value["nodes"] = sorted(value["nodes"], key=_json)
    value["edges"] = sorted(value["edges"], key=_json)
    return hashlib.sha256(_json(value)).hexdigest()


def render(graph: Graph, situation: str, *, hops: int = 2, max_bytes: int = 1500) -> str:
    nodes = {node.id: node for node in graph.nodes}
    if situation not in nodes:
        return ""
    text = f"{_INTRO}\n{situation}: {nodes[situation].description}"
    if len(text.encode("utf-8")) > max_bytes:
        return ""
    queue = deque([(situation, 0)])
    visited = {situation}
    emitted: set[Triple] = set()
    while queue:
        source, depth = queue.popleft()
        if depth >= hops:
            continue
        outgoing = sorted((e for e in graph.edges if e.source == source),
                          key=lambda e: (_RELATIONS.index(e.relation), e.target))
        for edge in outgoing:
            key = _key(edge)
            if key in emitted:
                continue
            emitted.add(key)
            line = (f"\n{edge.source} --{edge.relation}--> {edge.target}"
                    f" | condition: {edge.condition} | guidance: {edge.guidance} | pitfalls: {edge.pitfalls}")
            if len((text + line).encode("utf-8")) > max_bytes:
                return text
            text += line
            if edge.target not in visited:
                visited.add(edge.target)
                queue.append((edge.target, depth + 1))
    return text


def skeleton() -> Graph:
    return Graph(name="skeleton", nodes=[
        Node(id="plan.start", type="SITUATION", description="Plan the remaining work."),
        Node(id="done", type="TERMINAL", description="Guidance complete."),
    ], edges=[Edge.model_validate({"from": "plan.start", "relation": "LEADS_TO", "to": "done",
                                  "condition": "", "guidance": "", "pitfalls": ""})])


def prepare_candidate(graph: Graph, edit: GraphEdit) -> tuple[Graph | None, list[str]]:
    candidate = graph.model_copy(deep=True)
    issues: list[str] = []
    for key in edit.delete_edges:
        found = next((e for e in candidate.edges if _key(e) == key), None)
        if found is None:
            issues.append(f"Cannot delete missing edge: {key}.")
        else:
            candidate.edges.remove(found)
    for node_id in edit.delete_nodes:
        node = next((n for n in candidate.nodes if n.id == node_id), None)
        if node is None:
            issues.append(f"Cannot delete missing node: {node_id}.")
        else:
            candidate.nodes.remove(node)
    for node in edit.add_nodes:
        if any(n.id == node.id for n in candidate.nodes):
            issues.append(f"Cannot add duplicate node: {node.id}.")
        else:
            candidate.nodes.append(node.model_copy(deep=True))
    for edge in edit.add_edges:
        if any(_key(e) == _key(edge) for e in candidate.edges):
            issues.append(f"Cannot add duplicate edge: {_key(edge)}.")
        else:
            candidate.edges.append(edge.model_copy(deep=True))
    issues.extend(problems(candidate))
    if not issues and digest(candidate) == digest(graph):
        issues.append("no change")
    return (None, issues) if issues else (candidate, [])


def accept(current: float, candidate: float) -> bool:
    return candidate >= current


def rejection_row(row: dict[str, Any], max_bytes: int = 2048) -> dict[str, Any]:
    if len(json.dumps(row).encode()) <= max_bytes:
        return deepcopy(row)
    compact: dict[str, Any] = {k: row[k] for k in ("round", "reason", "current_score", "candidate_score") if k in row}
    compact.update(truncated=True, edit=deepcopy(row.get("edit")), diagnostics=row.get("diagnostics", []))
    if len(json.dumps(compact).encode()) <= max_bytes:
        return compact
    compact["diagnostics"] = []
    if len(json.dumps(compact).encode()) <= max_bytes:
        return compact
    text = _json(row.get("edit")).decode("utf-8")
    compact["edit"] = ""
    for char in text:
        compact["edit"] += char
        if len(json.dumps(compact).encode()) > max_bytes:
            compact["edit"] = compact["edit"][:-1]
            break
    return compact


def rejection_tail(rows: Sequence[dict[str, Any]], max_bytes: int) -> list[dict[str, Any]]:
    """Keep a chronological suffix, counting the complete compact JSON list in UTF-8."""
    kept: list[dict[str, Any]] = []
    for row in reversed(rows):
        trial = [rejection_row(row), *kept]
        if len(_json(trial)) > max_bytes:
            break
        kept = trial
    return deepcopy(kept)
