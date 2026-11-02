"""Deterministic synthetic world: workers, assets, forms, knowledge base and today's work orders.

All content is fictional demo data. The headline utterance from the customer call ("I replaced the transformer at pole
123 ... installed unit 456") works out of the box: pole 123, transformer T9921 (old unit) and stock unit 456 always exist,
together with near-miss neighbours (132, 213, 465, 546) so wrong digits are caught by the closed-world check.
"""
from __future__ import annotations

import random
from datetime import date

from backend.schemas.reference import Asset, KbDoc, KbSection, WorkerRecord
from backend.schemas.workorders import DemoWorld, WorkOrder
from backend.synth.lexicon import KVA_VALUES, all_forms

DEFAULT_TODAY = date(2026, 3, 2)
DEMO_PIN = "1234"  # every demo worker; shown on the login screen hint. Never reuse this pattern for real credentials.

CANON_POLE, CANON_POLE_NEAR = "123", ["132", "213", "321"]
CANON_UNIT, CANON_UNIT_NEAR = "456", ["465", "546"]
CANON_TRANSFORMER = "T9921"

STREETS = ["Maple St", "Cedar Ave", "County Rd 14", "Hwy 6 frontage", "Prairie View Ln", "Elm Court", "Mill Rd",
           "Orchard Dr", "Quarry Rd", "Lakeshore Blvd", "Depot St", "Ridge Rd"]
TOWNS = ["Cedar Falls", "Ames", "Altoona", "Pleasant Hill", "Marion", "Newton"]

WORKERS = [
    WorkerRecord(id="w-1001", name="Alex Rivera", role="Line technician", crew="Crew 14", pin=DEMO_PIN),
    WorkerRecord(id="w-1002", name="Jordan Kim", role="Meter technician", crew="Crew 22", pin=DEMO_PIN),
    WorkerRecord(id="w-1003", name="Sam Patel", role="Troubleshooter", crew="Crew 7", pin=DEMO_PIN),
    WorkerRecord(id="w-1004", name="Casey Morgan", role="Lineman", crew="Crew 14", pin=DEMO_PIN),
]

_PLACEHOLDER = "Synthetic demo content - not an operating procedure."


def _doc(doc_id: str, title: str, applies_to: list[str], sections: list[tuple[str, str]], rev: str = "B") -> KbDoc:
    secs = [KbSection(heading="About this document", text=_PLACEHOLDER)]
    secs += [KbSection(heading=h, text=t) for h, t in sections]
    return KbDoc(id=doc_id, title=title, applies_to=applies_to, revision=rev, effective_date="2026-01-15", sections=secs)


def build_kb() -> list[KbDoc]:
    return [
        _doc("kb-xfmr-swap", "Pole-mounted transformer replacement", ["transformer_replacement", "transformer", "pole"], [
            ("Before you start", "Confirm the work order, pole number and transformer size. Verify the replacement unit kVA "
                                 "matches the nameplate of the unit being removed. Test and ground before climbing."),
            ("Safety", "Apply lockout tagout and grounds per the switching order. Wear arc-rated clothing and rubber goods. "
                       "Check the pole condition before climbing; do not climb a pole that fails the inspection."),
            ("Replacement steps", "Isolate the primary and secondary. Lower the old transformer with the hoist line. Hang the "
                                  "replacement, connect secondary leads, then the primary bushing connections. Record the old "
                                  "and the new serial numbers on the form."),
            ("Customer notification", "Planned interruptions longer than a few minutes require customer notification. "
                                      "Record on the form that the customer was notified."),
        ]),
        _doc("kb-oil-leak", "Leaking transformer: oil response", ["transformer_replacement", "transformer", "oil_leak"], [
            ("Assessment", "A weeping bushing or tank seam is a monitor item; a steady drip or pooling oil is a replace item. "
                           "Photograph the leak and the nameplate before any work."),
            ("Containment", "Place absorbent pads and a drip pan. Report the estimated volume lost. Do not wash oil into "
                            "storm drains or soil."),
            ("Disposal", "Tag the removed unit for oil screening and return it to the yard. Record the removed unit serial "
                         "number on the form."),
        ]),
        _doc("kb-pole-insp", "Wood pole inspection and grading", ["pole_inspection", "pole"], [
            ("Ground-line check", "Sound the pole with a hammer from the ground line to head height. Probe suspect areas. "
                                  "Record visible rot, cracks, splits, woodpecker holes and lean."),
            ("Grading", "Pass: serviceable. Monitor: re-inspect within the next cycle. Fail: reject and schedule replacement; "
                        "tag the pole so it is not climbed."),
            ("Preservative", "Apply groundline preservative to treatable areas after inspection and record that treatment "
                             "was applied."),
        ]),
        _doc("kb-woodpecker", "Woodpecker damage on poles", ["pole_inspection", "woodpecker"], [
            ("Evaluation", "Count and size the holes. Cavities that reach heartwood reduce strength: grade as monitor or fail "
                           "depending on depth and location."),
            ("Repair", "Fill shallow holes with approved wood filler; recommend deterrents where birds are persistent."),
        ]),
        _doc("kb-meter-exch", "Revenue meter exchange", ["meter_exchange", "meter"], [
            ("Before the exchange", "Verify the account address and the removed meter number against the work order. Read the "
                                    "register and take a photo of the display before removal."),
            ("Exchange", "Remove the meter, inspect the socket for heat damage, install the new meter, and confirm it powers "
                         "up and communicates. Apply a new tamper seal and record the seal."),
            ("Record keeping", "Enter the removed meter number, installed meter number and final reading in kilowatt hours."),
        ]),
        _doc("kb-outage-close", "Outage restoration close-out", ["outage_restoration", "feeder"], [
            ("Confirm restoration", "Verify voltage on all phases and that downstream protective devices are closed."),
            ("Record the cause", "Select the most likely cause: tree contact, equipment failure, animal contact, vehicle "
                                 "accident, weather or unknown. Note any damaged equipment."),
            ("Customers", "Record the number of customers restored and report any remaining partial outages."),
        ]),
        _doc("kb-switching", "Switching, tagging and grounding basics", ["transformer_replacement", "outage_restoration"], [
            ("Principles", "No work on equipment that is not isolated, tested and grounded. Follow the switching order exactly "
                           "and repeat back each step."),
            ("Tags", "Danger tags are applied and removed only by the person who applied them or per the control center."),
        ]),
        _doc("kb-customer-notify", "Customer notification requirements", ["transformer_replacement", "meter_exchange"], [
            ("When to notify", "Notify customers before a planned interruption and again when service is restored. Leave a door "
                               "hanger if the customer is not home."),
            ("Record it", "Mark the notification on the form so the dispatcher can see it."),
        ]),
    ]


