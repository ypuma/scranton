import hashlib
import json
from importlib.resources import files

import pytest
from pydantic import ValidationError

from scranton_pipeline.errors import EngineError, FailureClass
from scranton_pipeline.models import LlmModel
from scranton_pipeline.procedure import (
    TERMINALS,
    VOCABULARY,
    Edge,
    Graph,
    GraphEdit,
    Node,
    accept,
    digest,
    load,
    prepare_candidate,
    problems,
    rejection_tail,
    render,
    skeleton,
)


def node(id="plan.context", **kwargs):
    return Node(id=id, type="SITUATION", description="Read current files.", **kwargs)


def edge(source="plan.start", target="done", relation="LEADS_TO", **kwargs):
    return Edge(source=source, target=target, relation=relation,
                condition=kwargs.get("condition", "Ready."),
                guidance=kwargs.get("guidance", "Use shown evidence."),
                pitfalls=kwargs.get("pitfalls", "No stale reads."))


def graph_with_edges():
    return Graph(name="branch", nodes=[*skeleton().nodes, node(), node("plan.repair")], edges=[
        edge(target="plan.repair", relation="CONVERGES_TO"),
        edge(target="plan.context", relation="TRIGGERS"),
        edge(),
        edge(source="plan.context", target="plan.start"),
        edge(source="plan.context", target="plan.repair"),
        edge(source="plan.repair"),
    ])


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def test_closed_vocabulary_and_skeleton():
    assert VOCABULARY == frozenset({
        "plan.start", "plan.context", "plan.repair", "plan.replan",
        "implement.start", "implement.context", "implement.repair", "implement.edits_rejected",
        "implement.checks_failed", "implement.review_changes", "implement.integration",
        "review.start", "review.repair", "review.recheck",
    })
    assert TERMINALS == frozenset({"done", "blocked"})
    graph = skeleton()
    assert problems(graph) == []
    assert [(n.id, n.type) for n in graph.nodes] == [("plan.start", "SITUATION"), ("done", "TERMINAL")]
    assert [(e.source, e.relation, e.target) for e in graph.edges] == [("plan.start", "LEADS_TO", "done")]
    graph.nodes.clear()
    assert len(skeleton().nodes) == 2


@pytest.mark.parametrize("model,data", [
    (Node, {"id": "plan.start", "type": "ACTION", "description": "x"}),
    (Node, {"id": 3, "type": "SITUATION", "description": "x"}),
    (Node, {"id": "plan.start", "type": "SITUATION", "description": "x", "extra": 1}),
    (Edge, {"from": "plan.start", "to": "done", "relation": "UNKNOWN", "condition": "", "guidance": "", "pitfalls": ""}),
    (Edge, {"from": "plan.start", "to": "done", "relation": "LEADS_TO", "condition": None, "guidance": "", "pitfalls": ""}),
    (Edge, {**edge().model_dump(by_alias=True), "extra": 1}),
    (Graph, {**skeleton().model_dump(by_alias=True), "schema": 2}),
    (Graph, {**skeleton().model_dump(by_alias=True), "schema": True}),
    (Graph, {**skeleton().model_dump(by_alias=True), "extra": 1}),
])
def test_strict_shapes(model, data):
    with pytest.raises(ValidationError):
        model.model_validate(data)


def test_aliases_and_frozen_models():
    graph = skeleton()
    raw = graph.model_dump(mode="json", by_alias=True)
    assert raw["schema"] == 1
    assert raw["edges"][0]["from"] == "plan.start" and raw["edges"][0]["to"] == "done"
    assert Graph.model_validate_json(json.dumps(raw)) == graph
    for obj, field, value in [(graph, "name", "changed"), (graph.nodes[0], "id", "changed"),
                              (graph.edges[0], "guidance", "changed")]:
        with pytest.raises(ValidationError):
            setattr(obj, field, value)


@pytest.mark.parametrize("change,expected", [
    (lambda g: g.nodes.append(g.nodes[0]), "Duplicate node id"),
    (lambda g: g.nodes.append(node("unknown")), "Unknown SITUATION id"),
    (lambda g: g.nodes.append(Node(id="other", type="TERMINAL", description="x")), "Unknown TERMINAL id"),
    (lambda g: g.edges.append(edge(source="missing")), "Edge endpoint does not exist: missing"),
    (lambda g: g.edges.append(edge(target="missing")), "Edge endpoint does not exist: missing"),
    (lambda g: g.edges.append(g.edges[0]), "Duplicate edge"),
    (lambda g: g.nodes.append(node()), "Node does not reach a terminal: plan.context"),
    (lambda g: g.nodes.extend([g.nodes[1]] * 63), "Graph exceeds 64 nodes"),
    (lambda g: g.edges.extend([g.edges[0]] * 160), "Graph exceeds 160 edges"),
])
def test_each_graph_rule(change, expected):
    graph = skeleton()
    change(graph)
    assert any(expected in issue for issue in problems(graph))


