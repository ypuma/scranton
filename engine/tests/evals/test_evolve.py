"""The evolution loop is exhaustively exercised without engine or provider calls."""
import json

import pytest

from scranton_pipeline.evals.evolve import evolve, mean, prompt
from scranton_pipeline.procedure import GraphEdit, digest, load, skeleton
from scranton_pipeline.tools.secrets import Redactor


def edit(text="Read before editing"):
    return GraphEdit.model_validate({"delete_edges": [["plan.start", "LEADS_TO", "done"]],
        "add_edges": [{"from": "plan.start", "relation": "LEADS_TO", "to": "done", "condition": "", "guidance": text, "pitfalls": ""}], "rationale": "Improve guidance"})


def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_accept_tie_reject_score_and_rejection_memory(tmp_path):
    scores = iter([.5, .8, .8, .4, .9])
    calls, prompts = [], []
    def rollout(graph, split):
        calls.append(split)
        return [{"adjusted": next(scores) if split == "val" else 0, "outcome": "failed", "failure_code": "checks_failed", "grounding": {"answer": 0}}]
    def refine(text):
        prompts.append(json.loads(text))
        return edit(f"Revision {len(prompts)}")
    result = evolve(skeleton(), tmp_path, rollout=rollout, refine=refine, rounds=4)
    assert result["accepted"] == 3 and result["rejected"] == 1
    assert [r["accepted"] for r in rows(tmp_path / "evolution.jsonl")] == [True, True, False, True]
    rejected = rows(tmp_path / "rejected.jsonl")
    assert rejected[0]["reason"] == "score_regression" and rejected[0]["candidate_score"] == .4
    assert prompts[3]["rejected"][0]["reason"] == "score_regression"
    assert prompts[0]["failed"][0]["failure_code"] == "checks_failed"
    assert digest(load(tmp_path / "best.json")) == digest(load(tmp_path / "graph-r4.json"))
    assert not (tmp_path / "graph-r3.json").exists()
    assert calls == ["val", "train", "val", "train", "val", "train", "val", "train", "val"]


def test_invalid_candidate_never_gets_validation_rollout(tmp_path):
    calls = []
    def rollout(graph, split):
        calls.append(split)
        return [{"adjusted": 1}]
    result = evolve(skeleton(), tmp_path, rollout=rollout,
        refine=lambda _: GraphEdit(delete_nodes=["done"], rationale="Remove terminal"), rounds=2)
    assert calls == ["val", "train", "train"]
    assert result["rejected"] == 2 and result["accepted"] == 0
    assert digest(load(tmp_path / "best.json")) == digest(skeleton())
    rejected = rows(tmp_path / "rejected.jsonl")
    assert rejected[0]["diagnostics"] and rejected[0]["candidate"] is None


def test_invalid_refiner_does_not_abort_next_round(tmp_path):
    count = 0
    def refine(_):
        nonlocal count
        count += 1
        if count == 1:
            raise ValueError("Refiner output invalid beyond repair budget")
        return edit()
    result = evolve(skeleton(), tmp_path, rollout=lambda g, s: [{"adjusted": .8}], refine=refine, rounds=2)
    assert result["accepted"] == 1 and result["rejected"] == 1
    assert "repair budget" in rows(tmp_path / "rejected.jsonl")[0]["diagnostics"][0]


def test_deadline_stops_before_any_rollout_and_keeps_best(tmp_path):
    clock = iter([0, 2, 2])
    result = evolve(skeleton(), tmp_path, rollout=lambda *a: pytest.fail("deadline"), refine=lambda p: pytest.fail("deadline"),
                    clock=lambda: next(clock), max_seconds=1, rounds=20)
    assert result["rounds"] == 0 and result["mean_adjusted"] is None
    assert load(tmp_path / "best.json") == skeleton()


def test_deadline_after_refiner_does_not_rollout_candidate(tmp_path):
    now = [0.0]
    calls = []
    def rollout(g, split):
        calls.append(split)
        return [{"adjusted": .5}]
    def refine(p):
        now[0] = 20
        return edit()
    result = evolve(skeleton(), tmp_path, rollout=rollout, refine=refine, clock=lambda: now[0], max_seconds=10)
    assert calls == ["val", "train"]
    assert result["accepted"] == 0 and result["rounds"] == 1
    assert "max_seconds exhausted" in rows(tmp_path / "rejected.jsonl")[0]["diagnostics"]


@pytest.mark.parametrize("rounds,seconds", [(0, 1), (21, 1), (1, 0), (1, float("nan")), (1, float("inf"))])
def test_invalid_bounds_write_nothing(tmp_path, rounds, seconds):
    out = tmp_path / "new"
    with pytest.raises(Exception, match="1..20"):
        evolve(skeleton(), out, rollout=lambda *a: [], refine=lambda _: edit(), rounds=rounds, max_seconds=seconds)
    assert not out.exists()


