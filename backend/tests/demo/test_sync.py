"""Sync: idempotent retries, injected faults, conflicts and their resolution, photos."""
from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient

from backend.demo import sync
from backend.demo.connectivity import OfflineError, connectivity
from backend.demo.sor.service import get_sor
from backend.demo.store import get_store
from backend.schemas.api import BumpRequest, SorFaults
from backend.schemas.extraction import FieldSource, FieldStatus, FieldValue
from backend.schemas.workorders import FormDraft, OutboxState
from backend.tests.demo.conftest import HEADLINE_WO


def fv(key: str, value, status=FieldStatus.FILLED) -> FieldValue:
    return FieldValue(key=key, value=value, source=FieldSource.USER, confidence=1.0, status=status)


def complete_form(client: TestClient, wo: str = HEADLINE_WO) -> dict:
    """Save a valid draft and approve it (works offline)."""
    detail = client.get(f"/api/v1/workorders/{wo}").json()
    draft = FormDraft(work_order_id=wo, form_id=detail["form"]["id"], form_version=1,
                      base_version=detail["work_order"]["version"],
                      values={"work_performed": fv("work_performed", "transformer_replacement"),
                              "pole_id": fv("pole_id", "123"), "replacement_unit": fv("replacement_unit", "456"),
                              "condition_found": fv("condition_found", "oil_leak")},
                      transcript="I replaced the transformer at pole 123 ...", stt_engine_id="oracle:stt:transcript")
    assert client.put(f"/api/v1/workorders/{wo}/draft", json=draft.model_dump(mode="json")).status_code == 200
    r = client.post(f"/api/v1/workorders/{wo}/approve")
    assert r.status_code == 200, r.text
    return r.json()


def sor_completions() -> list[dict]:
    return get_sor().state().completions


def test_offline_approve_then_online_sync_applies_exactly_once(with_bundle: TestClient) -> None:
    connectivity.set_online(False)
    approved = complete_form(with_bundle)
    assert approved["status"] == "approved" and approved["operation_id"]
    outbox = with_bundle.get("/api/v1/sync/outbox").json()
    assert [(i["kind"], i["state"]) for i in outbox] == [("completion", "pending")]
    r = with_bundle.post("/api/v1/sync/run")
    assert r.status_code == 503 and r.json()["detail"]["code"] == "offline"
    assert sor_completions() == []  # nothing reached the system of record while offline

    connectivity.set_online(True)
    summary = with_bundle.post("/api/v1/sync/run").json()
    assert (summary["attempted"], summary["synced"], summary["failed"], summary["conflicts"]) == (1, 1, 0, 0)
    [done] = sor_completions()
    assert done["work_order_id"] == HEADLINE_WO and done["values"]["pole_id"] == "123"
    assert done["operation_id"] == approved["operation_id"]
    assert get_store().get_draft(HEADLINE_WO).status == "synced"
    again = with_bundle.post("/api/v1/sync/run").json()
    assert again["attempted"] == 0 and len(sor_completions()) == 1


def test_a_lost_response_is_retried_without_a_duplicate(with_bundle: TestClient) -> None:
    complete_form(with_bundle)
    get_sor().set_faults(SorFaults(drop_response_next=1))  # committed, but the device sees a 504
    first = with_bundle.post("/api/v1/sync/run").json()
    assert first["failed"] == 1 and first["items"][0]["state"] == "failed"
    assert "No response" in first["items"][0]["last_error"]
    assert len(sor_completions()) == 1  # the server did commit
    second = with_bundle.post("/api/v1/sync/run").json()
    assert second["synced"] == 1 and second["items"][0]["detail"]["server_status"] == "duplicate"
    assert len(sor_completions()) == 1  # idempotency key: still exactly one record
    assert second["items"][0]["attempts"] == 2


def test_transient_failures_are_retried_until_they_succeed(with_bundle: TestClient) -> None:
    complete_form(with_bundle)
    get_sor().set_faults(SorFaults(fail_next=2))
    one = with_bundle.post("/api/v1/sync/run").json()
    two = with_bundle.post("/api/v1/sync/run").json()
    assert one["failed"] == 1 and two["failed"] == 1 and sor_completions() == []
    three = with_bundle.post("/api/v1/sync/run").json()
    assert three["synced"] == 1 and three["items"][0]["attempts"] == 3 and len(sor_completions()) == 1


