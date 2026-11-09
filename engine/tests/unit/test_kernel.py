import json

import pytest
from pydantic import ValidationError

from scranton_pipeline.config import EngineConfig, Limits, ModelConfig, config_digest, load_config
from scranton_pipeline.errors import EngineError, FailureClass, SuspendRequested, TransientError
from scranton_pipeline.models import FileEdit, ImplementerTurn, PlannerTurn, Review, RunStatus
from scranton_pipeline.state import (
    append_bounded,
    counter,
    current_step,
    get_plan,
    keep_first,
    merge_counters,
)


def config_data():
    model = {"provider": "scripted", "script_path": "fixture.json"}
    return {"models": {role: model for role in ("planner", "implementer", "reviewer")}, "allow_no_checks": True}


def test_plain_dictionary_reducers_and_accessors():
    a = {"attempts:S1": 2}
    assert merge_counters(a, {"attempts:S1": 1, "context:S1": 1}) == {"attempts:S1": 3, "context:S1": 1}
    assert a == {"attempts:S1": 2}
    assert len(append_bounded([{"n": n} for n in range(200)], [{"n": 200}])) == 200
    assert keep_first({"message": "first"}, {"message": "second"}) == {"message": "first"}
    assert keep_first("", "cancelled") == "cancelled"
    assert get_plan({}) is None and current_step({}) is None and counter({}, "x") == 0
    state = {"step_index": 0, "plan": {"summary": "s", "acceptance_criteria": [{"id": "C1", "text": "t", "verified_by": "checks"}],
             "steps": [{"id": "S1", "title": "t", "description": "d", "files": []}]}}
    assert current_step(state).id == "S1"
    assert json.loads(json.dumps(state)) == state


@pytest.mark.parametrize("data", [
    {"path": "x", "action": "create"},
    {"path": "x", "action": "modify"},
    {"path": "x", "action": "modify", "content": "x", "replacements": [{"search": "a", "replace": "b"}]},
    {"path": "x", "action": "delete", "content": ""},
])
def test_edit_shape_consistency(data):
    with pytest.raises(ValidationError):
        FileEdit.model_validate(data)


@pytest.mark.parametrize("model,data", [
    (PlannerTurn, {"kind": "plan"}),
    (PlannerTurn, {"kind": "need_context"}),
    (ImplementerTurn, {"kind": "blocked"}),
    (ImplementerTurn, {"kind": "edits", "blocked_reason": "no"}),
    (Review, {"verdict": "approve", "summary": "s", "criteria": [{"id": "c", "status": "not_met"}]}),
    (Review, {"verdict": "approve", "summary": "s", "findings": [{"severity": "blocking", "category": "tests", "description": "bad"}]}),
])
def test_turn_shape_consistency(model, data):
    with pytest.raises(ValidationError):
        model.model_validate(data)


def test_llm_extras_tolerated_but_operator_extras_forbidden():
    assert FileEdit(path="x", action="create", content="", irrelevant=1).content == ""
    with pytest.raises(ValidationError):
        Limits(unknown_limit=4)
    with pytest.raises(ValidationError):
        FileEdit(path="a" * 5000, action="delete")


@pytest.mark.parametrize("field", list(Limits.model_fields))
def test_every_limit_has_a_default_and_hard_ceiling(field):
    assert getattr(Limits(), field) > 0 or field.endswith("rounds") or field == "max_output_repairs"
    with pytest.raises(ValidationError):
        Limits.model_validate({field: 10**20})


@pytest.mark.parametrize("url", ["http://remote.test/v1", "https://u:p@host/v1", "file:///x", "https://host/?key=x"])
def test_provider_url_rejects_insecure_or_embedded_credentials(url):
    with pytest.raises(ValidationError):
        ModelConfig(model="m", base_url=url)


def test_config_file_bounds_digest_and_no_secrets(tmp_path):
    raw = config_data()
    cfg = EngineConfig.model_validate(raw)
    assert config_digest(cfg) == config_digest(EngineConfig.model_validate(raw))
    path = tmp_path / "cfg.json"
    path.write_text(json.dumps(raw))
    assert load_config(path) == cfg
    assert cfg.model_dump(by_alias=True)["schema"] == 1
    with pytest.raises(ValidationError):
        cfg.allow_no_checks = False
    raw["allow_no_checks"] = False
    with pytest.raises(ValidationError):
        EngineConfig.model_validate(raw)
    path.write_bytes(b" " * 262145)
    with pytest.raises(EngineError) as raised:
        load_config(path)
    assert raised.value.failure_class == FailureClass.INVALID_INPUT
    path.write_text('{"api_key": "not-allowed"}')
    with pytest.raises(EngineError):
        load_config(path)


def test_error_taxonomy_and_run_status_alias():
    error = EngineError(FailureClass.SECURITY, "unsafe_path", "Unsafe", detail="why")
    assert error.to_failure("apply_edits") == {"failure_class": "security", "code": "unsafe_path", "message": "Unsafe", "node": "apply_edits"}
    assert not issubclass(TransientError, EngineError)
    assert not issubclass(SuspendRequested, EngineError)
    status = RunStatus(run_id="abcdefgh", status="running", phase="prepare")
    assert status.model_dump(by_alias=True)["schema"] == 1
