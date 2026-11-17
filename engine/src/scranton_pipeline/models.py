"""Bounded model responses and immutable runtime records."""
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Role = Literal["planner", "implementer", "reviewer", "refiner"]
Text = Annotated[str, Field(max_length=32768)]
Short = Annotated[str, Field(max_length=1024)]
EvidenceId = Annotated[str, Field(pattern=r"^[EKH]-[0-9a-f]{10}$")]
PathText = Annotated[str, Field(max_length=4096)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class LlmModel(BaseModel):
    model_config = ConfigDict(extra="ignore")


class ContextRequest(LlmModel):
    kind: Literal["read", "search", "list"]
    path: PathText = ""
    query: Short = ""
    start_line: int | None = Field(default=None, ge=1, le=10000000)
    end_line: int | None = Field(default=None, ge=1, le=10000000)

    @model_validator(mode="after")
    def valid_range(self) -> Self:
        if self.start_line and self.end_line and self.start_line > self.end_line:
            raise ValueError("start_line exceeds end_line")
        return self


class Risk(LlmModel):
    description: Text
    severity: Literal["low", "medium", "high"]
    mitigation: Text = ""


class Criterion(LlmModel):
    id: Short
    text: Text
    verified_by: Literal["checks", "review"]
    checks: list[Short] = Field(default_factory=list, max_length=12)


class FileIntent(LlmModel):
    path: PathText
    action: Literal["create", "modify", "delete"]


class PlanStep(LlmModel):
    id: Short
    title: Short
    description: Text
    files: list[FileIntent] = Field(max_length=100)
    context_files: list[PathText] = Field(default_factory=list, max_length=100)
    criteria: list[Short] = Field(default_factory=list, max_length=100)
    depends_on: list[Short] | None = Field(default=None, max_length=32)


class AbsenceClaim(LlmModel):
    kind: Literal["missing_file", "missing_symbol"]
    subject: Short
    paths: list[PathText] = Field(default_factory=list, max_length=100)


class Plan(LlmModel):
    absent: list[AbsenceClaim] = Field(default_factory=list, max_length=100)
    summary: Text
    assumptions: list[Text] = Field(default_factory=list, max_length=100)
    risks: list[Risk] = Field(default_factory=list, max_length=100)
    acceptance_criteria: list[Criterion] = Field(min_length=1, max_length=100)
    steps: list[PlanStep] = Field(min_length=1, max_length=32)


class PlannerTurn(LlmModel):
    kind: Literal["need_context", "plan"]
    rationale: Text = ""
    context_requests: list[ContextRequest] = Field(default_factory=list, max_length=50)
    plan: Plan | None = None

    @model_validator(mode="after")
    def payload(self) -> Self:
        if self.kind == "plan":
            if self.plan is None or self.context_requests:
                raise ValueError("plan turn requires only a plan")
        elif not self.context_requests or self.plan is not None:
            raise ValueError("need_context requires only requests")
        return self


class Answer(LlmModel):
    text: Text
    citations: list[EvidenceId] = Field(default_factory=list, max_length=100)
    summary: Short = ""

    @field_validator("text")
    @classmethod
    def nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Answer must not be empty")
        return value


class ConversationPlannerTurn(LlmModel):
    kind: Literal["need_context", "plan", "answer"]
    rationale: Text = ""
    context_requests: list[ContextRequest] = Field(default_factory=list, max_length=50)
    plan: Plan | None = None
    answer: Answer | None = None

    @model_validator(mode="after")
    def payload(self) -> Self:
        if self.kind == "answer":
            if self.answer is None or self.plan is not None or self.context_requests:
                raise ValueError("answer turn requires only an answer")
        else:
            if self.answer is not None:
                raise ValueError("Only answer turns may carry an answer")
            PlannerTurn.model_validate(self.model_dump(exclude={"answer"}))
        return self


class Replacement(LlmModel):
    search: Annotated[str, Field(min_length=1, max_length=2000000)]
    replace: Annotated[str, Field(max_length=2000000)]


class FileEdit(LlmModel):
    path: PathText
    action: Literal["create", "modify", "delete"]
    content: Annotated[str, Field(max_length=2000000)] | None = None
    replacements: list[Replacement] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def payload(self) -> Self:
        if self.action == "create" and (self.content is None or self.replacements):
            raise ValueError("create requires content only")
        if self.action == "modify" and ((self.content is not None) == bool(self.replacements)):
            raise ValueError("modify requires content XOR replacements")
        if self.action == "delete" and (self.content is not None or self.replacements):
            raise ValueError("delete cannot have content or replacements")
        return self


class ImplementerTurn(LlmModel):
    kind: Literal["edits", "need_context", "blocked"]
    summary: Text = ""
    edits: list[FileEdit] = Field(default_factory=list, max_length=100)
    context_requests: list[ContextRequest] = Field(default_factory=list, max_length=50)
    blocked_reason: Text = ""
    blocked_claim: AbsenceClaim | None = None

    @model_validator(mode="after")
    def payload(self) -> Self:
        present = (bool(self.edits), bool(self.context_requests), bool(self.blocked_reason))
        if present != {"edits": (True, False, False), "need_context": (False, True, False),
                       "blocked": (False, False, True)}[self.kind]:
            raise ValueError("implementer kind and payload disagree")
        return self


class CriterionAssessment(LlmModel):
    id: Short
    status: Literal["met", "not_met", "unclear"]
    evidence: Text = ""
    citations: list[EvidenceId] = Field(default_factory=list, max_length=100)


class Finding(LlmModel):
    severity: Literal["blocking", "major", "minor", "info"]
    category: Literal["correctness", "security", "tests", "scope", "maintainability"]
    path: PathText = ""
    description: Text
    suggestion: Text = ""
    citations: list[EvidenceId] = Field(default_factory=list, max_length=100)


class Review(LlmModel):
    verdict: Literal["approve", "request_changes"]
    summary: Text
    criteria: list[CriterionAssessment] = Field(default_factory=list, max_length=100)
    findings: list[Finding] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def payload(self) -> Self:
        if self.verdict == "approve" and (any(f.severity == "blocking" for f in self.findings) or any(c.status == "not_met" for c in self.criteria)):
            raise ValueError("approval contradicts findings or criteria")
        return self


class CheckResult(StrictModel):
    id: str
    kind: str
    status: Literal["passed", "failed", "timed_out", "error"]
    exit_code: int | None
    duration_s: float
    output_tail: str
    log_path: str
    required: bool


class ContextItem(StrictModel):
    evidence_id: str = ""
    sha256: str = ""
    request: ContextRequest
    ok: bool
    content: str
    truncated: bool
    note: str = ""


class Feedback(StrictModel):
    kind: Literal["output_invalid", "edits_rejected", "checks_failed", "review_changes"]
    message: str
    details: list[str] = Field(default_factory=list)
    prior: "Feedback | None" = None  # output_invalid only: the feedback the invalid turn was answering


class StepRecord(StrictModel):
    step_id: str
    attempts: int
    commit: str
    changed_files: list[str]


class Usage(StrictModel):
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0


class RunStatus(StrictModel):
    reply: dict[str, Any] | None = Field(default=None, exclude_if=lambda value: value is None)
    grounding: dict[str, Any] = Field(default_factory=dict)
    procedure: dict[str, Any] = Field(default_factory=lambda: {"enabled": False, "name": None, "digest": None, "situation": None})
    schema_version: Literal[1] = Field(default=1, alias="schema", serialization_alias="schema")
    run_id: str
    status: Literal["running", "awaiting_approval", "suspended", "succeeded", "failed", "rejected", "cancelled"]
    phase: Literal["prepare", "plan", "approve_plan", "implement", "review", "deliver", "done"]
    node: str = ""
    task: str = Field(default="", max_length=500)
    source_dir: str = ""
    delivery_mode: Literal["patch", "apply"] = "patch"
    progress: dict[str, Any] = Field(default_factory=lambda: {"plan_revision": 0, "replans_left": 0, "steps_done": 0, "lanes": []})
    pending: dict[str, Any] | None = None

    @field_validator("progress", mode="before")
    @classmethod
    def progress_defaults(cls, value: dict[str, Any]) -> dict[str, Any]:
        return {"plan_revision": 0, "replans_left": 0, "steps_done": 0, "lanes": [], **value}

    @field_validator("pending", mode="before")
    @classmethod
    def pending_defaults(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value and value.get("gate") == "plan":
            return {"revision": 0, "replan_reason": None, **value}
        return value

    failure: dict[str, str] | None = None
    resumable: bool = False
    usage: dict[str, Any] = Field(default_factory=lambda: {"calls": 0, "input_tokens": 0, "output_tokens": 0, "estimated_cost": None})
    checks: list[dict[str, Any]] = Field(default_factory=list)
    delivery: dict[str, Any] | None = None
    artifacts: dict[str, Any] = Field(default_factory=dict)
    sandbox: dict[str, Any] = Field(default_factory=lambda: {"isolation": "Unknown (legacy status).", "image": None})

    @field_validator("sandbox", mode="before")
    @classmethod
    def sandbox_defaults(cls, value: dict[str, Any]) -> dict[str, Any]:
        return {"isolation": "Unknown (legacy status).", "image": None, **value}

    pid: int | None = None
    created_at: str = ""
    updated_at: str = ""
    engine_version: str = "0.1.0"
