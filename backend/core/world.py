"""Closed world: the set of assets a job may legitimately refer to (job assets + truck inventory)."""
from __future__ import annotations

from dataclasses import dataclass, field

from backend.schemas.reference import Asset


def _dl_distance(a: str, b: str, limit: int = 2) -> int:
    """Damerau-Levenshtein (optimal string alignment) distance, early-exit above ``limit``."""
    if a == b:
        return 0
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev2: list[int] | None = None
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if prev2 is not None and i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                cur[j] = min(cur[j], prev2[j - 2] + 1)
        if min(cur) > limit:
            return limit + 1
        prev2, prev = prev, cur
    return prev[-1]


@dataclass
class ClosedWorld:
    """Assets grouped by kind with exact and near-miss lookup."""

    by_kind: dict[str, dict[str, Asset]] = field(default_factory=dict)

    @classmethod
    def from_assets(cls, assets: list[Asset]) -> ClosedWorld:
        by_kind: dict[str, dict[str, Asset]] = {}
        for a in assets:
            by_kind.setdefault(a.kind, {})[a.id.upper()] = a
        return cls(by_kind)

    @property
    def empty(self) -> bool:
        return not any(self.by_kind.values())

    def has_kind(self, kind: str | None) -> bool:
        return bool(kind) and bool(self.by_kind.get(kind or ""))

    def contains(self, kind: str | None, asset_id: str) -> bool:
        return bool(kind) and asset_id.upper() in self.by_kind.get(kind or "", {})

    def kinds_of(self, asset_id: str) -> set[str]:
        key = asset_id.upper()
        return {k for k, items in self.by_kind.items() if key in items}

    def near(self, kind: str | None, asset_id: str, k: int = 3, max_distance: int = 1) -> list[str]:
        """Closest ids of ``kind`` within ``max_distance`` edits (substitution, insertion, deletion, transposition)."""
        items = self.by_kind.get(kind or "", {})
        key = asset_id.upper()
        scored = sorted(
            ((_dl_distance(key, cand, max_distance), cand) for cand in items if cand != key),
            key=lambda t: (t[0], t[1]),
        )
        return [c for d, c in scored if d <= max_distance][:k]

    def label(self, kind: str | None, asset_id: str) -> str | None:
        a = self.by_kind.get(kind or "", {}).get(asset_id.upper())
        return a.label if a else None
