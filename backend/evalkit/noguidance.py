"""Run the evaluation CLI as if the language-model runtime had no constrained decoding.

The prebuilt ONNX Runtime GenAI iOS build is compiled without guidance (llguidance): a grammar or JSON-schema request is a
hard error there, never a silent fallback (see docs/IOS_SPIKE.md). This wrapper reproduces that on the Windows engines -
any Foundry LLM call that asks for a ``response_format`` raises the same message - so the pipeline's own fallback chain
(Lark grammar, then JSON schema, then none) ends up unconstrained. Everything else is the normal ``backend.evalkit.cli``:

    .venv\\Scripts\\python.exe -m backend.evalkit.noguidance run --dataset synth-v1 --split heldout --strategy hybrid ^
        --llm foundry:llm:qwen2.5-1.5b:cpu --label ios-noguidance-qwen2.5-1.5b

``--tolerant-enums`` (experiment) also accepts a model answer that names an enum option by its label or in another case,
instead of only the exact code - what a forgiving matcher in a port would recover once the grammar is gone. Combine it with
``FV_PATCH_PROMPT=v3`` (a flat prompt listing every option with its label and synonyms) for the best no-grammar setup tried.
"""
from __future__ import annotations

import sys

from backend.core import pipeline
from backend.engines.base import LlmResult
from backend.engines.foundry_engines import FoundryLlmEngine
from backend.evalkit import cli

GUIDANCE_UNAVAILABLE = 'Guidance is unavailable in this build (guidance_type="{kind}"). Rebuild with use_guidance=true.'
TOLERANT_FLAG = "--tolerant-enums"


def install(tolerant_enums: bool = False) -> None:
    """Make ``FoundryLlmEngine.complete`` refuse every guided request (and optionally match enum answers loosely)."""
    original = FoundryLlmEngine.complete

    def complete(self: FoundryLlmEngine, system: str, user: str, *, response_format: dict | None = None,
                 max_tokens: int = 200, temperature: float = 0.0) -> LlmResult:
        if response_format:
            raise RuntimeError(GUIDANCE_UNAVAILABLE.format(kind=response_format.get("type")))
        return original(self, system, user, response_format=None, max_tokens=max_tokens, temperature=temperature)

    FoundryLlmEngine.complete = complete  # type: ignore[method-assign]
    if tolerant_enums:
        strict = pipeline._coerce
        pipeline._coerce = lambda spec, raw, loose, candidates=None: strict(spec, raw, True, candidates)


def main(argv: list[str] | None = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    install(tolerant_enums=TOLERANT_FLAG in args)
    cli.main([a for a in args if a != TOLERANT_FLAG])


if __name__ == "__main__":
    main()
