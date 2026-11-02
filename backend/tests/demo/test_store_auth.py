"""Local store (atomic approval, outbox) and authentication (online login, PIN offline unlock)."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.demo import auth
from backend.demo.connectivity import OfflineError, connectivity
from backend.demo.store import LocalStore, get_store
from backend.schemas.extraction import FieldSource, FieldStatus, FieldValue
from backend.schemas.workorders import FormDraft, OutboxState, PhotoRef
from backend.tests.demo.conftest import PIN, WORKER


def make_draft(wo: str = "WO-1", **kw) -> FormDraft:
    values = {"pole_id": FieldValue(key="pole_id", value="123", source=FieldSource.RULE, confidence=0.96,
                                    status=FieldStatus.FILLED)}
    return FormDraft(work_order_id=wo, form_id="transformer_replacement", form_version=1, base_version=1, values=values, **kw)


# ---- store ----------------------------------------------------------------------------------------------------------
def test_approve_is_atomic_and_idempotent(tmp_path: Path) -> None:
    store = LocalStore(tmp_path / "t.db")
    store.save_draft(make_draft())
    first = store.approve_draft("WO-1")
    assert first.status == "approved" and first.operation_id and first.approved_at
    outbox = store.list_outbox()
    assert [(i.kind, i.state) for i in outbox] == [("completion", OutboxState.PENDING)]
    assert outbox[0].id == first.operation_id  # the idempotency key is the completion's id
    again = store.approve_draft("WO-1")
    assert again.operation_id == first.operation_id and len(store.list_outbox()) == 1  # never a second operation


def test_approve_enqueues_photos_and_unknown_draft_fails(tmp_path: Path) -> None:
    store = LocalStore(tmp_path / "t.db")
    with pytest.raises(KeyError):
        store.approve_draft("nope")
    photo = PhotoRef(id="ph-1", filename="a.jpg", sha256="x", size_bytes=3, taken_at="2026-01-01T00:00:00Z")
    (tmp_path / "a.jpg").write_bytes(b"abc")
    store.add_photo("WO-1", photo, tmp_path / "a.jpg")
    store.save_draft(make_draft())  # the client never saw the photo: it is merged in
    assert [p.id for p in store.get_draft("WO-1").photos] == ["ph-1"]
    op = store.approve_draft("WO-1").operation_id
    assert [i.id for i in store.list_outbox()] == [op, f"{op}:ph-1"]
    assert store.get_outbox_item(f"{op}:ph-1").detail["operation_id"] == op


def test_state_survives_reopening_the_database(tmp_path: Path) -> None:
    path = tmp_path / "t.db"
    store = LocalStore(path)
    store.save_draft(make_draft())
    store.approve_draft("WO-1")
    store.close()
    reopened = LocalStore(path)
    assert reopened.get_draft("WO-1").status == "approved" and len(reopened.pending_outbox()) == 1


# ---- auth -----------------------------------------------------------------------------------------------------------
def test_online_login_stores_session_and_an_offline_grant(signed_in: TestClient) -> None:
    s = signed_in.get("/api/v1/auth/session").json()
    assert s["mode"] == "online" and s["worker"]["id"] == WORKER and "pin" not in json.dumps(s)
    grant = get_store().get_json(f"grant:{WORKER}")
    assert grant and PIN not in json.dumps(grant)  # only a salted verifier is kept
    assert grant["verifier"] and grant["salt"]


def test_wrong_pin_is_rejected_online(client: TestClient) -> None:
    r = client.post("/api/v1/auth/login", json={"worker_id": WORKER, "pin": "0000"})
    assert r.status_code == 401 and r.json()["detail"]["code"] == "invalid_credentials"
    assert client.get("/api/v1/auth/session").json() is None


def test_offline_unlock_needs_a_prior_online_login_and_the_right_pin(client: TestClient) -> None:
    connectivity.set_online(False)
    r = client.post("/api/v1/auth/login", json={"worker_id": WORKER, "pin": PIN})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "offline"  # never signed in on this device
    connectivity.set_online(True)
    assert client.post("/api/v1/auth/login", json={"worker_id": WORKER, "pin": PIN}).status_code == 200
    client.post("/api/v1/auth/logout")
    connectivity.set_online(False)
    bad = client.post("/api/v1/auth/login", json={"worker_id": WORKER, "pin": "9999"})
    assert bad.status_code == 401
    ok = client.post("/api/v1/auth/login", json={"worker_id": WORKER, "pin": PIN})
    assert ok.status_code == 200 and ok.json()["mode"] == "offline_unlock"
    other = client.post("/api/v1/auth/login", json={"worker_id": "w-1002", "pin": PIN})
    assert other.status_code == 503  # a different worker has no grant here


def test_expired_offline_grant_is_refused(signed_in: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    signed_in.post("/api/v1/auth/logout")
    connectivity.set_online(False)
    future = datetime.now(timezone.utc) + timedelta(days=5)
    monkeypatch.setattr(auth, "_now", lambda: future)
    r = signed_in.post("/api/v1/auth/login", json={"worker_id": WORKER, "pin": PIN})
    assert r.status_code == 503 and "expired" in r.json()["detail"]["message"]


def test_logout_clears_the_session_but_keeps_the_grant(signed_in: TestClient) -> None:
    assert signed_in.post("/api/v1/auth/logout").status_code == 204
    assert signed_in.get("/api/v1/auth/session").json() is None
    assert get_store().get_json(f"grant:{WORKER}") is not None


def test_login_falls_back_to_offline_unlock_when_the_system_of_record_is_down(signed_in: TestClient) -> None:
    from backend.demo.sor.service import get_sor
    from backend.schemas.api import SorFaults

    signed_in.post("/api/v1/auth/logout")
    get_sor().set_faults(SorFaults(fail_next=1))  # the device thinks it is online, but the server answers 503
    r = signed_in.post("/api/v1/auth/login", json={"worker_id": WORKER, "pin": PIN})
    assert r.status_code == 200 and r.json()["mode"] == "offline_unlock"


def test_connectivity_helper_raises() -> None:
    connectivity.set_online(False)
    try:
        with pytest.raises(OfflineError):
            connectivity.require_online()
    finally:
        connectivity.set_online(True)