def _unique_ids(rng: random.Random, n: int, lo: int, hi: int, taken: set[str]) -> list[str]:
    out: list[str] = []
    while len(out) < n:
        v = str(rng.randint(lo, hi))
        if v not in taken:
            taken.add(v)
            out.append(v)
    return out


def build_assets(rng: random.Random) -> list[Asset]:
    taken: set[str] = {CANON_POLE, CANON_UNIT, *CANON_POLE_NEAR, *CANON_UNIT_NEAR}
    assets: list[Asset] = []

    def street() -> str:
        return f"{rng.randint(100, 899)} {rng.choice(STREETS)}, {rng.choice(TOWNS)}"

    pole_ids = [CANON_POLE, *CANON_POLE_NEAR] + _unique_ids(rng, 22, 100, 399, taken) + _unique_ids(rng, 10, 1000, 1999, taken)
    pole_ids += ["A77", "A78", "B12", "C305", "D44", "E9"]
    for pid in pole_ids:
        assets.append(Asset(id=pid, kind="pole", label=f"Pole {pid}", location=street(),
                            attributes={"height_ft": str(rng.choice([30, 35, 40, 45, 50]))}))
    poles_for_xfmr = [CANON_POLE] + [p for p in pole_ids[4:] if p.isdigit()][:14]
    tx_ids = [CANON_TRANSFORMER] + [f"T{v}" for v in _unique_ids(rng, 14, 1000, 9899, taken)]
    for tid, parent in zip(tx_ids, poles_for_xfmr):
        assets.append(Asset(id=tid, kind="transformer", label=f"Transformer {tid}", location=None,
                            attributes={"parent_pole": parent, "kva": str(25.0 if tid == CANON_TRANSFORMER else rng.choice(KVA_VALUES)).rstrip("0").rstrip(".")}))
    unit_ids = [CANON_UNIT, *CANON_UNIT_NEAR] + _unique_ids(rng, 12, 400, 899, taken)
    for uid in unit_ids:
        kva = rng.choice(KVA_VALUES)
        if uid == CANON_UNIT:
            kva = 25.0  # the headline job swaps the 25 kVA unit for one of the same size
        assets.append(Asset(id=uid, kind="stock_unit", label=f"Stock transformer {uid}", location="Truck inventory",
                            attributes={"kva": str(kva).rstrip("0").rstrip(".")}))
    for mid in _unique_ids(rng, 16, 40000000, 49999999, taken):
        assets.append(Asset(id=mid, kind="meter", label=f"Meter {mid}", location=street(), attributes={"status": "installed"}))
    for mid in _unique_ids(rng, 8, 50000000, 59999999, taken):
        assets.append(Asset(id=mid, kind="meter", label=f"Meter {mid}", location="Truck inventory", attributes={"status": "stock"}))
    for fid in _unique_ids(rng, 8, 2000, 2999, taken):
        assets.append(Asset(id=fid, kind="feeder", label=f"Feeder {fid}", location=rng.choice(TOWNS)))
    return assets


