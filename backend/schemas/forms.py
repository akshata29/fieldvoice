"""Form definitions: the schema a work order's form is built from."""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class FieldType(str, Enum):
    ENUM = "enum"
    ENTITY_REF = "entity_ref"
    NUMBER = "number"
    BOOLEAN = "boolean"
    TEXT = "text"


class CodeOption(BaseModel):
    """One allowed value of an ENUM field."""

    code: str  # stable machine value, snake_case
    label: str
    synonyms: list[str] = Field(default_factory=list)  # official lexicon phrases (lowercase) for deterministic matching


class FieldSpec(BaseModel):
    key: str  # snake_case, unique within the form
    label: str
    type: FieldType
    required: bool = False
    help: str | None = None

    # ENUM
    options: list[CodeOption] = Field(default_factory=list)

    # ENTITY_REF - values are asset ids validated against the closed world of the job / inventory
    entity_kind: str | None = None  # asset kind, e.g. "pole", "transformer", "stock_unit", "meter"
    role_triggers: list[str] = Field(default_factory=list)  # words signalling this role, e.g. ["pole"]

    # NUMBER
    unit: str | None = None
    min_value: float | None = None
    max_value: float | None = None
    unit_triggers: list[str] = Field(default_factory=list)  # words after the number, e.g. ["kva"]
    label_triggers: list[str] = Field(default_factory=list)  # words before/around the number, e.g. ["rating", "size"]

    # BOOLEAN
    true_triggers: list[str] = Field(default_factory=list)  # phrases implying true, e.g. ["customer was notified"]

    # TEXT
    fill_from_transcript: bool = False
    max_length: int | None = 400

    # conditional requirement: {"work_performed": "transformer_replacement"}
    required_when: dict[str, str] | None = None


class FormSchema(BaseModel):
    id: str
    version: int = 1
    title: str
    work_type: str
    description: str | None = None
    fields: list[FieldSpec]

    def field(self, key: str) -> FieldSpec:
        for f in self.fields:
            if f.key == key:
                return f
        raise KeyError(key)

    @property
    def keys(self) -> list[str]:
        return [f.key for f in self.fields]
