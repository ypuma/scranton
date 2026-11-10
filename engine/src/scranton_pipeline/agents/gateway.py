"""One bounded call, no hidden retries; LangGraph owns transient retry policy."""
import json
import queue
import threading
import time
from collections.abc import Mapping
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Generic, Protocol, TypeVar

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from pydantic import BaseModel, ValidationError

from scranton_pipeline.agents.providers import Role
from scranton_pipeline.config import EngineConfig
from scranton_pipeline.errors import EngineError, FailureClass, SuspendRequested, TransientError
from scranton_pipeline.models import Usage
from scranton_pipeline.observability import EventLog, UsageLedger

T = TypeVar("T", bound=BaseModel)
call_context: ContextVar[tuple[str, str | None]] = ContextVar("pipeline_call", default=("", None))


@dataclass(frozen=True)
class Completion(Generic[T]):  # noqa: UP046
    parsed: T
    usage: Usage
    model: str
    duration_s: float


class ModelGateway(Protocol):
    def complete(self, role: Role, *, system: str, user: str, schema: type[T], guidance_bytes: int = 0) -> Completion[T]: ...


def first_object(text: str) -> Any:
    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char == "{":
            try:
                return decoder.raw_decode(text[index:])[0]
            except json.JSONDecodeError:
                continue
    raise ValueError("No JSON object in model response")


def json_system(system: str, schema: type[BaseModel]) -> str:
    suffix = "\nReturn one JSON object matching:\n" + json.dumps(schema.model_json_schema())
    return system if system.endswith(suffix) else system + suffix


def deadline_call(fn: Any, seconds: float) -> Any:
    result: queue.Queue[tuple[bool, Any]] = queue.Queue(maxsize=1)

    def worker() -> None:
        try:
            result.put((True, fn()))
        except Exception as exc:  # noqa: BLE001 - transfer worker failures to caller
            result.put((False, exc))

    threading.Thread(target=worker, daemon=True).start()
    try:
        ok, value = result.get(timeout=seconds)
    except queue.Empty:
        raise TransientError("Model total deadline exceeded") from None
    if not ok:
        raise value
    return value


class ChatModelGateway:
    def __init__(self, models: Mapping[Role, BaseChatModel], cfg: EngineConfig,
                 ledger: UsageLedger, events: EventLog) -> None:
        self.models, self.cfg, self.ledger, self.events = models, cfg, ledger, events

    def complete(self, role: Role, *, system: str, user: str, schema: type[T], guidance_bytes: int = 0) -> Completion[T]:
        cfg = getattr(self.cfg.models, role)
        model = self.models[role]
        if cfg.structured_output == "json_text":
            system = json_system(system, schema)
        cap = self.cfg.limits.max_prompt_bytes - len(system.encode())
        if cap < 0:
            raise EngineError(FailureClass.LIMIT, "prompt_budget_exhausted", "System/schema exceeds prompt budget")
        allowance = min(max(0, guidance_bytes), self.cfg.procedure.max_bytes) if self.cfg.procedure.enabled else 0
        user = user.encode()[:cap + allowance].decode("utf-8", errors="ignore")
        started = time.monotonic()
        raw: AIMessage | None = None
        ok = False
        estimated = True
        input_tokens = max(1, (len(system.encode()) + len(user.encode())) // 4)
        output_tokens = cfg.max_output_tokens
        scope, lane = call_context.get()
        reservation, role_cursor, scope_cursor = self.ledger.reserve(role=role, model=cfg.model, scope=scope,
            input_tokens=input_tokens, output_tokens=output_tokens, max_calls=self.cfg.limits.max_llm_calls,
            max_tokens=self.cfg.limits.max_total_tokens)
        try:
            messages = [SystemMessage(content=system), HumanMessage(content=user)]
            if cfg.structured_output == "json_text":
                # Command calls own the deadline and must finish tree cleanup before retry.
                options: dict[str, Any] = {"pipeline_cursor": role_cursor, "pipeline_scope_cursor": scope_cursor, "pipeline_scope": scope} if cfg.provider == "scripted" else {}
                raw = model.invoke(messages) if cfg.provider == "command" else deadline_call(lambda: model.invoke(messages, **options), cfg.timeout_s)
                assert raw is not None
                text = raw.content if isinstance(raw.content, str) else json.dumps(raw.content)
                output_tokens = max(1, len(text.encode()) // 4)
                parsed = schema.model_validate(first_object(text))
            else:
                runnable = model.with_structured_output(schema, method=cfg.structured_output, include_raw=True)
                result = deadline_call(lambda: runnable.invoke(messages), cfg.timeout_s)
                raw = result["raw"]
                if result["parsing_error"] or result["parsed"] is None:
                    raise ValueError(str(result["parsing_error"]))
                parsed = schema.model_validate(result["parsed"])
            if raw is not None and raw.usage_metadata:
                input_tokens = raw.usage_metadata["input_tokens"]
                output_tokens = raw.usage_metadata["output_tokens"]
            ok = True
            return Completion(parsed=parsed, usage=Usage(input_tokens=input_tokens, output_tokens=output_tokens, calls=1),
                              model=cfg.model, duration_s=time.monotonic() - started)
        except (ValidationError, ValueError) as exc:
            raise EngineError(FailureClass.LLM_OUTPUT, "output_invalid", "Invalid model output", detail=str(exc)[:2000]) from exc
        except (EngineError, TransientError, SuspendRequested):
            raise
        except Exception as exc:
            code = getattr(exc, "status_code", None)
            if code in (408, 429) or (isinstance(code, int) and code >= 500) or isinstance(exc, (TimeoutError, ConnectionError)) or "connection" in type(exc).__name__.lower() or "timeout" in type(exc).__name__.lower():
                raise TransientError("Provider transport unavailable") from exc
            raise EngineError(FailureClass.INFRASTRUCTURE, "provider_rejected", "Provider rejected the request") from exc
        finally:
            if raw is not None and raw.usage_metadata:
                input_tokens = raw.usage_metadata["input_tokens"]
                output_tokens = raw.usage_metadata["output_tokens"]
                estimated = False
            duration = time.monotonic() - started
            self.ledger.finish(reservation, input_tokens=input_tokens, output_tokens=output_tokens, ok=ok, duration_s=duration)
            self.events.emit("llm_call", role=role, model=cfg.model, ok=ok, input_tokens=input_tokens,
                             output_tokens=output_tokens, duration_s=duration, estimated=estimated, **({"lane": lane} if lane else {}))
