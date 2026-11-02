"""Local device store (SQLite): the bundle, the worker session, drafts, photos and the sync outbox.

Everything the worker needs during the disconnected day lives here. One connection guarded by a lock (the API is
threaded); WAL mode so a crash never loses an approved form. NOTE: the file is not encrypted - a production build must
use an encrypted store (SQLCipher / platform data protection) and keep secrets in the OS keystore.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.config import get_settings
from backend.demo.connectivity import now_iso
from backend.schemas.workorders import AuthSession, Bundle, FormDraft, OutboxItem, OutboxState, PhotoRef

log = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS drafts (work_order_id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, work_order_id TEXT NOT NULL, body TEXT NOT NULL, path TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, work_order_id TEXT NOT NULL,
  state TEXT NOT NULL, body TEXT NOT NULL);
"""


class LocalStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._db.executescript(_SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._db.close()

    @contextmanager
    def _tx(self):
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                yield self._db
            except BaseException:
                self._db.execute("ROLLBACK")
                raise
            else:
                self._db.execute("COMMIT")

    # ---- key/value -------------------------------------------------------------------------------------------
    def _get_kv(self, key: str) -> str | None:
        with self._lock:
            row = self._db.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None

    def _set_kv(self, key: str, value: str) -> None:
        with self._lock:
            self._db.execute("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                             (key, value))

    def get_json(self, key: str) -> dict | None:
        raw = self._get_kv(key)
        return json.loads(raw) if raw else None

    def set_json(self, key: str, value: dict) -> None:
        self._set_kv(key, json.dumps(value))

    def delete_key(self, key: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM kv WHERE key=?", (key,))

    def list_json(self, prefix: str) -> list[dict]:
        with self._lock:
            rows = self._db.execute("SELECT value FROM kv WHERE key LIKE ? ESCAPE '\\'",
                                    (prefix.replace("%", "\\%").replace("_", "\\_") + "%",)).fetchall()
        return [json.loads(r["value"]) for r in rows]

    # ---- bundle / session ------------------------------------------------------------------------------------
    def get_bundle(self) -> Bundle | None:
        raw = self._get_kv("bundle")
        return Bundle.model_validate_json(raw) if raw else None

    def save_bundle(self, bundle: Bundle) -> None:
        self._set_kv("bundle", bundle.model_dump_json())

    def get_session(self) -> AuthSession | None:
        raw = self._get_kv("session")
        return AuthSession.model_validate_json(raw) if raw else None

    def save_session(self, session: AuthSession) -> None:
        self._set_kv("session", session.model_dump_json())

    def clear_session(self) -> None:
        self.delete_key("session")

    # ---- photos ----------------------------------------------------------------------------------------------
    def add_photo(self, work_order_id: str, photo: PhotoRef, path: Path) -> None:
        with self._lock:
            self._db.execute("INSERT OR REPLACE INTO photos(id, work_order_id, body, path) VALUES(?,?,?,?)",
                             (photo.id, work_order_id, photo.model_dump_json(), str(path)))

    def get_photo(self, photo_id: str) -> tuple[PhotoRef, Path] | None:
        with self._lock:
            row = self._db.execute("SELECT body, path FROM photos WHERE id=?", (photo_id,)).fetchone()
        return (PhotoRef.model_validate_json(row["body"]), Path(row["path"])) if row else None

    def list_photos(self, work_order_id: str) -> list[PhotoRef]:
        with self._lock:
            rows = self._db.execute("SELECT body FROM photos WHERE work_order_id=? ORDER BY rowid", (work_order_id,)).fetchall()
        return [PhotoRef.model_validate_json(r["body"]) for r in rows]

    # ---- drafts ----------------------------------------------------------------------------------------------
    def get_draft(self, work_order_id: str) -> FormDraft | None:
        with self._lock:
            row = self._db.execute("SELECT body FROM drafts WHERE work_order_id=?", (work_order_id,)).fetchone()
        return FormDraft.model_validate_json(row["body"]) if row else None

    def list_drafts(self) -> list[FormDraft]:
        with self._lock:
            rows = self._db.execute("SELECT body FROM drafts").fetchall()
        return [FormDraft.model_validate_json(r["body"]) for r in rows]

    def _write_draft(self, db: sqlite3.Connection, draft: FormDraft) -> None:
        db.execute("INSERT INTO drafts(work_order_id, body, status, updated_at) VALUES(?,?,?,?) "
                   "ON CONFLICT(work_order_id) DO UPDATE SET body=excluded.body, status=excluded.status, updated_at=excluded.updated_at",
                   (draft.work_order_id, draft.model_dump_json(), draft.status, draft.updated_at))

    def save_draft(self, draft: FormDraft) -> None:
        """Autosave. Photos already stored for the work order are merged in so a client that never saw them cannot drop them."""
        with self._tx() as db:
            known = {p.id for p in draft.photos}
            draft.photos = [*draft.photos, *[p for p in self.list_photos(draft.work_order_id) if p.id not in known]]
            self._write_draft(db, draft)

    def approve_draft(self, work_order_id: str) -> FormDraft:
        """Atomic: mark the draft approved, assign its idempotency key and enqueue the outbox rows (completion + photos).
        Calling it again on an approved/synced draft returns the same draft (never a second operation)."""
        with self._tx() as db:
            draft = self.get_draft(work_order_id)
            if draft is None:
                raise KeyError(work_order_id)
            if draft.status in ("approved", "synced", "conflict") and draft.operation_id:
                return draft
            now = now_iso()
            op = uuid.uuid4().hex
            draft.photos = [*draft.photos, *[p for p in self.list_photos(work_order_id) if p.id not in {x.id for x in draft.photos}]]
            draft.status, draft.operation_id, draft.approved_at, draft.updated_at = "approved", op, now, now
            self._write_draft(db, draft)
            self._insert_outbox(db, OutboxItem(
                id=op, kind="completion", work_order_id=work_order_id, created_at=now, updated_at=now,
                base_version=draft.base_version, detail={"form_id": draft.form_id, "n_photos": len(draft.photos)}))
            for photo in draft.photos:
                self._insert_outbox(db, OutboxItem(
                    id=f"{op}:{photo.id}", kind="photo", work_order_id=work_order_id, created_at=now, updated_at=now,
                    base_version=draft.base_version, detail={"photo_id": photo.id, "operation_id": op}))
            return draft

    # ---- outbox ----------------------------------------------------------------------------------------------
    @staticmethod
    def _insert_outbox(db: sqlite3.Connection, item: OutboxItem) -> None:
        db.execute("INSERT INTO outbox(id, kind, work_order_id, state, body) VALUES(?,?,?,?,?)",
                   (item.id, item.kind, item.work_order_id, item.state.value, item.model_dump_json()))

    def list_outbox(self) -> list[OutboxItem]:
        with self._lock:
            rows = self._db.execute("SELECT body FROM outbox ORDER BY seq").fetchall()
        return [OutboxItem.model_validate_json(r["body"]) for r in rows]

    def get_outbox_item(self, item_id: str) -> OutboxItem | None:
        with self._lock:
            row = self._db.execute("SELECT body FROM outbox WHERE id=?", (item_id,)).fetchone()
        return OutboxItem.model_validate_json(row["body"]) if row else None

    def update_outbox(self, item: OutboxItem) -> None:
        item.updated_at = now_iso()
        with self._lock:
            self._db.execute("UPDATE outbox SET state=?, body=? WHERE id=?", (item.state.value, item.model_dump_json(), item.id))

    def pending_outbox(self) -> list[OutboxItem]:
        retry = {OutboxState.PENDING, OutboxState.FAILED, OutboxState.SENDING}
        return [i for i in self.list_outbox() if i.state in retry]


_store: LocalStore | None = None
_store_lock = threading.Lock()


def get_store() -> LocalStore:
    """Process-wide store at ``<data>/demo/app.db`` (re-opened if the data directory setting changes, e.g. in tests)."""
    global _store
    path = get_settings().demo_dir / "app.db"
    with _store_lock:
        if _store is None or _store.path != path:
            if _store is not None:
                _store.close()
            _store = LocalStore(path)
        return _store


def reset_store() -> None:
    global _store
    with _store_lock:
        if _store is not None:
            _store.close()
        _store = None