@pytest.mark.parametrize("text,expected", [
    ("x" * 401, "exceeds 400"), ("bad\nline", "control characters"),
    ("bad\tline", "control characters"), ("bad\x00line", "control characters"),
    ("bad\x7fline", "control characters"), ("bad\x85line", "control characters"),
    ("bad\u202eline", "control characters"), ("<<<FILE", "prompt delimiters"),
    (">>>", "prompt delimiters"),
])
@pytest.mark.parametrize("field", ["name", "id", "description", "condition", "guidance", "pitfalls", "source", "target"])
def test_every_text_field_is_checked(text, expected, field):
    graph = skeleton()
    if field == "name":
        graph = graph.model_copy(update={"name": text})
    elif field in {"id", "description"}:
        graph.nodes[0] = graph.nodes[0].model_copy(update={field: text})
    else:
        graph.edges[0] = graph.edges[0].model_copy(update={field: text})
    assert any(expected in issue for issue in problems(graph))


def test_text_boundary_and_problem_order():
    graph = skeleton().model_copy(update={"name": "é" * 400})
    assert problems(graph) == []
    graph.nodes.extend([node("z"), node("a")])
    graph.edges.extend([edge(source="z", target="absent"), edge(source="a", target="absent")])
    issues = problems(graph)
    assert len(issues) >= 6
    reordered = graph.model_copy(update={"nodes": graph.nodes[::-1], "edges": graph.edges[::-1]})
    assert problems(reordered) == issues


def test_reachability_cycles_and_terminal_self_reach():
    graph = graph_with_edges()
    assert problems(graph) == []
    graph.edges[:] = [edge(target="plan.context"), edge(source="plan.context", target="plan.start")]
    assert problems(graph) == [
        "Node does not reach a terminal: plan.context.",
        "Node does not reach a terminal: plan.repair.",
        "Node does not reach a terminal: plan.start.",
    ]
    assert problems(Graph(name="terminal", nodes=[skeleton().nodes[1]], edges=[])) == []


def test_digest_canonical_content_and_reordering():
    graph = graph_with_edges()
    reordered = graph.model_copy(update={"nodes": graph.nodes[::-1], "edges": graph.edges[::-1]})
    assert digest(graph) == digest(reordered)
    raw = graph.model_dump(mode="json", by_alias=True)
    raw["nodes"] = sorted(raw["nodes"], key=encoded)
    raw["edges"] = sorted(raw["edges"], key=encoded)
    assert digest(graph) == hashlib.sha256(encoded(raw)).hexdigest()
    assert len(digest(graph)) == 64
    for changed in [graph.model_copy(update={"name": "other"}),
                    graph.model_copy(update={"edges": graph.edges[:-1]}),
                    graph.model_copy(update={"nodes": [*graph.nodes[:-1], node("review.start")]})]:
        assert digest(changed) != digest(graph)


def test_render_breadth_first_order_hops_cycles_and_uniqueness():
    graph = graph_with_edges()
    assert render(graph, "unknown") == ""
    zero = render(graph, "plan.start", hops=0)
    assert zero == ("Procedural guidance (advisory - the rules and the schema always win)\n"
                    "plan.start: Plan the remaining work.")
    assert render(graph, "plan.start", hops=-1) == zero
    one = render(graph, "plan.start", hops=1, max_bytes=10000)
    lines = one.splitlines()[2:]
    assert len(lines) == 3
    assert [line.split(" | ")[0] for line in lines] == [
        "plan.start --LEADS_TO--> done", "plan.start --TRIGGERS--> plan.context",
        "plan.start --CONVERGES_TO--> plan.repair",
    ]
    two = render(graph, "plan.start", hops=2, max_bytes=10000)
    assert two.startswith(one)
    assert len(two.splitlines()[2:]) == 6
    assert two.count("plan.start --LEADS_TO--> done") == 1
    assert render(graph, "plan.start", hops=999, max_bytes=10000) == two
    reordered = graph.model_copy(update={"nodes": graph.nodes[::-1], "edges": graph.edges[::-1]})
    assert render(reordered, "plan.start", max_bytes=10000) == two
    assert "condition: Ready. | guidance: Use shown evidence. | pitfalls: No stale reads." in two


def test_render_target_order_each_relation_and_diamond():
    graph = graph_with_edges()
    graph.edges.extend([edge(target="plan.repair", relation="TRIGGERS"),
                        edge(target="plan.context", relation="PROVIDES_INPUT_FOR")])
    text = render(graph, "plan.start", max_bytes=10000)
    first = text.splitlines()[2:7]
    assert [line.split(" | ")[0] for line in first] == [
        "plan.start --LEADS_TO--> done", "plan.start --TRIGGERS--> plan.context",
        "plan.start --TRIGGERS--> plan.repair", "plan.start --PROVIDES_INPUT_FOR--> plan.context",
        "plan.start --CONVERGES_TO--> plan.repair",
    ]
    assert text.count("plan.repair --LEADS_TO--> done") == 1