def test_dispatch_change_while_offline_becomes_a_conflict_not_an_overwrite(with_bundle: TestClient) -> None:
    connectivity.set_online(False)
    complete_form(with_bundle)
    get_sor().bump(HEADLINE_WO, BumpRequest(note="customer moved the appointment"))  # dispatcher edits the job meanwhile
    connectivity.set_online(True)
    summary = with_bundle.post("/api/v1/sync/run").json()
    assert summary["conflicts"] == 1 and sor_completions() == []
    [item] = [i for i in with_bundle.get("/api/v1/sync/outbox").json() if i["kind"] == "completion"]
    assert item["state"] == "conflict" and item["server_version"] == 2 and item["base_version"] == 1
    assert get_store().get_draft(HEADLINE_WO).status == "conflict"

    resolved = with_bundle.post("/api/v1/sync/resolve", json={"item_id": item["id"], "action": "keep_mine"}).json()
    assert resolved["state"] == "pending" and resolved["base_version"] == 2
    assert with_bundle.post("/api/v1/sync/run").json()["synced"] == 1
    [done] = sor_completions()
    assert done["base_version"] == 2 and done["operation_id"] == item["id"]  # same operation, rebased


def test_take_theirs_discards_the_local_result_and_refreshes_the_work_order(with_bundle: TestClient) -> None:
    complete_form(with_bundle)
    get_sor().bump(HEADLINE_WO, BumpRequest(title="Replace transformer - REVISED"))
    with_bundle.post("/api/v1/sync/run")
    [item] = with_bundle.get("/api/v1/sync/outbox").json()
    r = with_bundle.post("/api/v1/sync/resolve", json={"item_id": item["id"], "action": "take_theirs"})
    assert r.status_code == 200 and r.json()["state"] == "synced" and r.json()["detail"]["resolution"] == "discarded_local"
    assert sor_completions() == []
    wo = with_bundle.get(f"/api/v1/workorders/{HEADLINE_WO}").json()["work_order"]
    assert wo["version"] == 2 and "REVISED" in wo["title"]  # picked up the dispatcher's version


def test_resolving_something_that_is_not_a_conflict_is_refused(with_bundle: TestClient) -> None:
    complete_form(with_bundle)
    [item] = with_bundle.get("/api/v1/sync/outbox").json()
    assert with_bundle.post("/api/v1/sync/resolve", json={"item_id": item["id"], "action": "keep_mine"}).status_code == 409
    assert with_bundle.post("/api/v1/sync/resolve", json={"item_id": "nope", "action": "keep_mine"}).status_code == 404


def test_an_injected_conflict_bumps_the_job(with_bundle: TestClient) -> None:
    complete_form(with_bundle)
    get_sor().set_faults(SorFaults(conflict_next=1))
    assert with_bundle.post("/api/v1/sync/run").json()["conflicts"] == 1
    assert get_sor().state().work_orders[0].version >= 1


def test_photos_are_stored_attached_and_uploaded(with_bundle: TestClient) -> None:
    files = {"file": ("leak.jpg", io.BytesIO(b"\xff\xd8\xff fake jpeg bytes"), "image/jpeg")}
    photo = with_bundle.post(f"/api/v1/workorders/{HEADLINE_WO}/photos", files=files).json()
    assert photo["id"].startswith("ph-") and photo["size_bytes"] > 0 and len(photo["sha256"]) == 64
    got = with_bundle.get(f"/api/v1/photos/{photo['id']}")
    assert got.status_code == 200 and got.content.startswith(b"\xff\xd8\xff") and got.headers["content-type"] == "image/jpeg"
    assert with_bundle.post(f"/api/v1/workorders/{HEADLINE_WO}/photos",
                            files={"file": ("x.txt", io.BytesIO(b"hi"), "text/plain")}).status_code == 415
    complete_form(with_bundle)  # the draft already holds the photo, a client PUT that omits it must not drop it
    outbox = with_bundle.get("/api/v1/sync/outbox").json()
    assert [i["kind"] for i in outbox] == ["completion", "photo"]
    summary = with_bundle.post("/api/v1/sync/run").json()
    assert summary["synced"] == 2 and get_sor().state().photos == 1
    assert sor_completions()[0]["photo_ids"] == [photo["id"]]
    late = with_bundle.post(f"/api/v1/workorders/{HEADLINE_WO}/photos",
                            files={"file": ("l.jpg", io.BytesIO(b"x"), "image/jpeg")})
    assert late.status_code == 409  # the form is already submitted


def test_expired_session_during_sync_asks_to_sign_in_again(with_bundle: TestClient) -> None:
    complete_form(with_bundle)
    get_sor()._tokens.clear()  # the server forgot the session
    r = with_bundle.post("/api/v1/sync/run")
    assert r.status_code == 401 and r.json()["detail"]["code"] == "session_expired"
    assert get_store().list_outbox()[0].state in (OutboxState.FAILED, OutboxState.PENDING)


def test_sync_requires_a_connection_and_a_session(client: TestClient) -> None:
    assert client.post("/api/v1/sync/run").status_code == 401
    with pytest.raises(sync.AuthError):
        sync.run_sync()
    connectivity.set_online(False)
    with pytest.raises(OfflineError):
        sync.run_sync()
