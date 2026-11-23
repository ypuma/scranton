"""Validated operator configuration. No credentials are stored here."""
import hashlib
import ipaddress
import json
import re
from pathlib import Path
from typing import Literal, Self
from urllib.parse import urlsplit

from pydantic import Field, ValidationError, field_validator, model_validator

from .errors import EngineError, FailureClass
from .models import StrictModel

DEFAULT_PROTECTED = (".pipeline/**", ".git/**", ".env", ".env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx",
                     "**/id_rsa*", "**/id_ed25519*", ".ssh/**", ".npmrc", ".pypirc",
                     "**/credentials.json", "**/auth.json")
DEFAULT_WRITE_PROTECTED = ("package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock",
                           "uv.lock", "Cargo.lock", ".github/**", ".gitlab-ci.yml")


class Limits(StrictModel):
    max_plan_context_rounds: int = Field(default=3, ge=0, le=10)
    max_step_context_rounds: int = Field(default=2, ge=0, le=10)
    max_output_repairs: int = Field(default=2, ge=0, le=10)
    max_step_attempts: int = Field(default=3, ge=1, le=10)
    max_replans: int = Field(default=1, ge=0, le=3)
    max_review_rounds: int = Field(default=2, ge=0, le=10)
    max_plan_steps: int = Field(default=8, ge=1, le=32)
    max_llm_calls: int = Field(default=40, ge=1, le=200)
    max_total_tokens: int = Field(default=1500000, ge=1, le=10000000)
    max_active_seconds: float = Field(default=3600, gt=0, le=14400)
    max_file_bytes: int = Field(default=1000000, ge=1, le=2000000)
    max_workspace_files: int = Field(default=20000, ge=1, le=100000)
    max_workspace_bytes: int = Field(default=100000000, ge=1, le=1000000000)
    max_changed_files: int = Field(default=25, ge=1, le=100)
    max_context_bytes: int = Field(default=100000, ge=1, le=1000000)
    max_context_item_bytes: int = Field(default=20000, ge=1, le=200000)
    max_search_matches: int = Field(default=100, ge=1, le=1000)
    max_prompt_bytes: int = Field(default=200000, ge=1, le=2000000)
    max_transient_attempts: int = Field(default=3, ge=1, le=10)
    git_timeout_s: float = Field(default=30, gt=0, le=120)
    max_log_bytes: int = Field(default=5000000, ge=1, le=20000000)
    max_output_tail_bytes: int = Field(default=8192, ge=1, le=65536)


class Policy(StrictModel):
    protected_paths: list[str] = Field(default_factory=list, max_length=100)
    write_protected_paths: list[str] = Field(default_factory=list, max_length=100)
    scope: Literal["plan_plus_flagged", "strict"] = "plan_plus_flagged"
    max_undeclared_files: int = Field(default=2, ge=0, le=10)


