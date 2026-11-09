"""Small provider registry; scripted cursors survive interpreter restarts via the ledger."""
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Literal

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import ConfigDict, SecretStr

from scranton_pipeline.config import ModelConfig
from scranton_pipeline.errors import EngineError, FailureClass, TransientError
from scranton_pipeline.observability import UsageLedger
from scranton_pipeline.tools.process import StopSignal

Role = Literal["planner", "implementer", "reviewer"]


class ScriptedChatModel(BaseChatModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    script_path: str
    ledger: Any
    role: Role

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None,
                  run_manager: CallbackManagerForLLMRun | None = None, **kwargs: Any) -> ChatResult:
        script = json.loads(Path(self.script_path).read_text(encoding="utf-8"))
        cursor = self.ledger.calls_for(self.role)
        if cursor >= len(script):
            raise EngineError(FailureClass.INFRASTRUCTURE, "script_exhausted", f"No scripted {self.role} response {cursor}")
        item = script[cursor]
        if isinstance(item, dict) and item.get("__error__") == "transient":
            raise TransientError("Scripted transport failure")
        content = item if isinstance(item, str) else json.dumps(item)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=content,
            usage_metadata={"input_tokens": 100, "output_tokens": 100, "total_tokens": 200}))])


def openai_compatible(cfg: ModelConfig, env: Mapping[str, str]) -> BaseChatModel:
    from langchain_openai import ChatOpenAI
    key = env.get(cfg.api_key_env or "", "")
    if not key:
        raise EngineError(FailureClass.INVALID_INPUT, "api_key_missing", "Configured API key environment variable is missing")
    return ChatOpenAI(model=cfg.model, base_url=cfg.base_url, api_key=SecretStr(key), max_retries=0,
                      temperature=cfg.temperature, max_completion_tokens=cfg.max_output_tokens, timeout=cfg.timeout_s)


def build_chat_model(cfg: ModelConfig, env: Mapping[str, str], *, ledger: UsageLedger, role: Role,
                     run_dir: Path | None = None, stop: StopSignal | None = None) -> BaseChatModel:
    if cfg.provider == "scripted":
        return ScriptedChatModel(script_path=str(cfg.script_path), ledger=ledger, role=role)
    if cfg.provider == "command":
        from scranton_pipeline.agents.command import CommandChatModel
        return CommandChatModel(cfg=cfg, environment=dict(env), role=role,
                                run_dir=run_dir or ledger.path.parent, stop_signal=stop)
    factories = {"openai_compatible": openai_compatible}
    return factories[cfg.provider](cfg, env)