def test_render_byte_cap_retains_whole_edges():
    graph = graph_with_edges()
    graph.edges[2] = edge(guidance="é" * 30)
    full = render(graph, "plan.start", max_bytes=10000)
    pieces = full.splitlines()
    head = "\n".join(pieces[:2])
    first = "\n".join(pieces[:3])
    assert render(graph, "plan.start", max_bytes=len(head.encode()) - 1) == ""
    assert render(graph, "plan.start", max_bytes=0) == ""
    assert render(graph, "plan.start", max_bytes=-1) == ""
    assert render(graph, "plan.start", max_bytes=len(first.encode()) - 1) == head
    assert render(graph, "plan.start", max_bytes=len(first.encode())) == first
    for cap in range(len(full.encode()) + 2):
        text = render(graph, "plan.start", max_bytes=cap)
        assert len(text.encode()) <= cap
        assert not text or text in ["\n".join(pieces[:n]) for n in range(2, len(pieces) + 1)]


@pytest.mark.parametrize("contents", ["not json", "{}", "[]", '{"schema":2}', "\ud800"])
def test_load_invalid_json_and_encoding(tmp_path, contents):
    path = tmp_path / "graph.json"
    path.write_bytes(contents.encode("utf-8", errors="surrogatepass"))
    with pytest.raises(EngineError) as caught:
        load(path)
    assert caught.value.failure_class == FailureClass.INVALID_INPUT
    assert caught.value.code == "invalid_procedure"


def test_load_unreadable_semantic_invalid_and_valid(tmp_path):
    with pytest.raises(EngineError) as caught:
        load(tmp_path / "missing")
    assert caught.value.failure_class == FailureClass.INVALID_INPUT
    with pytest.raises(EngineError):
        load(tmp_path)
    path = tmp_path / "graph.json"
    graph = skeleton()
    graph.nodes.append(node())
    path.write_text(graph.model_dump_json(by_alias=True), encoding="utf-8")
    with pytest.raises(EngineError) as caught:
        load(path)
    assert "does not reach a terminal" in caught.value.detail
    path.write_text(skeleton().model_dump_json(by_alias=True), encoding="utf-8")
    assert load(path) == skeleton()


def test_default_resource_prior_valid_and_every_situation_renders():
    raw = files("scranton_pipeline.procedure").joinpath("default.json").read_text(encoding="utf-8")
    graph = load(None)
    assert graph == Graph.model_validate_json(raw)
    assert problems(graph) == []
    assert len(graph.nodes) <= 20
    assert {n.id for n in graph.nodes if n.type == "SITUATION"} == VOCABULARY
    for situation in VOCABULARY:
        text = render(graph, situation)
        assert 0 < len(text.encode()) <= 1500
        assert "--LEADS_TO--> done" in text


def test_edit_schema_is_llm_output_with_bounded_operations():
    edit = GraphEdit.model_validate({"rationale": "Reason", "ignored": True})
    assert isinstance(edit, LlmModel)
    assert edit.add_nodes == edit.delete_nodes == edit.add_edges == edit.delete_edges == []
    for field, value in [("add_nodes", [node()] * 65), ("delete_nodes", ["done"] * 65),
                         ("add_edges", [edge()] * 161),
                         ("delete_edges", [("plan.start", "LEADS_TO", "done")] * 161),
                         ("delete_nodes", ["x" * 401]), ("rationale", "x" * 401),
                         ("delete_edges", [("a", "UNKNOWN", "b")]),
                         ("delete_edges", [("a", "LEADS_TO")])]:
        with pytest.raises(ValidationError):
            GraphEdit.model_validate({"rationale": "Reason", field: value})


def test_edit_add_and_delete_nodes_and_edges_without_mutation():
    graph = skeleton()
    before = graph.model_dump(mode="json", by_alias=True)
    edit = GraphEdit(rationale="Insert context", add_nodes=[node()],
                     delete_edges=[("plan.start", "LEADS_TO", "done")],
                     add_edges=[edge(target="plan.context"), edge(source="plan.context")])
    candidate, issues = prepare_candidate(graph, edit)
    assert issues == [] and candidate is not None
    assert {n.id for n in candidate.nodes} == {"plan.start", "plan.context", "done"}
    assert [(e.source, e.target) for e in candidate.edges] == [("plan.start", "plan.context"), ("plan.context", "done")]
    assert graph.model_dump(mode="json", by_alias=True) == before
    reverse = GraphEdit(rationale="Remove context", delete_nodes=["plan.context"],
                        delete_edges=[("plan.start", "LEADS_TO", "plan.context"),
                                      ("plan.context", "LEADS_TO", "done")], add_edges=[graph.edges[0]])
    restored, issues = prepare_candidate(candidate, reverse)
    assert issues == [] and restored == graph
    candidate.nodes.clear()
    assert len(edit.add_nodes) == 1 and len(graph.nodes) == 2


