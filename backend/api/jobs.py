"""In-process job manager for long-running operations (model downloads, evaluation runs, morning sync).

``submit(kind, fn)`` runs ``fn(ctx)`` on a worker thread; ``ctx`` is callable as ``ctx(progress_fraction, message)`` and
also offers ``ctx.set_result(value)`` (publish partial results while running) and ``ctx.cancelled()``.
"""
from __future__ import annotations

import logging
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel

from backend.schemas.engines import JobState, JobStatus

log = logging.getLogger(__name__)


class JobCancelled(Exception):
    pass


class JobBusy(Exception):
    """Raised by ``submit(..., exclusive=True)`` when a job of the same kind is still queued or running."""

    def __init__(self, existing: JobStatus) -> None:
        super().__init__(f"a {existing.kind} job is already running ({existing.id})")
        self.existing = existing


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _jsonable(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    return value


class JobContext:
    def __init__(self, manager: JobManager, job_id: str) -> None:
        self._m = manager
        self.job_id = job_id

    def __call__(self, fraction: float, message: str = "") -> None:
        if self.cancelled():
            raise JobCancelled()
        self._m._update(self.job_id, progress=max(0.0, min(1.0, fraction)), message=message)

    def report(self, fraction: float, message: str = "") -> None:
        """Update progress without raising on cancellation (for code that polls ``cancelled()`` itself)."""
        self._m._update(self.job_id, progress=max(0.0, min(1.0, fraction)), message=message)

    def set_result(self, value: Any) -> None:
        self._m._update(self.job_id, result=_jsonable(value))

    def cancelled(self) -> bool:
        return self._m._cancel_flags[self.job_id].is_set()


class JobManager:
    def __init__(self, workers: int = 4, keep: int = 200) -> None:
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="job")
        self._jobs: dict[str, JobStatus] = {}
        self._order: list[str] = []
        self._cancel_flags: dict[str, threading.Event] = {}
        self._lock = threading.RLock()
        self._keep = keep

    def submit(self, kind: str, fn: Callable[[JobContext], Any], *, job_id: str | None = None,
               exclusive: bool = False, initial_result: Any = None) -> JobStatus:
        jid = job_id or uuid.uuid4().hex[:12]
        job = JobStatus(id=jid, kind=kind, state=JobState.QUEUED, result=_jsonable(initial_result))
        with self._lock:
            if exclusive:
                running = self.active(kind)
                if running is not None:
                    raise JobBusy(running)
            self._jobs[jid] = job
            self._order.append(jid)
            self._cancel_flags[jid] = threading.Event()
            while len(self._order) > self._keep:
                old = self._order.pop(0)
                self._jobs.pop(old, None)
                self._cancel_flags.pop(old, None)
        self._pool.submit(self._run, jid, fn)
        return self.get(jid)

    def active(self, kind: str) -> JobStatus | None:
        with self._lock:
            for jid in reversed(self._order):
                j = self._jobs.get(jid)
                if j is not None and j.kind == kind and j.state in (JobState.QUEUED, JobState.RUNNING):
                    return j.model_copy(deep=True)
        return None

    def _run(self, jid: str, fn: Callable[[JobContext], Any]) -> None:
        ctx = JobContext(self, jid)
        if ctx.cancelled():  # cancelled while still queued
            self._update(jid, state=JobState.CANCELLED, finished_at=_now(), message="cancelled")
            return
        self._update(jid, state=JobState.RUNNING, started_at=_now())
        try:
            result = fn(ctx)
            changes: dict[str, Any] = {"state": JobState.SUCCEEDED, "progress": 1.0, "finished_at": _now()}
            if result is not None:
                changes["result"] = _jsonable(result)
            self._update(jid, **changes)
        except JobCancelled:
            self._update(jid, state=JobState.CANCELLED, finished_at=_now(), message="cancelled")
        except Exception as exc:
            log.exception("job %s failed", jid)
            self._update(jid, state=JobState.FAILED, finished_at=_now(), error=f"{type(exc).__name__}: {exc}")

    def _update(self, jid: str, **changes: Any) -> None:
        with self._lock:
            job = self._jobs.get(jid)
            if job is None:
                return
            for k, v in changes.items():
                setattr(job, k, v)

    def get(self, jid: str) -> JobStatus:
        with self._lock:
            if jid not in self._jobs:
                raise KeyError(jid)
            return self._jobs[jid].model_copy(deep=True)

    def list(self) -> list[JobStatus]:
        with self._lock:
            return [self._jobs[j].model_copy(deep=True) for j in reversed(self._order) if j in self._jobs]

    def cancel(self, jid: str) -> JobStatus:
        with self._lock:
            flag = self._cancel_flags.get(jid)
            if flag is None:
                raise KeyError(jid)
            flag.set()
            job = self._jobs[jid]
            if job.state == JobState.QUEUED:
                job.state = JobState.CANCELLED
        return self.get(jid)


job_manager = JobManager()
