"""The whole day through the public API: morning prep -> offline work -> back online. Also the SoR over HTTP."""
from __future__ import annotations

import time

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.demo.connectivity import connectivity
from backend.demo.sor.app import app as sor_app
from backend.demo.sor.service import get_sor
from backend.tests.demo.conftest import HEADLINE_WO, PIN, WORKER
from backend.tests.demo.test_sync import complete_form


def wait_job(client: TestClient, job_id: str, timeout: float = 30.0) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = client.get(f"/api/v1/jobs/{job_id}").json()
        if j["state"] in ("succeeded", "failed", "cancelled"):
            return j
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_morning_prep_makes_the_device_ready_to_go_offline(signed_in: TestClient) -> None:
    r = signed_in.post("/api/v1/morning/start")
    assert r.status_code == 202
    job = wait_job(signed_in, r.json()["id"])
    assert job["state"] == "succeeded", job
    res = job["result"]
    steps = {s["id"]: s for s in res["steps"]}
    assert [s["status"] for s in res["steps"]] == ["pass"] * 5, res["steps"]
    assert "3 work orders" in steps["download_bundle"]["detail"]
    assert "whisper" in steps["ensure_models"]["detail"]
    assert res["ready_to_go_offline"] is True and res["readiness"]["overall"] in ("pass", "warn")
    assert signed_in.get("/api/v1/readiness").json()["checks"]
    assert signed_in.get("/api/v1/system/status").json()["bundle"]["n_work_orders"] == 3


def test_morning_prep_while_offline_keeps_the_existing_package(signed_in: TestClient) -> None:
    online = wait_job(signed_in, signed_in.post("/api/v1/morning/start").json()["id"])
    assert online["result"]["ready_to_go_offline"] is True  # package + models are now on the device
    connectivity.set_online(False)
    job = wait_job(signed_in, signed_in.post("/api/v1/morning/start").json()["id"])
    steps = {s["id"]: s for s in job["result"]["steps"]}
    assert steps["download_bundle"]["status"] == "warn" and "offline" in steps["download_bundle"]["detail"]
    assert steps["ensure_models"]["status"] == "pass"
    assert job["result"]["ready_to_go_offline"] is True  # what is already on the device is enough


def test_morning_prep_offline_with_a_package_but_no_models_is_not_ready(with_bundle: TestClient) -> None:
    connectivity.set_online(False)  # the Whisper stand-in was never downloaded, and now there is no network
    job = wait_job(with_bundle, with_bundle.post("/api/v1/morning/start").json()["id"])
    steps = {s["id"]: s for s in job["result"]["steps"]}
    assert steps["ensure_models"]["status"] == "fail" and "offline" in steps["ensure_models"]["detail"]
    assert job["result"]["ready_to_go_offline"] is False


def test_morning_prep_offline_without_a_package_fails_clearly(client: TestClient) -> None:
    client.post("/api/v1/auth/login", json={"worker_id": WORKER, "pin": PIN})
    connectivity.set_online(False)
    job = wait_job(client, client.post("/api/v1/morning/start").json()["id"])
    steps = {s["id"]: s for s in job["result"]["steps"]}
    assert steps["download_bundle"]["status"] == "fail" and job["result"]["ready_to_go_offline"] is False
    assert steps["sync_reference"]["detail"].startswith("skipped")


