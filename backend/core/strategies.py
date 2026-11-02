"""Extraction strategies: the ablation ladder from "what the prototype does today" to the proposed hybrid."""
from __future__ import annotations

from backend.schemas.engines import (
    STRATEGY_ENUM_GRAMMAR,
    STRATEGY_FREE_JSON,
    STRATEGY_HYBRID,
    STRATEGY_HYBRID_ALWAYS,
    STRATEGY_RULES_ONLY,
    STRATEGY_SCHEMA_CONSTRAINED,
    StrategyInfo,
)

STRATEGIES: list[StrategyInfo] = [
    StrategyInfo(
        id=STRATEGY_FREE_JSON, name="Free JSON (baseline)", uses_llm=True, deterministic_stages=False, constrained=False,
        description="One prompt with the whole form on the raw transcript, unconstrained JSON, lenient parse, values "
                    "accepted as-is. A reconstruction of a typical prototype; replace the prompt with the customer's.",
    ),
    StrategyInfo(
        id=STRATEGY_SCHEMA_CONSTRAINED, name="Schema constrained", uses_llm=True, deterministic_stages=False,
        constrained=True,
        description="Same full-form prompt, but decoding is constrained to the form's JSON schema. Guarantees structure, "
                    "not correctness.",
    ),
    StrategyInfo(
        id=STRATEGY_ENUM_GRAMMAR, name="Enum grammar (LLM only)", uses_llm=True, deterministic_stages=False,
        constrained=True,
        description="Normalized transcript, compact prompt, tight grammar: enum values and ids heard in the statement "
                    "only, no whitespace. The LLM still decides every field.",
    ),
    StrategyInfo(
        id=STRATEGY_HYBRID, name="Hybrid (proposed)", uses_llm=True, deterministic_stages=True, constrained=True,
        description="Normalize numbers, resolve ids against the job's closed world, match enums with the form lexicon, "
                    "then ask the LLM only about what is left and only when unexplained words remain. Validate; "
                    "LLM suggestions are flagged for review.",
    ),
    StrategyInfo(
        id=STRATEGY_HYBRID_ALWAYS, name="Hybrid, always ask LLM", uses_llm=True, deterministic_stages=True,
        constrained=True,
        description="Hybrid without the 'unexplained words' gate: the LLM is asked about every unresolved field. "
                    "Isolates the cost and benefit of gating.",
    ),
    StrategyInfo(
        id=STRATEGY_RULES_ONLY, name="Rules only (no LLM)", uses_llm=False, deterministic_stages=True, constrained=False,
        description="Deterministic stages only. Always available; the offline fallback when no model can be loaded.",
    ),
]


def get_strategy(strategy_id: str) -> StrategyInfo:
    for s in STRATEGIES:
        if s.id == strategy_id:
            return s
    raise KeyError(f"unknown strategy {strategy_id!r}")
