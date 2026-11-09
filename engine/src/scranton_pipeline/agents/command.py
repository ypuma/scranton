"""Protocol-v1 completion subprocess; prompt files never outlive the owned call."""
import json
import tempfile
from pathlib import Path
from typing import Any

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import ConfigDict

from scranton_pipeline.config import ModelConfig
from scranton_pipeline.errors import EngineError, FailureClass, SuspendRequested, TransientError
from scranton_pipeline.tools.process import StopSignal, run_process
from scranton_pipeline.tools.secrets import Redactor


class CommandChatModel(BaseChatModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    cfg: ModelConfig
    environment: dict[str, str]
    role: str
    run_dir: Path
    stop_signal: StopSignal | None = None

    @property
    def _llm_type(self) -> str:
        return "command"

    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None,
                  run_manager: CallbackManagerForLLMRun | None = None, **kwargs: Any) -> ChatResult:
        root = self.run_dir / "tmp" / "provider"
        root.mkdir(parents=True, exist_ok=True)
        env = {k: v for k, v in self.environment.items() if not k.upper().startswith("SCRANTON_PIPELINE_KEY_")}
        with tempfile.TemporaryDirectory(prefix="call-", dir=root) as private:
            cwd = Path(private)
            request, response = cwd / "request.json", cwd / "response.json"
            request.write_text(json.dumps({"v": 1, "role": self.role, "model": self.cfg.model,
                "system": "\n".join(str(m.content) for m in messages if m.type == "system"),
                "user": "\n".join(str(m.content) for m in messages if m.type == "human"),
                "max_output_tokens": self.cfg.max_output_tokens, "temperature": self.cfg.temperature}), encoding="utf-8")
            result = run_process([*self.cfg.command, str(request), str(response)], cwd=cwd, env=env,
                                 timeout_s=self.cfg.timeout_s, stop=self.stop_signal)
            if result.stopped and self.stop_signal and self.stop_signal.suspend_requested():
                raise SuspendRequested()
            if result.timed_out or result.stopped or result.exit_code == 75:
                raise TransientError("Command provider unavailable or stopped")
            detail = Redactor().redact(result.output_tail)[:2000]
            if result.exit_code != 0:
                raise EngineError(FailureClass.INFRASTRUCTURE, "provider_rejected", "Command provider rejected request", detail=detail)
            try:
                if response.stat().st_size > 4_000_000:
                    raise ValueError("Response too large")
                value = json.loads(response.read_text(encoding="utf-8"))
                if not isinstance(value, dict) or not isinstance(value.get("text"), str) or "usage" not in value:
                    raise ValueError("Invalid response")
                usage = value["usage"]
                if usage is not None:
                    if not isinstance(usage, dict) or any(type(usage.get(k)) is not int or usage[k] < 0
                                                       for k in ("input_tokens", "output_tokens")):
                        raise ValueError("Invalid usage")
                    usage = {"input_tokens": usage["input_tokens"], "output_tokens": usage["output_tokens"],
                             "total_tokens": usage["input_tokens"] + usage["output_tokens"]}
                return ChatResult(generations=[ChatGeneration(message=AIMessage(content=value["text"], usage_metadata=usage))])
            except (OSError, ValueError) as exc:
                raise EngineError(FailureClass.INFRASTRUCTURE, "provider_rejected", "Invalid command provider response", detail=detail) from exc
