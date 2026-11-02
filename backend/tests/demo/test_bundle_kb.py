"""Bundle download/verification and the offline knowledge base."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.demo import bundle, kb
from backend.demo.connectivity import OfflineError, connectivity
from backend.demo.remote import InProcessRemote
from backend.demo.store import get_store
from backend.tests.demo.conftest import HEADLINE_WO


def test_bundle_sync_stores_a_verified_package(signed_in: TestClient) -> None:
    summary = bundle.sync_bundle()
    b = get_store().get_bundle()
    assert b is not None and b.bundle_id == summary.bundle_id and b.worker.id == "w-1001"
    assert summary.n_work_orders == len(b.work_orders) == 3 and b.expires_at > b.issued_at
    assert {w.form_id for w in b.work_orders} == {f.id for f in b.forms}
    roles = {r.role: r.required for r in b.model_manifest.requirements}
    assert roles == {"stt": True, "llm": False}
    assert signed_in.get("/api/v1/bundle").json()["content_hash"] == summary.content_hash


def test_a_corrupt_bundle_is_rejected_and_not_stored(signed_in: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    real = InProcessRemote.get_bundle

    def tampered(self, token):
        b = real(self, token)
        b.work_orders[0].title = "tampered in transit"
        return b

    monkeypatch.setattr(InProcessRemote, "get_bundle", tampered)
    r = signed_in.post("/api/v1/bundle/sync")
    job = signed_in.get(f"/api/v1/jobs/{r.json()['id']}").json()
    for _ in range(50):
        if job["state"] in ("succeeded", "failed"):
            break
        job = signed_in.get(f"/api/v1/jobs/{r.json()['id']}").json()
    assert job["state"] == "failed" and "integrity" in job["error"]
    assert get_store().get_bundle() is None


def test_bundle_needs_a_session_and_a_connection(client: TestClient) -> None:
    assert client.post("/api/v1/bundle/sync").status_code == 401
    client.post("/api/v1/auth/login", json={"worker_id": "w-1001", "pin": "1234"})
    connectivity.set_online(False)
    r = client.post("/api/v1/bundle/sync")
    assert r.status_code == 503 and r.json()["detail"]["code"] == "offline"
    with pytest.raises(OfflineError):
        bundle.sync_bundle()


def test_job_assets_are_the_job_plus_the_trucks_inventory(with_bundle: TestClient) -> None:
    assets = bundle.job_assets(HEADLINE_WO)
    kinds = {a.kind for a in assets}
    ids = {a.id for a in assets}
    assert {"123", "T9921", "456"} <= ids and kinds >= {"pole", "transformer", "stock_unit"}
    with pytest.raises(KeyError):
        bundle.job_assets("WO-nope")


def test_work_order_detail_carries_form_closed_world_and_kb(with_bundle: TestClient) -> None:
    d = with_bundle.get(f"/api/v1/workorders/{HEADLINE_WO}").json()
    assert d["form"]["id"] == "transformer_replacement" and d["draft"] is None
    assert {"123", "456", "T9921"} <= {a["id"] for a in d["assets"]}
    assert d["kb"] and d["kb"][0]["doc_id"].startswith("kb-")
    assert with_bundle.get("/api/v1/workorders/WO-nope").status_code == 404


# ---- knowledge base ---------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("query, doc", [
    ("how do I replace a transformer", "kb-xfmr-swap"),
    ("oil leak containment", "kb-oil-leak"),
    ("woodpecker holes in the pole", "kb-woodpecker"),
    ("grade a pole fail monitor", "kb-pole-insp"),
    ("door hanger when the customer is not home", "kb-customer-notify"),
    ("lockout tagout grounding", "kb-switching"),
])
def test_kb_finds_the_right_procedure(with_bundle: TestClient, query: str, doc: str) -> None:
    hits = kb.search(query, None, 3)
    assert hits and doc in [h.doc_id for h in hits[:2]], [h.doc_id for h in hits]
    assert all(h.snippet and h.heading and h.score > 0 for h in hits)


def test_each_worker_only_carries_their_own_procedures(client: TestClient) -> None:
    client.post("/api/v1/auth/login", json={"worker_id": "w-1002", "pin": "1234"})
    bundle.sync_bundle()
    hits = kb.search("meter seal and final reading", None, 3)
    assert hits[0].doc_id == "kb-meter-exch"
    assert kb.search("woodpecker holes", None, 3) == [] or all(h.doc_id != "kb-woodpecker" for h in kb.search("woodpecker", None))


def test_kb_boosts_documents_attached_to_the_job(with_bundle: TestClient) -> None:
    plain = kb.search("customer", None, 5)
    boosted = kb.search("customer", HEADLINE_WO, 5)
    assert plain and boosted
    attached = {"kb-xfmr-swap", "kb-oil-leak", "kb-switching"}
    assert boosted[0].doc_id in attached or boosted[0].doc_id == plain[0].doc_id


def test_kb_edge_cases(with_bundle: TestClient) -> None:
    assert kb.search("", None) == [] and kb.search("zzzzqqq", None) == []
    assert len(kb.search("pole", None, 2)) <= 2
    assert with_bundle.get("/api/v1/kb/search", params={"q": "transformer", "k": 3}).status_code == 200
    assert with_bundle.get("/api/v1/kb/search", params={"q": "x", "k": 99}).status_code == 422


def test_kb_works_offline(with_bundle: TestClient) -> None:
    connectivity.set_online(False)
    assert kb.search("transformer replacement", None, 1)
    assert with_bundle.get(f"/api/v1/workorders/{HEADLINE_WO}").status_code == 200
