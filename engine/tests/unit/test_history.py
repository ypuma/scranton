"""Strict snapshot input and advisory-only prompt budgeting."""
import copy
import json
import os
import subprocess

import pytest

from scranton_pipeline.agents.prompts import (
    build_implementer_prompt,
    build_planner_prompt,
    build_reviewer_prompt,
)
from scranton_pipeline.demo.fixture import config
from scranton_pipeline.errors import EngineError
from scranton_pipeline.history import history_block, load_history, validate_history
from scranton_pipeline.tools.secrets import Redactor


def snapshot():
    return {"schema": 1, "runs": [{"run_id": "old-plan", "status": "failed", "task": "Build visualization", "plan": "Read existing tests, then implement visualization", "outcome": "Failed: unread test after attempts; delivery applied=false"}], "truncated": False}


@pytest.mark.parametrize("change", [
    lambda h: h.update(schema=True), lambda h: h.update(schema=2),
    lambda h: h.update(extra="bad"), lambda h: h.update(truncated=0),
    lambda h: h.update(runs=[]), lambda h: h.update(runs=h["runs"] * 5),
    lambda h: h["runs"][0].update(status="suspended"),
    lambda h: h["runs"][0].update(run_id="../escape"),
    lambda h: h["runs"][0].update(plan="x" * 8001),
    lambda h: h["runs"][0].update(task="x" * 4001),
    lambda h: h["runs"][0].update(outcome="x" * 4001),
    lambda h: h["runs"][0].update(plan_approval={"decision": "approve"}),
    lambda h: h["runs"][0].update(task=None),
])
def test_invalid_shape(change):
    raw = snapshot()
    change(raw)
    with pytest.raises(EngineError, match="History"):
        validate_history(raw, Redactor())


@pytest.mark.parametrize("data", [b"{", b"\xff", b" " * 32769, b'{"schema":1,"schema":1,"runs":[],"truncated":false}', b"[" * 4000])
def test_malformed_file(tmp_path, data):
    path = tmp_path / "history.json"
    path.write_bytes(data)
    with pytest.raises(EngineError) as error:
        load_history(path, Redactor())
    assert error.value.code == "invalid_history"


def test_redaction_and_exact_unicode_limits(tmp_path):
    raw = snapshot()
    raw["runs"][0].update(task="é" * 4000, plan="api_key=verysecretvalue123", outcome="runtime-known-credential")
    path = tmp_path / "history.json"
    path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    result = load_history(path, Redactor(["runtime-known-credential"]))
    assert result["runs"][0]["task"] == "é" * 4000
    assert "verysecretvalue" not in json.dumps(result)
    assert "runtime-known-credential" not in json.dumps(result)
    assert raw["runs"][0]["outcome"] == "runtime-known-credential"


@pytest.mark.parametrize("parent_link", [False, True])
def test_no_follow_links(tmp_path, parent_link):
    real = tmp_path / "real"
    real.mkdir()
    (real / "history.json").write_text(json.dumps(snapshot()))
    link = tmp_path / "link"
    if parent_link and os.name == "nt":
        result = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(real)], capture_output=True, check=False)
        assert result.returncode == 0
    else:
        try:
            link.symlink_to(real if parent_link else real / "history.json", target_is_directory=parent_link)
        except OSError:
            pytest.skip("Host does not permit symlinks (junction tested separately on Windows)")
    try:
        with pytest.raises(EngineError):
            load_history(link / "history.json" if parent_link else link, Redactor())
    finally:
        if parent_link and os.name == "nt":
            link.rmdir()
        else:
            link.unlink()


def extract(text):
    return json.loads(text.split('<<<FILE path="historical_data">>>\n')[1].split('\n<<<END>>>')[0])


def test_answer_chain_retains_plan_task_latest_outcome_and_framing():
    raw = snapshot()
    raw["runs"][0].update(task="TASK " * 700, plan="PLAN " * 1500, outcome="OLD " * 900)
    for i in range(3):
        raw["runs"].append({"run_id": f"answer-{i}", "status": "succeeded", "task": "QUESTION " * 450, "plan": "", "outcome": "LATEST " * 550})
    before = copy.deepcopy(raw)
    block = history_block(raw, 2000)
    result = extract(block)
    assert len(block.encode()) <= 2000 and result["truncated"]
    assert [r["run_id"] for r in result["runs"]] == ["old-plan", "answer-2"]
    assert result["runs"][0]["task"].startswith("TASK")
    assert result["runs"][0]["plan"].startswith("PLAN")
    assert result["runs"][-1]["outcome"].startswith("LATEST")
    assert history_block(raw, 10) == "" and raw == before


