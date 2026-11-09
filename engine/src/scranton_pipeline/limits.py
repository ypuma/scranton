"""Conservative superstep bound, including every explicit repair/context edge."""
from scranton_pipeline.config import Limits


def recursion_limit(limits: Limits) -> int:
    # Repairs and context rounds are scoped, not reset after each edit attempt.
    planning = 1 + 2 * limits.max_plan_context_rounds + limits.max_output_repairs
    work = (1 + limits.max_output_repairs + 2 * limits.max_step_context_rounds
            + 3 * limits.max_step_attempts)
    reviews = (limits.max_review_rounds + 1) * (1 + limits.max_output_repairs)
    return (16 + planning + limits.max_plan_steps * work
            + limits.max_review_rounds * work + reviews)
