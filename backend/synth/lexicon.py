"""Synthetic form definitions and the phrase banks utterances are generated from.

Everything here is **synthetic demo content**: the forms are modelled on typical utility field paperwork, not on any
customer's real forms. ``DEV`` banks use the forms' official lexicon (what the deterministic stages are tuned on);
``HELDOUT`` banks use colloquial phrasing that the lexicon does not contain, so the language model is genuinely needed.
"""
from __future__ import annotations

from backend.schemas.forms import CodeOption, FieldSpec, FieldType, FormSchema

FORM_IDS = ["transformer_replacement", "pole_inspection", "meter_exchange", "outage_restoration"]


def _opt(code: str, label: str, *synonyms: str) -> CodeOption:
    return CodeOption(code=code, label=label, synonyms=list(synonyms))


def transformer_replacement() -> FormSchema:
    return FormSchema(
        id="transformer_replacement", version=1, title="Transformer replacement", work_type="transformer_replacement",
        description="Replace, repair or remove a pole-mounted distribution transformer.",
        fields=[
            FieldSpec(key="work_performed", label="Work performed", type=FieldType.ENUM, required=True, options=[
                _opt("transformer_replacement", "Transformer replacement", "replaced the transformer",
                     "swapped the transformer", "changed out the transformer", "installed a new transformer",
                     "transformer replacement"),
                _opt("transformer_repair", "Transformer repair", "repaired the transformer", "fixed the transformer",
                     "transformer repair"),
                _opt("transformer_removal", "Transformer removal", "removed the transformer", "pulled the transformer",
                     "took out the transformer", "transformer removal"),
            ]),
            FieldSpec(key="pole_id", label="Pole", type=FieldType.ENTITY_REF, required=True, entity_kind="pole",
                      role_triggers=["pole"]),
            FieldSpec(key="removed_unit", label="Removed unit", type=FieldType.ENTITY_REF, entity_kind="transformer",
                      role_triggers=["old unit", "removed unit", "existing unit", "pulled unit", "old transformer"]),
            FieldSpec(key="replacement_unit", label="Replacement unit", type=FieldType.ENTITY_REF,
                      entity_kind="stock_unit", required_when={"work_performed": "transformer_replacement"},
                      role_triggers=["installed", "new unit", "replacement unit", "put in", "swapped in"]),
            FieldSpec(key="condition_found", label="Condition found", type=FieldType.ENUM, options=[
                _opt("oil_leak", "Oil leak", "oil leak", "leaking oil", "leaked oil", "oil leaking", "leaking"),
                _opt("corrosion", "Corrosion", "corrosion", "corroded", "rust"),
                _opt("damage", "Physical damage", "damaged", "cracked", "damage"),
                _opt("overheating", "Overheating", "overheating", "overheated", "burnt"),
                _opt("none", "No issues", "no issues", "no problems", "looked fine"),
            ]),
            FieldSpec(key="customer_notified", label="Customer notified", type=FieldType.BOOLEAN,
                      true_triggers=["customer notified", "notified the customer", "informed the customer",
                                     "customer was notified"]),
            FieldSpec(key="kva_rating", label="kVA rating", type=FieldType.NUMBER, unit="kVA", min_value=5,
                      max_value=500, unit_triggers=["kva"], label_triggers=["rating", "rated"]),
            FieldSpec(key="notes", label="Notes", type=FieldType.TEXT, fill_from_transcript=True),
        ])


def pole_inspection() -> FormSchema:
    return FormSchema(
        id="pole_inspection", version=1, title="Pole inspection", work_type="pole_inspection",
        description="Ground-line inspection and grading of a wood distribution pole.",
        fields=[
            FieldSpec(key="pole_id", label="Pole", type=FieldType.ENTITY_REF, required=True, entity_kind="pole",
                      role_triggers=["pole"]),
            FieldSpec(key="inspection_result", label="Inspection result", type=FieldType.ENUM, required=True, options=[
                _opt("pass", "Pass", "passed", "pass", "good condition", "serviceable"),
                _opt("fail", "Fail - replace", "failed", "rejected", "condemned", "reject"),
                _opt("monitor", "Monitor", "monitor", "watch list", "re inspect", "reinspect"),
            ]),
            FieldSpec(key="defect_found", label="Defect found", type=FieldType.ENUM, options=[
                _opt("rot", "Rot / decay", "rot", "rotted", "decay", "decayed"),
                _opt("woodpecker", "Woodpecker damage", "woodpecker", "woodpecker holes", "bird damage"),
                _opt("leaning", "Leaning", "leaning", "leans", "tilted"),
                _opt("cracked", "Cracked / split", "cracked", "split"),
                _opt("none", "No defect", "no defects", "no defect", "no problems", "looked fine"),
            ]),
            FieldSpec(key="height_ft", label="Pole height (ft)", type=FieldType.NUMBER, unit="ft", min_value=20,
                      max_value=120, unit_triggers=["foot", "feet", "ft"], label_triggers=["height"]),
            FieldSpec(key="treatment_applied", label="Preservative applied", type=FieldType.BOOLEAN,
                      true_triggers=["treated the pole", "applied preservative", "preservative applied"]),
            FieldSpec(key="notes", label="Notes", type=FieldType.TEXT, fill_from_transcript=True),
        ])


