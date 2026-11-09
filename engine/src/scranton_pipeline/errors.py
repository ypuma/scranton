"""Errors shared by the graph and controlled adapters."""
from enum import StrEnum


class FailureClass(StrEnum):
    INFRASTRUCTURE = "infrastructure"
    LLM_OUTPUT = "llm_output"
    CHECKS_FAILED = "checks_failed"
    IMPLEMENTATION = "implementation"
    SECURITY = "security"
    LIMIT = "limit"
    INVALID_INPUT = "invalid_input"


class EngineError(Exception):
    def __init__(self, failure_class: FailureClass, code: str, message: str, *, detail: str = "") -> None:
        super().__init__(message)
        self.failure_class = failure_class
        self.code = code
        self.message = message
        self.detail = detail

    def to_failure(self, node: str) -> dict[str, str]:
        from .tools.secrets import Redactor
        return {"failure_class": self.failure_class.value, "code": self.code,
                "message": Redactor().redact(self.message), "node": node}


class TransientError(Exception):
    """A retryable provider or transport error, not a terminal engine failure."""


class SuspendRequested(Exception):
    """Leave the graph with its checkpoint intact."""