def test_a_full_day(client: TestClient) -> None:
    # morning (connected)
    assert client.post("/api/v1/auth/login", json={"worker_id": WORKER, "pin": PIN}).status_code == 200
    job = wait_job(client, client.post("/api/v1/morning/start").json()["id"])
    assert job["result"]["ready_to_go_offline"] is True
    # day (disconnected): airplane mode on, app locked and unlocked with the PIN, then the work
    client.post("/api/v1/system/connectivity", json={"online": False})
    client.post("/api/v1/auth/logout")
    assert client.post("/api/v1/auth/login", json={"worker_id": WORKER, "pin": PIN}).json()["mode"] == "offline_unlock"
    items = client.get("/api/v1/workorders").json()
    assert len(items) == 3 and {i["draft_status"] for i in items} == {"none"}

    # approving with a required field missing is refused with the field names
    detail = client.get(f"/api/v1/workorders/{HEADLINE_WO}").json()
    empty = {"work_order_id": HEADLINE_WO, "form_id": detail["form"]["id"], "form_version": 1, "base_version": 1, "values": {}}
    assert client.put(f"/api/v1/workorders/{HEADLINE_WO}/draft", json=empty).status_code == 200
    bad = client.post(f"/api/v1/workorders/{HEADLINE_WO}/approve")
    assert bad.status_code == 422 and {"work_performed", "pole_id"} <= set(bad.json()["detail"]["fields"])

    complete_form(client)
    assert client.get("/api/v1/workorders").json()[0]["draft_status"] == "approved"
    locked = client.put(f"/api/v1/workorders/{HEADLINE_WO}/draft", json=empty)
    assert locked.status_code == 409 and locked.json()["detail"]["code"] == "draft_locked"
    assert client.post("/api/v1/sync/run").status_code == 503  # still offline

    # back online
    client.post("/api/v1/system/connectivity", json={"online": True})
    summary = client.post("/api/v1/sync/run").json()
    assert summary["synced"] == 1 and summary["failed"] == 0
    state = client.get("/api/v1/sor/state").json()
    assert [c["work_order_id"] for c in state["completions"]] == [HEADLINE_WO]
    assert next(w for w in state["work_orders"] if w["id"] == HEADLINE_WO)["status"] == "completed"
    assert client.get("/api/v1/workorders").json()[0]["draft_status"] == "synced"


def test_requests_without_a_session_are_unauthenticated(client: TestClient) -> None:
    for path in ("/api/v1/workorders", f"/api/v1/workorders/{HEADLINE_WO}"):
        r = client.get(path)
        assert r.status_code == 401 and r.json()["detail"]["code"] == "unauthenticated"
    assert client.post("/api/v1/auth/login", json={"worker_id": WORKER, "pin": PIN}).status_code == 200
    r = client.get("/api/v1/workorders")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "no_bundle"


def test_dispatcher_console_is_reachable_while_the_device_is_offline(client: TestClient) -> None:
    connectivity.set_online(False)
    assert client.get("/api/v1/sor/state").status_code == 200
    bumped = client.post(f"/api/v1/sor/workorders/{HEADLINE_WO}/bump", json={"note": "gate code changed"}).json()
    assert bumped["version"] == 2 and "gate code" in bumped["description"]
    assert client.post("/api/v1/sor/workorders/WO-nope/bump", json={}).status_code == 404
    faults = client.post("/api/v1/sor/faults", json={"fail_next": 2, "latency_ms": 5}).json()
    assert faults["fail_next"] == 2
    assert client.post("/api/v1/sor/reset").status_code == 204
    assert client.get("/api/v1/sor/state").json()["faults"]["fail_next"] == 0
    assert next(w for w in client.get("/api/v1/sor/state").json()["work_orders"] if w["id"] == HEADLINE_WO)["version"] == 1


def test_lab_does_not_count_what_dispatch_prefilled_as_a_wrong_answer(with_bundle: TestClient, env) -> None:
    from backend.synth.demo_script import build_demo_script

    build_demo_script(with_audio=False)
    combo = {"stt_engine_id": "oracle:stt:transcript", "llm_engine_id": "rules:llm:none", "strategy_id": "rules_only"}
    r = with_bundle.post("/api/v1/lab/compare", json={"work_order_id": HEADLINE_WO, "sample_id": "demo-01", "combos": [combo]})
    assert r.status_code == 202, r.text
    done = wait_job(with_bundle, r.json()["id"])
    assert done["state"] == "succeeded", done
    result = done["result"]
    assert result["expected"]["removed_unit"] == "T9921"  # the sentence never says it; the work order does
    item = result["items"][0]
    assert item["extraction"]["fields"]["removed_unit"]["source"] == "prefill"
    assert all(v is True for k, v in item["field_correct"].items() if k != "notes"), item["field_correct"]