def meter_exchange() -> FormSchema:
    return FormSchema(
        id="meter_exchange", version=1, title="Meter exchange", work_type="meter_exchange",
        description="Exchange a customer revenue meter.",
        fields=[
            FieldSpec(key="reason", label="Reason", type=FieldType.ENUM, required=True, options=[
                _opt("scheduled_upgrade", "Scheduled upgrade", "scheduled upgrade", "smart meter upgrade",
                     "upgrade"),
                _opt("failed_meter", "Failed meter", "failed meter", "meter failed", "dead meter",
                     "stopped working"),
                _opt("tamper", "Tamper suspected", "tamper", "tampering"),
                _opt("customer_request", "Customer request", "customer request", "customer asked"),
            ]),
            FieldSpec(key="old_meter", label="Removed meter", type=FieldType.ENTITY_REF, entity_kind="meter",
                      required=True, role_triggers=["old meter", "removed meter", "existing meter", "removed"]),
            FieldSpec(key="new_meter", label="Installed meter", type=FieldType.ENTITY_REF, entity_kind="meter",
                      required=True, role_triggers=["new meter", "installed", "replacement meter", "put in"]),
            FieldSpec(key="final_reading", label="Final reading (kWh)", type=FieldType.NUMBER, unit="kWh",
                      min_value=0, max_value=999999, unit_triggers=["kwh", "kilowatt hours", "kilowatt hour"],
                      label_triggers=["final reading", "reading"]),
            FieldSpec(key="seal_applied", label="Seal applied", type=FieldType.BOOLEAN,
                      true_triggers=["seal applied", "sealed the meter", "new seal", "meter sealed"]),
            FieldSpec(key="notes", label="Notes", type=FieldType.TEXT, fill_from_transcript=True),
        ])


def outage_restoration() -> FormSchema:
    return FormSchema(
        id="outage_restoration", version=1, title="Outage restoration", work_type="outage_restoration",
        description="Close out a trouble call after power is restored.",
        fields=[
            FieldSpec(key="feeder", label="Feeder", type=FieldType.ENTITY_REF, required=True, entity_kind="feeder",
                      role_triggers=["feeder", "circuit"]),
            FieldSpec(key="cause", label="Cause", type=FieldType.ENUM, required=True, options=[
                _opt("tree_contact", "Tree contact", "tree contact", "tree limb", "limb on the line",
                     "tree on the line"),
                _opt("equipment_failure", "Equipment failure", "equipment failure", "blown fuse", "failed equipment",
                     "blown transformer"),
                _opt("animal_contact", "Animal contact", "animal contact", "squirrel", "bird", "animal"),
                _opt("vehicle_accident", "Vehicle accident", "vehicle accident", "car hit", "truck hit",
                     "vehicle hit"),
                _opt("weather", "Weather", "storm", "wind", "lightning", "weather"),
                _opt("unknown", "Unknown", "cause unknown", "unknown cause"),
            ]),
            FieldSpec(key="customers_restored", label="Customers restored", type=FieldType.NUMBER, unit="customers",
                      min_value=0, max_value=50000, unit_triggers=["customers"],
                      label_triggers=["restored customers", "customers restored"]),
            FieldSpec(key="power_restored", label="Power restored", type=FieldType.BOOLEAN,
                      true_triggers=["power restored", "service restored", "restored power", "restored service"]),
            FieldSpec(key="notes", label="Notes", type=FieldType.TEXT, fill_from_transcript=True),
        ])


def all_forms() -> list[FormSchema]:
    return [transformer_replacement(), pole_inspection(), meter_exchange(), outage_restoration()]


