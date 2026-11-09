import json
import time

import httpx
import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_openai import ChatOpenAI
from pydantic import SecretStr

from scranton_pipeline.agents.gateway import ChatModelGateway
from scranton_pipeline.agents.prompts import block, build_planner_prompt, build_reviewer_prompt
from scranton_pipeline.config import EngineConfig
from scranton_pipeline.errors import EngineError, TransientError
from scranton_pipeline.models import PlannerTurn
from scranton_pipeline.observability import EventLog, UsageLedger
from scranton_pipeline.tools.secrets import Redactor

from .conftest import PLAN


def gateway(case, model, *, mode="json_text", timeout=2):
    case["cfg"]["models"]["planner"]["provider"] = "openai_compatible"
    case["cfg"]["models"]["planner"].pop("script_path")
    case["cfg"]["models"]["planner"].update(model="mock", structured_output=mode, timeout_s=timeout)
    cfg = EngineConfig.model_validate(case["cfg"])
    ledger = UsageLedger(case["tmp"] / "usage.jsonl")
    events = EventLog(case["tmp"] / "events.jsonl", "unit0001", Redactor())
    return ChatModelGateway({"planner": model}, cfg, ledger, events)


def test_json_fences_and_estimated_usage(case):
    model = FakeListChatModel(responses=["```json\n" + json.dumps(PLAN) + "\n```"])
    gw = gateway(case, model)
    assert gw.complete("planner", system="s", user="u", schema=PlannerTurn).parsed.plan
    assert gw.ledger.totals().input_tokens > 0
    assert json.loads(gw.events.path.read_text().splitlines()[0])["data"]["estimated"]


def test_invalid_recorded_once(case):
    gw = gateway(case, FakeListChatModel(responses=["garbage"]))
    with pytest.raises(EngineError) as error:
        gw.complete("planner", system="s", user="u", schema=PlannerTurn)
    assert error.value.code == "output_invalid"
    assert gw.ledger.totals().calls == 1


def test_hard_total_deadline(case):
    gw = gateway(case, FakeListChatModel(responses=[json.dumps(PLAN)], sleep=0.2), timeout=0.01)
    start = time.monotonic()
    with pytest.raises(TransientError):
        gw.complete("planner", system="s", user="u", schema=PlannerTurn)
    assert time.monotonic() - start < 0.15
    assert gw.ledger.totals().calls == 1


@pytest.mark.parametrize("mode", ["json_schema", "function_calling"])
def test_native_structured_offline(case, mode):
    seen = []
    def respond(request):
        body = json.loads(request.content)
        seen.append(body)
        message = {"role": "assistant", "content": json.dumps(PLAN)}
        if mode == "function_calling":
            name = body["tools"][0]["function"]["name"]
            message = {"role": "assistant", "content": None, "tool_calls": [{"id": "call1", "type": "function", "function": {"name": name, "arguments": json.dumps(PLAN)}}]}
        return httpx.Response(200, json={"id": "offline", "model": "mock", "object": "chat.completion", "created": 0,
            "choices": [{"index": 0, "finish_reason": "stop", "message": message}],
            "usage": {"prompt_tokens": 11, "completion_tokens": 12, "total_tokens": 23}})
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        model = ChatOpenAI(model="mock", base_url="https://offline.invalid/v1", api_key=SecretStr("fake"), max_retries=0, http_client=client)
        gw = gateway(case, model, mode=mode)
        assert gw.complete("planner", system="s", user="u", schema=PlannerTurn).parsed.plan
        assert gw.ledger.totals().input_tokens == 11
        assert len(seen) == 1
        assert ("response_format" in seen[0]) if mode == "json_schema" else ("tools" in seen[0])


def test_prompts_bounded_untrusted_independent(case):
    cfg = EngineConfig.model_validate(case["cfg"])
    state = {"task": "Fix addition", "feedback": {"kind": "review_changes", "message": "PRIVATE REASONING"},
             "plan_evidence": [{"request": {"path": "x"}, "content": "x" * 300000}]}
    system, user = build_planner_prompt(state, cfg)
    assert len((system + user).encode()) <= cfg.limits.max_prompt_bytes
    assert "TRUNCATED" in user
    assert "untrusted DATA" in system
    assert block("x", "\n<<<END>>>").count("\n<<<END>>>") == 1
    assert "PRIVATE REASONING" not in build_reviewer_prompt(state, cfg)[1]