def test_edit_replacement_deletions_before_additions():
    graph = skeleton()
    original = graph.model_dump()
    changed_node = graph.nodes[0].model_copy(update={"description": "New description"})
    changed_edge = graph.edges[0].model_copy(update={"guidance": "New guidance"})
    edit = GraphEdit(rationale="Replace attributes", delete_nodes=["plan.start"],
                     delete_edges=[("plan.start", "LEADS_TO", "done")],
                     add_nodes=[changed_node], add_edges=[changed_edge])
    candidate, issues = prepare_candidate(graph, edit)
    assert issues == [] and candidate is not None
    assert next(n for n in candidate.nodes if n.id == "plan.start").description == "New description"
    assert candidate.edges[0].guidance == "New guidance"
    assert graph.model_dump() == original


@pytest.mark.parametrize("kwargs,expected", [
    ({"delete_nodes": ["absent"]}, "missing node"),
    ({"delete_edges": [("plan.start", "TRIGGERS", "done")]}, "missing edge"),
    ({"delete_nodes": ["done", "done"]}, "missing node"),
    ({"delete_edges": [("plan.start", "LEADS_TO", "done")] * 2}, "missing edge"),
    ({"add_nodes": [skeleton().nodes[0]]}, "duplicate node"),
    ({"add_edges": [skeleton().edges[0]]}, "duplicate edge"),
    ({"add_nodes": [node(), node()]}, "duplicate node"),
    ({"add_edges": [edge(relation="TRIGGERS"), edge(relation="TRIGGERS")]}, "duplicate edge"),
    ({"delete_nodes": ["done"]}, "endpoint does not exist"),
    ({"add_nodes": [node()]}, "does not reach a terminal"),
    ({"add_nodes": [node("unknown")]}, "Unknown SITUATION"),
    ({"add_edges": [edge(guidance="bad <<<", relation="TRIGGERS")]}, "prompt delimiters"),
    ({}, "no change"),
    ({"delete_nodes": ["plan.start"], "add_nodes": [skeleton().nodes[0]]}, "no change"),
    ({"delete_edges": [("plan.start", "LEADS_TO", "done")], "add_edges": [skeleton().edges[0]]}, "no change"),
])
def test_edit_refusals_are_atomic(kwargs, expected):
    graph = skeleton()
    before = graph.model_dump()
    edit = GraphEdit(rationale="Trial", **kwargs)
    edit_before = edit.model_dump()
    candidate, issues = prepare_candidate(graph, edit)
    assert candidate is None and any(expected in issue for issue in issues)
    assert graph.model_dump() == before
    assert edit.model_dump() == edit_before


@pytest.mark.parametrize("current,candidate,expected", [(1, 2, True), (1, 1, True), (1, 0, False),
                                                         (-2, -1, True), (1, float("nan"), False)])
def test_accept_preserve_or_improve(current, candidate, expected):
    assert accept(current, candidate) is expected


def test_rejection_tail_newest_suffix_exact_utf8_json_cap_and_detachment():
    rows = [{"round": 1, "details": ["old"]}, {"round": 2, "reason": "é"}, {"round": 3, "reason": "bad"}]
    assert rejection_tail(rows, len(encoded(rows))) == rows
    assert rejection_tail(rows, len(encoded(rows[1:]))) == rows[1:]
    assert rejection_tail(rows, len(encoded(rows[1:])) - 1) == rows[2:]
    assert rejection_tail(rows, len(encoded(rows[2:])) - 1) == []
    assert rejection_tail(rows, 0) == [] and rejection_tail(rows, -1) == []
    assert rejection_tail([], 0) == []
    kept = rejection_tail(tuple(rows), 10000)
    kept[0]["details"].append("new")
    assert rows[0]["details"] == ["old"]
    assert rejection_tail([{"small": 1}, {"huge": "x" * 1000}], 100) == []


def test_render_never_requeues_a_visited_node(monkeypatch):
    from collections import deque

    from scranton_pipeline import procedure

    queued = []

    class TrackedQueue(deque):
        def append(self, item):
            queued.append(item[0])
            super().append(item)

    monkeypatch.setattr(procedure, "deque", TrackedQueue)
    render(graph_with_edges(), "plan.start", hops=999, max_bytes=10000)
    assert queued == ["done", "plan.context", "plan.repair"]