# ---- phrase banks: code -> phrases that mean it ---------------------------------------------------------------------
# Dev banks are drawn from (or very near) each form's lexicon; heldout banks are deliberately outside it.
DEV: dict[str, dict[str, dict[str, list[str]]]] = {
    "transformer_replacement": {
        "work_performed": {
            "transformer_replacement": ["replaced the transformer", "swapped the transformer",
                                        "changed out the transformer", "installed a new transformer"],
            "transformer_repair": ["repaired the transformer", "fixed the transformer"],
            "transformer_removal": ["removed the transformer", "pulled the transformer", "took out the transformer"],
        },
        "condition_found": {
            "oil_leak": ["was leaking oil", "had an oil leak", "was leaking"],
            "corrosion": ["had corrosion", "was corroded", "had rust"],
            "damage": ["was damaged", "was cracked"],
            "overheating": ["was overheating", "was burnt"],
            "none": ["looked fine", "had no issues"],
        },
    },
    "pole_inspection": {
        "inspection_result": {
            "pass": ["passed", "is in good condition", "is serviceable"],
            "fail": ["failed", "is rejected", "is condemned"],
            "monitor": ["goes on the watch list", "needs to be monitored"],
        },
        "defect_found": {
            "rot": ["has rot", "is rotted at the ground line", "shows decay"],
            "woodpecker": ["has woodpecker holes", "has woodpecker damage"],
            "leaning": ["is leaning", "is tilted"],
            "cracked": ["is cracked", "is split"],
            "none": ["has no defects", "looked fine"],
        },
    },
    "meter_exchange": {
        "reason": {
            "scheduled_upgrade": ["was a scheduled upgrade", "was a smart meter upgrade"],
            "failed_meter": ["was a failed meter", "was a dead meter"],
            "tamper": ["was tampering", "had tamper signs"],
            "customer_request": ["was a customer request"],
        },
    },
    "outage_restoration": {
        "cause": {
            "tree_contact": ["tree contact", "a tree limb on the line"],
            "equipment_failure": ["equipment failure", "a blown fuse"],
            "animal_contact": ["animal contact", "a squirrel"],
            "vehicle_accident": ["a vehicle accident", "a car hit the pole"],
            "weather": ["storm damage", "lightning"],
            "unknown": ["cause unknown"],
        },
    },
}

HELDOUT: dict[str, dict[str, dict[str, list[str]]]] = {
    "transformer_replacement": {
        "work_performed": {
            "transformer_replacement": ["hung a fresh transformer", "did a change-out on the can",
                                        "put a brand new transformer up there"],
            "transformer_repair": ["patched up the transformer", "worked on the transformer bushing"],
            "transformer_removal": ["took the transformer down", "dropped the transformer"],
        },
        "condition_found": {
            "oil_leak": ["was weeping badly", "was sweating oil all down the side", "was dripping"],
            "corrosion": ["was all eaten up", "had green crusty buildup"],
            "damage": ["was busted up", "had a big dent in the tank"],
            "overheating": ["was running hot", "smelled scorched"],
            "none": ["looked good to me", "was in great shape"],
        },
    },
    "pole_inspection": {
        "inspection_result": {
            "pass": ["is good to go", "checks out fine"],
            "fail": ["is toast", "has to come out"],
            "monitor": ["bears watching", "should be looked at again next year"],
        },
        "defect_found": {
            "rot": ["is mushy at the base", "is punky"],
            "woodpecker": ["has been pecked up", "has birds drilling it"],
            "leaning": ["has a lean to it", "is out of plumb"],
            "cracked": ["has a big crack running up it", "has a long check in it"],
            "none": ["is clean as a whistle", "has nothing wrong with it"],
        },
    },
    "meter_exchange": {
        "reason": {
            "scheduled_upgrade": ["was part of the AMI rollout", "was on the upgrade list"],
            "failed_meter": ["quit working", "was reading nothing"],
            "tamper": ["looked messed with", "had a bypass on it"],
            "customer_request": ["was something the homeowner called in", "was a homeowner request"],
        },
    },
    "outage_restoration": {
        "cause": {
            "tree_contact": ["a branch fell across the wires", "trees were rubbing the conductors"],
            "equipment_failure": ["a cutout let go", "the fuse link burned open"],
            "animal_contact": ["a raccoon got in the transformer", "an owl hit the line"],
            "vehicle_accident": ["somebody ran into the pole", "a truck took out the pole"],
            "weather": ["high winds knocked it out", "ice on the lines"],
            "unknown": ["no idea what caused it", "could not find a cause"],
        },
    },
}

KVA_VALUES = [10.0, 15.0, 25.0, 37.5, 50.0, 75.0, 100.0, 167.0]
