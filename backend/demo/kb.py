"""Offline knowledge-base search over the bundle's procedures: BM25 on sections, boosted for the job at hand.

Pure Python, no model and no network, so "find the transformer swap procedure" works in a substation with no signal.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass, field

from backend.core.normalize import STOPWORDS, stem
from backend.demo.store import get_store
from backend.schemas.api import KbHit
from backend.schemas.reference import KbDoc

_WORD = re.compile(r"[a-z0-9]+")
K1, B = 1.4, 0.75


def tokenize(text: str) -> list[str]:
    return [stem(w) for w in _WORD.findall(text.lower()) if w not in STOPWORDS and len(w) > 1]


@dataclass
class _Chunk:
    doc: KbDoc
    heading: str
    text: str
    tf: Counter
    length: int


@dataclass
class KbIndex:
    docs: list[KbDoc]
    chunks: list[_Chunk] = field(default_factory=list)
    df: Counter = field(default_factory=Counter)
    avg_len: float = 1.0

    def __post_init__(self) -> None:
        for doc in self.docs:
            for sec in doc.sections:
                # words in the title and heading count double: they say what the section is about
                toks = tokenize(sec.text) + 2 * tokenize(doc.title) + 2 * tokenize(sec.heading)
                self.chunks.append(_Chunk(doc, sec.heading, sec.text, Counter(toks), len(toks)))
        for c in self.chunks:
            self.df.update(c.tf.keys())
        self.avg_len = sum(c.length for c in self.chunks) / max(1, len(self.chunks))

    def search(self, query: str, k: int = 5, boost: dict[str, float] | None = None) -> list[KbHit]:
        q = tokenize(query)
        if not q or not self.chunks:
            return []
        n = len(self.chunks)
        best: dict[str, tuple[float, _Chunk]] = {}
        for c in self.chunks:
            score = 0.0
            for term in set(q):
                f = c.tf.get(term, 0)
                if not f:
                    continue
                idf = math.log(1 + (n - self.df[term] + 0.5) / (self.df[term] + 0.5))
                score += idf * f * (K1 + 1) / (f + K1 * (1 - B + B * c.length / self.avg_len))
            if score <= 0:
                continue
            score *= (boost or {}).get(c.doc.id, 1.0)
            if score > best.get(c.doc.id, (0.0, c))[0]:
                best[c.doc.id] = (score, c)
        ranked = sorted(best.values(), key=lambda t: -t[0])[:k]
        return [KbHit(doc_id=c.doc.id, title=c.doc.title, heading=c.heading, snippet=_snippet(c.text, set(q)),
                      score=round(s, 3), revision=c.doc.revision) for s, c in ranked]


def _snippet(text: str, terms: set[str], width: int = 240) -> str:
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    best = max(sentences, key=lambda s: len(terms & set(tokenize(s))))
    return best if len(best) <= width else best[: width - 1].rstrip() + "\u2026"


_cache: tuple[str, KbIndex] | None = None


def _index() -> KbIndex | None:
    global _cache
    bundle = get_store().get_bundle()
    if bundle is None or not bundle.kb_docs:
        return None
    if _cache is None or _cache[0] != bundle.content_hash:
        _cache = (bundle.content_hash, KbIndex(bundle.kb_docs))
    return _cache[1]


def search(q: str, work_order_id: str | None = None, k: int = 5) -> list[KbHit]:
    """Top ``k`` procedures for ``q``. With a work order, documents attached to the job (and those that apply to its work
    type or asset kinds) rank higher."""
    index = _index()
    if index is None:
        return []
    boost: dict[str, float] = {}
    bundle = get_store().get_bundle()
    wo = next((w for w in bundle.work_orders if w.id == work_order_id), None) if bundle and work_order_id else None
    if wo is not None and bundle is not None:
        kinds = {a.kind for a in bundle.assets if a.id in set(wo.asset_ids)}
        for doc in index.docs:
            factor = 1.0
            if doc.id in wo.kb_doc_ids:
                factor *= 1.5
            if wo.form_id in doc.applies_to or kinds & set(doc.applies_to):
                factor *= 1.2
            boost[doc.id] = factor
    return index.search(q, k, boost)