def test_engines_prepared_for_the_work_package_are_listed_first(with_bundle: TestClient) -> None:
    from backend.demo import bundle

    eng = with_bundle.get("/api/v1/engines").json()
    manifest = {r.engine_id for r in bundle.get_bundle().model_manifest.requirements}
    assert manifest, "the demo bundle names the engines this device must hold"
    for group in (eng["stt"], eng["llm"]):
        tagged = [e["id"] for e in group if "in-work-package" in e["tags"]]
        assert tagged and set(tagged) <= manifest
        assert [e["id"] for e in group[:len(tagged)]] == tagged  # first, so "the first ready engine" is the prepared one


def test_reset_with_device_wipes_the_local_store(with_bundle: TestClient) -> None:
    complete_form(with_bundle)
    wait_job(with_bundle, with_bundle.post("/api/v1/readiness/run").json()["id"])
    assert with_bundle.get("/api/v1/readiness").json()["checks"]
    connectivity.set_online(False)  # the demo ended in airplane mode
    assert with_bundle.post("/api/v1/sor/reset", params={"device": "true"}).status_code == 204
    assert with_bundle.get("/api/v1/auth/session").json() is None
    assert with_bundle.get("/api/v1/bundle").json() is None and with_bundle.get("/api/v1/sync/outbox").json() == []
    assert with_bundle.get("/api/v1/readiness").json() is None  # a wiped device has not been checked
    assert with_bundle.get("/api/v1/system/status").json()["connectivity"]["online"] is True  # and a clean take is connected


def test_system_of_record_http_api(env) -> None:
    """The device client can also talk to the SoR over HTTP (FV_SOR_URL); here we call the mounted app directly."""
    http = TestClient(sor_app)
    assert http.get("/api/health").json() == {"status": "ok"}
    assert http.post("/api/login", json={"worker_id": WORKER, "pin": "0000"}).status_code == 401
    login = http.post("/api/login", json={"worker_id": WORKER, "pin": PIN}).json()
    auth = {"Authorization": f"Bearer {login['token']}"}
    assert http.get("/api/bundle").status_code == 401
    bundle = http.get("/api/bundle", headers=auth).json()
    assert len(bundle["work_orders"]) == 3 and bundle["content_hash"].startswith("sha256:")
    payload = {"operation_id": "op-1", "work_order_id": HEADLINE_WO, "form_id": "transformer_replacement",
               "base_version": 1, "worker_id": WORKER, "values": {"pole_id": {"value": "123"}}}
    ok = http.post("/api/completions", json=payload, headers=auth)
    assert ok.status_code == 200 and ok.json()["status"] == "accepted"
    assert http.post("/api/completions", json=payload, headers=auth).json()["status"] == "duplicate"
    other = http.post("/api/completions", json={**payload, "operation_id": "op-2"}, headers=auth)
    assert other.status_code == 409 and other.json()["detail"]["code"] == "already_completed"
    get_sor().set_faults(__import__("backend.schemas.api", fromlist=["SorFaults"]).SorFaults(fail_next=1))
    down = http.get("/api/bundle", headers=auth)
    assert down.status_code == 503 and down.json()["detail"]["code"] == "unavailable"
    import hashlib

    data = b"photo-bytes"
    sha = hashlib.sha256(data).hexdigest()
    up = http.post("/api/photos", data={"photo_id": "ph-1", "work_order_id": HEADLINE_WO, "sha256": sha},
                   files={"file": ("p.jpg", data, "image/jpeg")}, headers=auth)
    assert up.status_code == 200
    bad = http.post("/api/photos", data={"photo_id": "ph-2", "work_order_id": HEADLINE_WO, "sha256": "0" * 64},
                    files={"file": ("p.jpg", data, "image/jpeg")}, headers=auth)
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "checksum_mismatch"