def test_prompt_redaction_contrast_tail_and_vocabulary():
    secret = "private-evaluation-canary-2938429"
    Redactor([secret])
    traces = [{"id": str(i), "outcome": "succeeded" if i % 2 else "failed", "situations": ["plan.start", "implement.repair"],
               "failure_code": None, "grounding": {"answer": i % 2}, "extra": "x" * 200} for i in range(30)]
    traces[-1]["extra"] = secret
    value = prompt(skeleton(), traces, [{"diagnostics": [secret]}], max_bytes=4000)
    data = json.loads(value)
    assert len(value.encode()) <= 4000 and secret not in value and "[REDACTED]" in value
    assert "implement.repair" in data["vocabulary"] and data["graph"]["name"] == "skeleton"
    assert data["successful"] and data["failed"]
    assert data["successful"][-1]["id"] == "29" and len(data["successful"]) < 15


def test_empty_or_nonfinite_rollout_never_accepted():
    for results in ([], [{"adjusted": float("nan")}], [{"adjusted": 2}], [{}]):
        with pytest.raises(Exception, match="finite"):
            mean(results)


def test_existing_output_is_not_overwritten(tmp_path):
    path = tmp_path / "keep"
    path.write_text("unchanged")
    with pytest.raises(Exception, match="empty"):
        evolve(skeleton(), tmp_path, rollout=lambda *a: pytest.fail("occupied output admitted"), refine=lambda _: edit())
    assert path.read_text() == "unchanged"
    assert list(tmp_path.iterdir()) == [path]


def test_cli_refiner_repairs_are_bounded_and_accounted(tmp_path, monkeypatch, capsys):
    import scranton_pipeline.evals.evolve as module
    from scranton_pipeline.agents.gateway import ChatModelGateway
    from scranton_pipeline.cli import main
    from scranton_pipeline.errors import EngineError, FailureClass
    from scranton_pipeline.evals.pack import load_pack
    pack = load_pack("core")
    calls = []
    def complete(self, role, *, system, user, schema):
        calls.append((role, user))
        raise EngineError(FailureClass.LLM_OUTPUT, "output_invalid", "bad", detail="Malformed edit")
    monkeypatch.setattr(ChatModelGateway, "complete", complete)
    def evaluate(pack, out, **kwargs):
        return {"tasks": [{"adjusted": 1}], "meta": {"tasks": [{"trace": {"outcome": "succeeded", "grounding": {"answer": 1}}}]}}
    monkeypatch.setattr(module, "evaluate", evaluate)
    assert main(["evolve", "--pack", "core", "--graph", "skeleton", "--rounds", "2", "--out", str(tmp_path / "out")]) == 0
    output = capsys.readouterr().out.splitlines()
    assert len(output) == 1 and json.loads(output[0])["rejected"] == 2
    assert len(calls) == 6 and all(c[0] == "refiner" for c in calls)
    assert "Repair invalid output" in calls[1][1]
    assert "beyond repair budget" in calls[3][1]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["out"]
    assert load(tmp_path / "out" / "best.json") == skeleton()
    assert (pack.root / "pack.json").is_file()


def test_refiner_guard_includes_optional_role(tmp_path):
    from scranton_pipeline.evals.evaluate import base_config
    from scranton_pipeline.evals.pack import load_pack
    pack = load_pack("core")
    cfg = base_config(pack, None, "scripted", False).model_dump(mode="json", by_alias=True)
    cfg["models"]["refiner"] = {"provider": "openai_compatible", "model": "paid"}
    path = tmp_path / "config.json"
    path.write_text(json.dumps(cfg))
    with pytest.raises(Exception, match="--real-calls"):
        base_config(pack, path, "config", False, refiner=True)


@pytest.mark.parametrize("stage", ["initial", "train", "candidate"])
def test_rollout_deadline_keeps_last_accepted_graph(tmp_path, stage):
    calls = []
    def rollout(graph, split):
        calls.append(split)
        if stage == "initial" or stage == "train" and split == "train" or stage == "candidate" and len(calls) == 3:
            raise TimeoutError("budget")
        return [{"adjusted": 1}]
    result = evolve(skeleton(), tmp_path, rollout=rollout, refine=lambda _: edit(), rounds=1)
    assert result["accepted"] == 0
    assert load(tmp_path / "best.json") == skeleton()
    if stage == "candidate":
        assert "during validation" in rows(tmp_path / "rejected.jsonl")[0]["diagnostics"][0]
