"""Prompt builders and lenient JSON parsing for the LLM stages."""
from __future__ import annotations

import json
import re
from pathlib import Path

from backend.config import get_settings
from backend.core.formpack import FormPack
from backend.schemas.forms import FieldType

SYSTEM_PATCH = (
    "You fill part of a utility work-order form from a technician's spoken statement. "
    "Reply with ONE JSON object containing exactly the requested keys. "
    "Use null for anything the statement does not say. Never guess. Use only the allowed values."
)

# Variants of the patch prompt, selectable with FV_PATCH_PROMPT so they can be compared on the same data (see
# docs/RESULTS.md, "Prompt"). v0 is the first version; the others change one thing each.
SYSTEM_PATCH_CLOSEST = (
    "You read a technician's spoken statement about a utility job and fill part of a work-order form. "
    "For each requested field pick the allowed value closest in meaning to what was said, even when the technician uses "
    "everyday or slang wording. Use null only when the statement says nothing about that field. "
    "Reply with ONE JSON object containing exactly the requested keys."
)
PATCH_PROMPTS = ("v0", "v1", "v2", "v3", "v4")
# v4 asks every enum field as {"mentioned": true|false, "value": <option>}: whether the statement says anything about the
# field is a separate yes/no answer and the value is a forced choice, because a model that may answer ``null`` mostly does.
PRESENCE_PROMPTS = frozenset({"v4"})
SYSTEM_PATCH_PRESENCE = (
    "You read a technician's spoken statement about a utility job and fill part of a work-order form. "
    "For each requested field say whether the statement mentions it, even in everyday or slang words, "
    "and which allowed value is closest in meaning. Reply with ONE JSON object containing exactly the requested keys."
)

SYSTEM_BASELINE = "You are an assistant that fills out utility field work-order forms. Return only JSON."

_BASELINE_TEMPLATE = (
    "Form: {title}\n"
    "Fill in the form fields from the technician's statement. Use null when a field is not mentioned.\n"
    "Fields:\n{fields}\n"
    "Technician statement: \"{statement}\"\n"
    "Return a JSON object with exactly these keys: {keys}."
)


def _enum_line(pack: FormPack, key: str, with_synonyms: bool) -> str:
    spec = pack.form.field(key)
    opts = []
    for o in spec.options:
        extra = f" ({', '.join(o.synonyms[:2])})" if with_synonyms and o.synonyms else ""
        opts.append(f"{o.code} = {o.label}{extra}")
    return f"- {key} ({spec.label}): " + "; ".join(opts)


def build_patch_prompt(statement: str, pack: FormPack, keys: list[str], candidates: dict[str, list[str]],
                       variant: str | None = None) -> tuple[str, str]:
    variant = variant or get_settings().patch_prompt
    if variant not in PATCH_PROMPTS:
        raise ValueError(f"unknown patch prompt {variant!r}; choose one of {', '.join(PATCH_PROMPTS)}")
    if variant == "v0":
        return SYSTEM_PATCH, f'Statement: "{statement}"\nFields:\n{pack.form_spec_text(keys, candidates)}\nJSON:'
    lines = []
    for key in keys:
        spec = pack.form.field(key)
        if spec.type == FieldType.ENUM and variant in PRESENCE_PROMPTS:
            lines.append(f"- {key}: mentioned true|false; value " + " | ".join(o.code for o in spec.options))
        elif spec.type == FieldType.ENUM and variant in ("v2", "v3"):
            lines.append(_enum_line(pack, key, with_synonyms=variant == "v3"))
        else:
            lines.append(f"- {key}: {pack.field_hint(spec, candidates.get(key))}")
    system = SYSTEM_PATCH_PRESENCE if variant in PRESENCE_PROMPTS else SYSTEM_PATCH_CLOSEST
    return system, f'Statement: "{statement}"\nFields:\n' + "\n".join(lines) + "\nJSON:"


def _baseline_field_line(pack: FormPack, key: str) -> str:
    spec = pack.form.field(key)
    if spec.type == FieldType.ENUM:
        opts = ", ".join(f"{o.code} ({o.label})" for o in spec.options)
        return f"- {key} ({spec.label}): one of {opts}"
    if spec.type == FieldType.ENTITY_REF:
        return f"- {key} ({spec.label}): asset id as a string"
    if spec.type == FieldType.NUMBER:
        return f"- {key} ({spec.label}): number{' in ' + spec.unit if spec.unit else ''}"
    if spec.type == FieldType.BOOLEAN:
        return f"- {key} ({spec.label}): true or false"
    return f"- {key} ({spec.label}): short text"


def build_baseline_prompt(statement: str, pack: FormPack) -> tuple[str, str]:
    """Reconstruction of a typical full-form prompt (the customer's real prompt can be dropped in via a file)."""
    override = get_settings().data_dir / "baseline_prompt.txt"
    keys = pack.form.keys
    fields = "\n".join(_baseline_field_line(pack, k) for k in keys)
    if override.exists():
        tpl = Path(override).read_text(encoding="utf-8")
        return SYSTEM_BASELINE, tpl.format(title=pack.form.title, fields=fields, statement=statement, keys=", ".join(keys))
    return SYSTEM_BASELINE, _BASELINE_TEMPLATE.format(
        title=pack.form.title, fields=fields, statement=statement, keys=", ".join(keys))


_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S | re.I)


def parse_json_object(text: str) -> dict | None:
    """Lenient parse: strips markdown fences and surrounding prose, tolerates trailing commas."""
    if not text:
        return None
    m = _FENCE.search(text)
    if m:
        text = m.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    body = text[start:end + 1]
    for candidate in (body, re.sub(r",\s*([}\]])", r"\1", body)):
        try:
            obj = json.loads(candidate)
            return obj if isinstance(obj, dict) else None
        except json.JSONDecodeError:
            continue
    return None
