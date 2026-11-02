"""Engine registry: discovers STT/LLM engines, tracks what is loaded, enforces a small resident-model budget."""
from __future__ import annotations

import logging
import threading
from collections.abc import Callable

from backend.config import get_settings
from backend.engines.azure_engines import AzureCloudStt, AzureEmbeddedStt
from backend.engines.base import EngineError, LlmEngine, ProgressFn, SttEngine
from backend.engines.foundry_engines import FoundryLlmEngine, FoundrySttEngine
from backend.engines.foundry_runtime import CHAT_TASKS, STT_TASK, get_runtime
from backend.engines.simple import NoLlm, OracleStt
from backend.schemas.api import EngineList
from backend.schemas.engines import NO_LLM_ID, ORACLE_STT_ID, EngineInfo

log = logging.getLogger(__name__)
_PERMANENT = {ORACLE_STT_ID, NO_LLM_ID}


class EngineRegistry:
    def __init__(self, *, foundry: bool = True, azure: bool = True) -> None:
        self._use_foundry = foundry
        self._use_azure = azure
        self._lock = threading.RLock()
        self._built = False
        self._stt: dict[str, SttEngine] = {}
        self._llm: dict[str, LlmEngine] = {}
        self._loaded_order: list[str] = []
        self.foundry_error: str | None = None

    # ---- discovery -------------------------------------------------------------------------------------------
    def register_stt(self, engine_id: str, engine: SttEngine) -> None:
        self._stt[engine_id] = engine

    def register_llm(self, engine_id: str, engine: LlmEngine) -> None:
        self._llm[engine_id] = engine

    def _build(self) -> None:
        with self._lock:
            if self._built:
                return
            self._stt[ORACLE_STT_ID] = OracleStt()
            self._llm[NO_LLM_ID] = NoLlm()
            if self._use_azure:
                emb, cloud = AzureEmbeddedStt(), AzureCloudStt()
                self._stt[emb.ENGINE_ID] = emb
                self._stt[cloud.ENGINE_ID] = cloud
            if self._use_foundry:
                rt = get_runtime()
                try:
                    for spec in rt.specs():
                        if spec.task == STT_TASK:
                            e = FoundrySttEngine(spec, rt)
                            self._stt[f"foundry:stt:{spec.alias}:{spec.device}"] = e
                        elif spec.task in CHAT_TASKS:
                            e2 = FoundryLlmEngine(spec, rt)
                            self._llm[f"foundry:llm:{spec.alias}:{spec.device}"] = e2
                except EngineError as exc:
                    self.foundry_error = str(exc)
                    log.warning("Foundry engines unavailable: %s", exc)
            self._built = True

    def rebuild(self) -> None:
        with self._lock:
            self._built = False
            self._stt.clear()
            self._llm.clear()
            self._build()

    # ---- queries ---------------------------------------------------------------------------------------------
    def stt_infos(self) -> list[EngineInfo]:
        self._build()
        return sorted((e.info() for e in self._stt.values()), key=_sort_key)

    def llm_infos(self) -> list[EngineInfo]:
        self._build()
        return sorted((e.info() for e in self._llm.values()), key=_sort_key)

    def list_engines(self) -> EngineList:
        from backend.core.strategies import STRATEGIES

        return EngineList(stt=self.stt_infos(), llm=self.llm_infos(), strategies=STRATEGIES)

    def info(self, engine_id: str) -> EngineInfo:
        self._build()
        e = self._stt.get(engine_id) or self._llm.get(engine_id)
        if e is None:
            raise KeyError(engine_id)
        return e.info()

    def get_stt(self, engine_id: str) -> SttEngine:
        self._build()
        try:
            return self._stt[engine_id]
        except KeyError:
            raise KeyError(f"unknown STT engine {engine_id!r}") from None

    def get_llm(self, engine_id: str) -> LlmEngine:
        self._build()
        try:
            return self._llm[engine_id]
        except KeyError:
            raise KeyError(f"unknown LLM engine {engine_id!r}") from None

    # ---- lifecycle -------------------------------------------------------------------------------------------
    def prepare(self, engine_id: str, progress: ProgressFn | None = None) -> float:
        """Download + load an engine, evicting the least recently used resident model if over budget."""
        self._build()
        engine: SttEngine | LlmEngine = self._stt.get(engine_id) or self._llm[engine_id]
        if engine_id not in _PERMANENT:
            self._evict_for(engine_id)
        load_ms = engine.ensure_ready(progress)
        self._touch(engine_id)
        return load_ms

    def unload(self, engine_id: str) -> None:
        self._build()
        engine = self._stt.get(engine_id) or self._llm.get(engine_id)
        if engine is not None:
            engine.unload()
        with self._lock:
            if engine_id in self._loaded_order:
                self._loaded_order.remove(engine_id)

    def unload_all(self) -> None:
        for engine_id in list(self._loaded_order):
            self.unload(engine_id)

    def _touch(self, engine_id: str) -> None:
        if engine_id in _PERMANENT:
            return
        with self._lock:
            if engine_id in self._loaded_order:
                self._loaded_order.remove(engine_id)
            self._loaded_order.append(engine_id)

    def _evict_for(self, engine_id: str) -> None:
        budget = max(1, get_settings().max_loaded_models)
        with self._lock:
            others = [i for i in self._loaded_order if i != engine_id]
            while len(others) >= budget:
                victim = others.pop(0)
                log.info("evicting %s to stay within %d resident models", victim, budget)
                self.unload(victim)

    def loaded_ids(self) -> list[str]:
        return list(self._loaded_order)


def _sort_key(info: EngineInfo) -> tuple:
    order = {"oracle": 0, "rules": 0, "foundry": 1, "azure-embedded": 2, "azure-cloud": 3}
    return (order.get(info.provider, 9), info.size_mb or 0.0, info.name)


_registry: EngineRegistry | None = None
_registry_lock = threading.Lock()


def get_registry() -> EngineRegistry:
    global _registry
    with _registry_lock:
        if _registry is None:
            _registry = EngineRegistry()
        return _registry


def set_registry(registry: EngineRegistry | None) -> None:
    """Swap the process-wide registry (tests)."""
    global _registry
    with _registry_lock:
        _registry = registry


GetEngine = Callable[[str], object]
