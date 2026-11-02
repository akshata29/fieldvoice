"""Reference data: assets (closed world for entity resolution), knowledge-base documents, workers."""
from __future__ import annotations

from pydantic import BaseModel, Field


class Asset(BaseModel):
    """A physical asset or stock item. ``id`` is the canonical id as it would be written on a form."""

    id: str  # e.g. "123", "9921", "T4471"
    kind: str  # "pole" | "transformer" | "stock_unit" | "meter" | "feeder" | ...
    label: str  # human readable, e.g. "Pole 123"
    location: str | None = None
    attributes: dict[str, str] = Field(default_factory=dict)  # e.g. {"parent_pole": "123", "kva": "25"}


class Worker(BaseModel):
    id: str
    name: str
    role: str
    crew: str


class WorkerRecord(Worker):
    """Worker as stored in the synthetic fixture / mock system of record (never sent to clients)."""

    pin: str


class KbSection(BaseModel):
    heading: str
    text: str


class KbDoc(BaseModel):
    id: str
    title: str
    applies_to: list[str] = Field(default_factory=list)  # work types and/or asset kinds
    revision: str = "A"
    effective_date: str = "2026-01-01"
    sections: list[KbSection] = Field(default_factory=list)
