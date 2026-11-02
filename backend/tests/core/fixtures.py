"""Shared fixtures for core tests (independent of the synthetic data package)."""
from __future__ import annotations

from backend.core.golden import golden_assets, golden_form
from backend.schemas.forms import FormSchema
from backend.schemas.reference import Asset


def transformer_form() -> FormSchema:
    return golden_form()


def world_assets() -> list[Asset]:
    return golden_assets()