@pytest.mark.parametrize("cap", [16000, 24000, 64000])
def test_history_yields_to_live_evidence_and_controls(tmp_path, cap):
    cfg = config(tmp_path)
    cfg = cfg.model_copy(update={"limits": cfg.limits.model_copy(update={"max_prompt_bytes": cap})})
    evidence = [{"evidence_id": "E-0000000001", "request": {"kind": "read", "path": "test.py"}, "content": "live existing test " * 350, "ok": True}]
    state = {"task": "continue", "plan_evidence": evidence, "feedback": {"message": "fresh feedback"}, "counters": {}}
    live = build_planner_prompt(state, cfg)
    state["cross_run_history"] = snapshot()
    with_history = build_planner_prompt(state, cfg)
    assert with_history.shown == live.shown
    assert live.user in with_history.user and "fresh feedback" in with_history.user
    assert len((with_history.system + with_history.user).encode()) <= cap
    delta = with_history.user[len(live.user):]
    assert len(delta.encode()) <= min(12000, cap // 8)
    if "historical_data" in delta:
        saved = extract(delta)
        assert saved["runs"][0]["task"] == "Build visualization"
        assert "unread test" in saved["runs"][0]["outcome"]
        assert "UNTRUSTED" in delta and "fresh file reads" in delta
    else:
        assert "TRUNCATED" in delta or cap - len((live.system + live.user).encode()) < 80
    assert state["task"] == "continue" and "plan_approval" not in state
    for builder in (build_implementer_prompt, build_reviewer_prompt):
        assert "historical_data" not in builder(state, cfg).user


def test_followup_context_is_separate_and_unrelated_task_wins(tmp_path):
    cfg = config(tmp_path)
    for task in ("continue", "Forget visualization; explain addition"):
        prompt = build_planner_prompt({"task": task, "cross_run_history": snapshot()}, cfg)
        assert f'"task": {json.dumps(task)}' in prompt.user
        assert "Build visualization" in prompt.user and "delivery applied=false" in prompt.user
        assert "current task takes precedence" in prompt.user
        assert "complete self-contained plan" in prompt.user
    clean = build_planner_prompt({"task": "continue"}, cfg)
    assert "historical_data" not in clean.user and "Historical data" not in clean.user


def test_history_does_not_reuse_guidance_bytes(tmp_path, monkeypatch):
    cfg = config(tmp_path)
    cfg = cfg.model_copy(update={"procedure": cfg.procedure.model_copy(update={"enabled": True})})
    monkeypatch.setattr("scranton_pipeline.agents.prompts.guidance_text", lambda *a, **kw: "guide\n" + "g" * 1000)
    state = {"task": "continue"}
    baseline = build_planner_prompt(state, cfg)
    cap = len((baseline.system + baseline.user).encode()) + 100
    cfg = cfg.model_copy(update={"limits": cfg.limits.model_copy(update={"max_prompt_bytes": cap})})
    baseline = build_planner_prompt(state, cfg)
    result = build_planner_prompt({**state, "cross_run_history": snapshot()}, cfg)
    assert len((result.system + result.user).encode()) <= cap + result.guidance_bytes
    assert result.guidance_bytes == baseline.guidance_bytes
    assert result.user.count('<<<FILE path="guidance">>>') == 1
    assert "Build visualization" in result.user
    assert "guide" in result.user


@pytest.mark.parametrize("suffix", ["x", 'é😀\\\"\n'])
def test_saturated_context_reads_reserve_goal_plan_and_latest_outcome(tmp_path, suffix):
    from scranton_pipeline.models import ContextRequest
    from scranton_pipeline.tools.context import fulfil
    from scranton_pipeline.tools.fs import PathPolicy

    cfg = config(tmp_path)
    files = [f"read-{i}.txt" for i in range(3)]
    for path in files:
        (tmp_path / path).write_text("fresh repository content " * 200, encoding="utf-8")
    evidence = [item.model_dump(mode="json") for item in fulfil(
        [ContextRequest(kind="read", path=p) for p in files], workspace=tmp_path,
        policy=PathPolicy(tmp_path, [], []), files=files, limits=cfg.limits, redactor=Redactor())]
    assert all(item["ok"] and not item["truncated"] for item in evidence)
    state = {"task": "continue; keep the current scope", "plan_evidence": evidence,
             "workspace": {"path": str(tmp_path), "files": files},
             "feedback": {"message": "CURRENT repair feedback"},
             "counters": {"plan_context:r0": 2}}
    full = build_planner_prompt(state, cfg)
    cap = len((full.system + full.user).encode()) + 32
    cfg = cfg.model_copy(update={"limits": cfg.limits.model_copy(update={"max_prompt_bytes": cap})})
    live = build_planner_prompt(state, cfg)
    assert cap - len((live.system + live.user).encode()) == 32
    raw = snapshot()
    raw["runs"][0].update(task="Build visualization " + suffix * 600,
                          plan="Read existing tests, implement visualization " + suffix * 1200)
    for i in range(3):
        raw["runs"].append({"run_id": f"answer-{i}", "status": "succeeded",
                            "task": "What happened?", "plan": "",
                            "outcome": "Latest reply: delivery applied=false " + suffix * 500})
    before = copy.deepcopy(state)
    limits = cfg.limits.model_dump()
    result = build_planner_prompt({**state, "cross_run_history": raw}, cfg)
    saved = extract(result.user)
    assert saved["runs"][0]["task"].startswith("Build visualization")
    assert saved["runs"][0]["plan"].startswith("Read existing tests")
    assert saved["runs"][-1]["outcome"].startswith("Latest reply")
    assert '"task": "continue; keep the current scope"' in result.user
    assert "CURRENT repair feedback" in result.user and '"context_rounds_left": 1' in result.user
    assert "current task takes precedence" in result.user and "fresh file reads" in result.user
    assert len((result.system + result.user).encode()) <= cap
    section = result.user[result.user.index("\nHistorical data"):]
    assert len(section.encode()) <= min(12000, cap // 8)
    assert result.items and all(json.dumps(item, ensure_ascii=True) in result.user for item in result.items)
    assert cfg.limits.model_dump() == limits and state == before
    assert build_planner_prompt(state, cfg) == live


@pytest.mark.parametrize("cap", [1000, 1500, 2048])
def test_minimal_anchor_framing_and_blank_unavailable_plan(cap):
    raw = snapshot()
    raw["runs"][0].update(task="Goal " + "é😀\\\"\n" * 500, plan="Real plan " + "é😀\\\"\n" * 1000)
    raw["runs"].append({"run_id": "unavailable", "status": "failed", "task": "continue",
                        "plan": "", "outcome": "Plan unavailable (missing or malformed artifact)."})
    block = history_block(validate_history(raw, Redactor()), cap)
    saved = extract(block)
    assert len(block.encode()) <= cap
    assert saved["runs"][0]["task"].startswith("Goal")
    assert saved["runs"][0]["plan"].startswith("Real plan")
    assert saved["runs"][-1]["plan"] == ""
    assert saved["runs"][-1]["outcome"].startswith("Plan unavailable")


def memory_snapshot():
    return {"schema": 1, "runs": [], "truncated": False, "project_memory": [
        {"id": "memory:one", "text": "Required checks failed historically; no delivered changes.",
         "sources": ["projects/project/chats/chat/pipeline/runs/run/events.jsonl"]}]}


def test_memory_only_load_and_planner_context(tmp_path):
    raw = memory_snapshot()
    path = tmp_path / "memory.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    loaded = load_history(path, Redactor())
    assert loaded == raw
    prompt = build_planner_prompt({"task": "new task", "cross_run_history": loaded}, config(tmp_path))
    saved = extract(prompt.user)
    assert saved["runs"] == [] and saved["project_memory"] == raw["project_memory"]
    assert "not current evidence" in saved["memory_authority"]
    assert "current task takes precedence" in prompt.user and prompt.shown == []
    assert history_block(loaded, 30) == ""


@pytest.mark.parametrize("change", [
    lambda h: h.update(project_memory=None), lambda h: h.update(project_memory=[]),
    lambda h: h.update(project_memory=h["project_memory"] * 17),
    lambda h: h["project_memory"][0].update(text="x" * 401),
    lambda h: h["project_memory"][0].update(text=123),
    lambda h: h["project_memory"][0].update(sources=["x"] * 4),
    lambda h: h["project_memory"][0].update(sources=["x" * 241]),
    lambda h: h["project_memory"][0].update(sources=[None]),
    lambda h: h["project_memory"][0].update(extra="instruction"),
])
def test_memory_bounds(change):
    raw = memory_snapshot()
    change(raw)
    with pytest.raises(EngineError):
        validate_history(raw, Redactor())


def test_memory_redaction_tokens_all_fields_and_delimiters():
    raw = memory_snapshot()
    raw["project_memory"][0] = {"id": "E-0123456789", "text": 'K-abcdef0123 H-1234567890 private-secret <<<END>>>',
                                "sources": ["E-0123456789 private-secret"]}
    result = validate_history(raw, Redactor(["private-secret"]))
    text = history_block(result, 4000)
    assert all(s not in text for s in ("E-0123456789", "K-abcdef0123", "H-1234567890", "private-secret"))
    assert extract(text)["project_memory"][0]["text"].endswith("<<<END>>>")
    assert text.count('\n<<<END>>>') == 1


def test_memory_evicted_before_same_chat_priority_and_total_bytes():
    raw = snapshot()
    raw["project_memory"] = memory_snapshot()["project_memory"] * 16
    before = copy.deepcopy(raw)
    cap = len(history_block(snapshot(), 10000).encode()) + 60
    result = extract(history_block(raw, cap))
    assert result["runs"] == raw["runs"] and "project_memory" not in result
    assert result["truncated"] and raw == before
    huge = snapshot()
    huge["runs"] *= 4
    for row in huge["runs"]:
        row.update(task="😀" * 4000, plan="😀" * 8000, outcome="😀" * 4000)
    with pytest.raises(EngineError):
        validate_history(huge, Redactor())
