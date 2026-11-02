"""Stage timing helper that also emits progress events."""
from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from backend.schemas.extraction import StageTiming

EventFn = Callable[[dict[str, Any]], None]


class StageTimer:
    def __init__(self, on_event: EventFn | None = None) -> None:
        self.timings: list[StageTiming] = []
        self.on_event = on_event

    @contextmanager
    def stage(self, name: str) -> Iterator[dict[str, Any]]:
        detail: dict[str, Any] = {}
        t0 = time.perf_counter()
        try:
            yield detail
        finally:
            ms = (time.perf_counter() - t0) * 1000.0
            self.timings.append(StageTiming(stage=name, ms=ms, detail=dict(detail)))
            self.emit({"type": "stage", "stage": name, "ms": round(ms, 2)})

    def emit(self, event: dict[str, Any]) -> None:
        if self.on_event is not None:
            try:
                self.on_event(event)
            except Exception:  # never let a UI callback break extraction
                pass

    @property
    def total_ms(self) -> float:
        return sum(t.ms for t in self.timings)
