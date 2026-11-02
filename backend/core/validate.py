"""Validation: type/range checks, closed-world membership, required fields."""
from __future__ import annotations

from backend.core.world import ClosedWorld
from backend.schemas.extraction import FieldStatus, FieldValue
from backend.schemas.forms import FieldType, FormSchema


def validate(fields: dict[str, FieldValue], form: FormSchema, world: ClosedWorld) -> list[str]:
    """Downgrade doubtful values to NEEDS_REVIEW and return human-readable warnings (never invents values)."""
    warnings: list[str] = []
    for spec in form.fields:
        fv = fields.get(spec.key)
        if fv is None or fv.value is None:
            continue
        if spec.type == FieldType.ENUM and fv.value not in {o.code for o in spec.options}:
            fields[spec.key] = FieldValue(key=spec.key, note=f"dropped invalid value {fv.value!r}")
            warnings.append(f"{spec.label}: invalid value dropped")
        elif spec.type == FieldType.ENTITY_REF and world.has_kind(spec.entity_kind):
            if not world.contains(spec.entity_kind, str(fv.value)) and fv.status == FieldStatus.FILLED:
                fv.status = FieldStatus.NEEDS_REVIEW
                fv.confidence = min(fv.confidence, 0.5)
                fv.note = "not in today's assets"
                fv.candidates = fv.candidates or world.near(spec.entity_kind, str(fv.value))
        elif spec.type == FieldType.NUMBER and isinstance(fv.value, (int, float)):
            lo, hi = spec.min_value, spec.max_value
            if (lo is not None and fv.value < lo) or (hi is not None and fv.value > hi):
                fv.status = FieldStatus.NEEDS_REVIEW
                fv.confidence = min(fv.confidence, 0.5)
                fv.note = f"outside expected range {lo}-{hi}"

    for spec in form.fields:
        required = spec.required
        if spec.required_when:
            required = all(
                getattr(fields.get(k), "value", None) == v for k, v in spec.required_when.items()
            )
        fv = fields.get(spec.key)
        if required and (fv is None or fv.value is None):
            warnings.append(f"Required field missing: {spec.label}")
    return warnings