class ModelConfig(StrictModel):
    provider: Literal["openai_compatible", "scripted", "command"] = "openai_compatible"
    model: str = Field(default="", max_length=1024)
    base_url: str = Field(default="https://api.openai.com/v1", max_length=4096)
    api_key_env: str = Field(default="OPENAI_API_KEY", pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    structured_output: Literal["json_text", "json_schema", "function_calling"] = "json_text"
    temperature: float = Field(default=0, ge=0, le=2, allow_inf_nan=False)
    max_output_tokens: int = Field(default=8192, ge=1, le=65536)
    timeout_s: float = Field(default=180, gt=0, le=600, allow_inf_nan=False)
    script_path: str = Field(default="", max_length=4096)

    command: list[str] = Field(default_factory=list, max_length=32, exclude_if=lambda value: not value)

    @field_validator("command")
    @classmethod
    def valid_command(cls, value: list[str]) -> list[str]:
        if any(not arg or "\0" in arg or len(arg) > 32768 for arg in value):
            raise ValueError("command requires non-empty, NUL-free arguments")
        return value

    @field_validator("base_url")
    @classmethod
    def safe_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("base_url cannot contain credentials, query or fragment")
        loopback = parsed.hostname == "localhost"
        try:
            loopback = loopback or ipaddress.ip_address(parsed.hostname or "").is_loopback
        except ValueError:
            pass
        if not parsed.hostname or not (parsed.scheme == "https" or parsed.scheme == "http" and loopback):
            raise ValueError("base_url requires HTTPS (HTTP allowed only on loopback)")
        return value

    @model_validator(mode="after")
    def valid_provider(self) -> Self:
        if self.provider == "command":
            if not self.command or self.structured_output != "json_text" or self.script_path:
                raise ValueError("command requires command argv, json_text and no script_path")
            return self
        if self.command or "command" in self.model_fields_set:
            raise ValueError("command is only allowed for the command provider")
        if self.provider == "scripted":
            if not self.script_path or self.structured_output != "json_text":
                raise ValueError("scripted requires script_path and json_text")
        elif not self.model or self.script_path:
            raise ValueError("openai_compatible requires model and no script_path")
        return self


class DockerConfig(StrictModel):
    image: str | None = Field(default=None, min_length=1, max_length=512, pattern=r"^[^\s-][^\s]*$")
    cpus: float = Field(default=2, gt=0, le=16, allow_inf_nan=False)
    memory_mb: int = Field(default=2048, ge=128, le=32768)
    pids: int = Field(default=256, ge=16, le=4096)
    tmpfs_mb: int = Field(default=512, ge=64, le=4096)


class InvalidNativePassthrough(ValueError):
    """A safe, name-only diagnostic that load_config may report."""


class SandboxConfig(StrictModel):
    mode: Literal["scranton", "docker", "host"] = "scranton"
    windows_mode: Literal["low", "strict"] = Field(default="low", exclude_if=lambda value: value == "low")
    docker: DockerConfig = Field(default_factory=DockerConfig)
    env_passthrough: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def native_environment(self) -> Self:
        # Match the runner's payload policy; do not change Host or Docker.
        denied = r"^(?:SCRANTON_|PI_CODING_AGENT_DIR$)|API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|(?:^|_)AUTH(?:_|$)"
        if self.mode == "scranton":
            for name in self.env_passthrough:
                upper = name.upper()
                if (not re.fullmatch(r"[^=\x00-\x1f]+", name) or re.search(denied, upper)
                        or (upper.startswith("NODE_") and upper != "NODE_ENV")):
                    raise InvalidNativePassthrough(f"env_passthrough: {name[:128]!r} is not allowed in Scranton sandbox mode")
        return self


# Shared check/setup id rule (also consumed by the Node and UI validators).
COMMAND_ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"


class CommandConfig(StrictModel):
    id: str = Field(pattern=COMMAND_ID_PATTERN)
    argv: list[str] = Field(min_length=1, max_length=64)
    timeout_s: float = Field(default=600, gt=0, le=3600, allow_inf_nan=False)
    network: bool = False

    @field_validator("argv")
    @classmethod
    def valid_argv(cls, value: list[str]) -> list[str]:
        if not value[0] or any("\0" in s or len(s) > 32768 for s in value):
            raise ValueError("invalid argv")
        return value


class CheckConfig(CommandConfig):
    kind: Literal["syntax", "lint", "typecheck", "test", "security", "other"] = "test"
    required: bool = True
    scope: Literal["step", "final"] = "step"

    @model_validator(mode="after")
    def offline(self) -> Self:
        if self.network:
            raise ValueError("checks cannot enable network")
        return self


class ApprovalsConfig(StrictModel):
    plan: Literal["always", "auto_low_risk"] = "always"


class ReviewConfig(StrictModel):
    enabled: bool = True


class Pricing(StrictModel):
    input_per_mtok: float = Field(default=0, ge=0, allow_inf_nan=False)
    output_per_mtok: float = Field(default=0, ge=0, allow_inf_nan=False)


class ModelsConfig(StrictModel):
    planner: ModelConfig
    implementer: ModelConfig
    reviewer: ModelConfig
    refiner: ModelConfig | None = Field(default=None, exclude_if=lambda value: value is None)


class ExecutionConfig(StrictModel):
    max_parallel_steps: int = Field(default=1, ge=1, le=4)
    max_lane_workspace_bytes: int = Field(default=536870912, ge=1)


class GroundingWeights(StrictModel):
    answer: float = Field(default=0.5, ge=0, le=1, allow_inf_nan=False)
    trajectory: float = Field(default=0.5, ge=0, le=1, allow_inf_nan=False)

    @model_validator(mode="after")
    def normalized(self) -> Self:
        if abs(self.answer + self.trajectory - 1) > 1e-9:
            raise ValueError("grounding weights must sum to one")
        return self


class GroundingConfig(StrictModel):
    mode: Literal["enforce", "observe"] = "enforce"
    counterfactual: Literal["auto", "off"] = "auto"
    test_globs: list[str] = Field(default_factory=lambda: ["tests/**", "test/**", "**/test_*.py", "**/*_test.*", "**/*.test.*", "**/*.spec.*"], max_length=100)
    weights: GroundingWeights = Field(default_factory=GroundingWeights)


class ProcedureConfig(StrictModel):
    enabled: bool = False
    graph: str | None = Field(default=None, min_length=1, max_length=4096)
    hops: int = Field(default=2, ge=0, le=2)
    max_bytes: int = Field(default=1500, ge=1, le=2000000)


class StrictSetupNetwork(ValueError):
    pass


class EngineConfig(StrictModel):
    agents_md: bool = Field(default=True, alias="agentsMd", strict=True, exclude_if=lambda value: value)
    conversation: bool = Field(default=False, strict=True, exclude_if=lambda value: not value)
    procedure: ProcedureConfig = Field(default_factory=ProcedureConfig)
    grounding: GroundingConfig = Field(default_factory=GroundingConfig)
    schema_version: Literal[1] = Field(default=1, alias="schema", serialization_alias="schema")
    models: ModelsConfig
    sandbox: SandboxConfig = Field(default_factory=SandboxConfig)
    setup: list[CommandConfig] = Field(default_factory=list, max_length=4)
    checks: list[CheckConfig] = Field(default_factory=list, max_length=12)
    allow_no_checks: bool = False
    approvals: ApprovalsConfig = Field(default_factory=ApprovalsConfig)
    review: ReviewConfig = Field(default_factory=ReviewConfig)
    policy: Policy = Field(default_factory=Policy)
    limits: Limits = Field(default_factory=Limits)
    execution: ExecutionConfig = Field(default_factory=ExecutionConfig)
    pricing: dict[str, Pricing] = Field(default_factory=dict)

    @model_validator(mode="after")
    def valid_checks(self) -> Self:
        if self.sandbox.mode == "scranton" and self.sandbox.windows_mode == "strict":
            for index, command in enumerate(self.setup):
                if command.network:
                    raise StrictSetupNetwork(f"setup[{index}].network is not allowed in strict Scranton sandbox mode")
        if not self.checks and not self.allow_no_checks:
            raise ValueError("checks required unless allow_no_checks is true")
        for commands in (self.checks, self.setup):
            if len({c.id for c in commands}) != len(commands):
                raise ValueError("duplicate command ids")
        return self


def load_config(path: Path) -> EngineConfig:
    try:
        with path.open("rb") as stream:
            raw = stream.read(262145)
        if len(raw) > 262144:
            raise ValueError("config exceeds 256 KiB")
        if re.search(rb'"(?:api_key|password|token|secret)"\s*:', raw, re.IGNORECASE):
            raise ValueError("config must name environment variables, never credentials")
        return EngineConfig.model_validate_json(raw)
    except (OSError, ValueError, ValidationError) as exc:
        safe_error = None
        if isinstance(exc, ValidationError):
            safe_error = next((e["ctx"]["error"] for e in exc.errors()
                               if isinstance(e.get("ctx", {}).get("error"), (StrictSetupNetwork, InvalidNativePassthrough))), None)
        raise EngineError(FailureClass.INVALID_INPUT, "invalid_config", str(safe_error) if safe_error else "Invalid configuration", detail=str(exc)) from exc


def config_digest(cfg: EngineConfig) -> str:
    return hashlib.sha256(json.dumps(cfg.model_dump(mode="json", by_alias=True), sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()