def build_work_orders(rng: random.Random, assets: list[Asset], today: date) -> list[WorkOrder]:
    by_kind: dict[str, list[Asset]] = {}
    for a in assets:
        by_kind.setdefault(a.kind, []).append(a)
    poles = [a for a in by_kind["pole"] if a.id not in (CANON_POLE, *CANON_POLE_NEAR)]
    tx = {a.attributes.get("parent_pole"): a for a in by_kind["transformer"]}
    installed = [m for m in by_kind["meter"] if m.attributes.get("status") == "installed"]
    stock_meters = [m for m in by_kind["meter"] if m.attributes.get("status") == "stock"]
    feeders = by_kind["feeder"]
    pole_by_id = {a.id: a for a in by_kind["pole"]}
    iso = today.isoformat()
    wos: list[WorkOrder] = []
    n = [10230]

    def wid() -> str:
        n[0] += 1
        return f"WO-{n[0]}"

    def add(worker: str, form: str, title: str, desc: str, loc: str | None, ids: list[str], kb: list[str],
            prefill: dict, prio: str = "normal") -> None:
        wos.append(WorkOrder(id=wid(), title=title, description=desc, location=loc or "", scheduled_for=iso,
                             priority=prio, worker_id=worker, form_id=form, form_version=1, asset_ids=ids,
                             kb_doc_ids=kb, prefill=prefill))

    # the headline job from the customer call
    add("w-1001", "transformer_replacement", "Replace leaking transformer at pole 123",
        "Customer reported oil on the ground. Replace the 25 kVA unit on pole 123 with a stock unit of the same size.",
        pole_by_id[CANON_POLE].location, [CANON_POLE, *CANON_POLE_NEAR, CANON_TRANSFORMER], ["kb-xfmr-swap", "kb-oil-leak", "kb-switching"],
        {"pole_id": CANON_POLE, "removed_unit": CANON_TRANSFORMER}, "high")
    xf_poles = [p for p in poles if p.id in tx]
    for worker in ("w-1001", "w-1004", "w-1004"):
        p = xf_poles.pop(rng.randrange(len(xf_poles)))
        near = rng.sample([q for q in poles if q.id != p.id], 2)
        add(worker, "transformer_replacement", f"Replace transformer at pole {p.id}",
            f"Scheduled change-out. Verify kVA against the nameplate before climbing.", p.location,
            [p.id, tx[p.id].id, *[q.id for q in near]], ["kb-xfmr-swap", "kb-customer-notify"], {"pole_id": p.id, "removed_unit": tx[p.id].id})
    for worker in ("w-1001", "w-1004", "w-1004"):
        p = rng.choice(poles)
        near = rng.sample([q for q in poles if q.id != p.id], 2)
        add(worker, "pole_inspection", f"Ground-line inspection, pole {p.id}", "Cycle inspection. Grade and record defects.",
            p.location, [p.id, *[q.id for q in near]], ["kb-pole-insp", "kb-woodpecker"], {"pole_id": p.id})
    for _ in range(3):
        old = rng.choice(installed)
        neighbours = rng.sample([m for m in installed if m.id != old.id], 2)
        add("w-1002", "meter_exchange", f"Meter exchange at {old.location}", "Smart meter upgrade. Record the final reading.",
            old.location, [old.id, *[m.id for m in neighbours], *[m.id for m in stock_meters[:5]]],
            ["kb-meter-exch", "kb-customer-notify"], {"old_meter": old.id})
    for _ in range(2):
        f = rng.choice(feeders)
        add("w-1003", "outage_restoration", f"Restore service on feeder {f.id}", "Trouble call. Close out with cause and customers restored.",
            f.location, [f.id, *[x.id for x in rng.sample([x for x in feeders if x.id != f.id], 2)]],
            ["kb-outage-close", "kb-switching"], {"feeder": f.id}, "high")
    return wos


def build_world(seed: int = 7, today: date | None = None) -> DemoWorld:
    """Deterministic for a given ``seed`` (and ``today``, which only affects the work-order dates)."""
    rng = random.Random(seed)
    assets = build_assets(rng)
    return DemoWorld(seed=seed, workers=list(WORKERS), forms=all_forms(), assets=assets, kb_docs=build_kb(),
                     work_orders=build_work_orders(rng, assets, today or DEFAULT_TODAY))
