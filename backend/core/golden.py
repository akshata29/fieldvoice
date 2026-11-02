"""Golden self-test: a canned utterance with known answers, used by the offline-readiness check and by tests."""
from __future__ import annotations

from backend.schemas.forms import CodeOption, FieldSpec, FieldType, FormSchema
from backend.schemas.reference import Asset

GOLDEN_TRANSCRIPT = "I replaced the transformer at pole 123. The old unit was leaking oil and I installed unit 456."
GOLDEN_EXPECTED = {
    "work_performed": "transformer_replacement",
    "pole_id": "123",
    "replacement_unit": "456",
    "condition_found": "oil_leak",
}


def golden_form() -> FormSchema:
    return FormSchema(
        id="transformer_replacement",
        version=1,
        title="Transformer replacement",
        work_type="transformer_replacement",
        fields=[
            FieldSpec(
                key="work_performed", label="Work performed", type=FieldType.ENUM, required=True,
                options=[
                    CodeOption(code="transformer_replacement", label="Transformer replacement", synonyms=[
                        "replaced the transformer", "transformer replacement", "swapped the transformer",
                        "changed out the transformer", "installed a new transformer"]),
                    CodeOption(code="transformer_repair", label="Transformer repair", synonyms=[
                        "repaired the transformer", "transformer repair", "fixed the transformer"]),
                    CodeOption(code="pole_inspection", label="Pole inspection", synonyms=[
                        "inspected the pole", "pole inspection", "checked the pole"]),
                ],
            ),
            FieldSpec(key="pole_id", label="Pole", type=FieldType.ENTITY_REF, required=True, entity_kind="pole",
                      role_triggers=["pole"]),
            FieldSpec(key="removed_unit", label="Removed unit", type=FieldType.ENTITY_REF, entity_kind="transformer",
                      role_triggers=["old unit", "removed unit", "existing unit", "pulled unit", "old transformer"]),
            FieldSpec(key="replacement_unit", label="Replacement unit", type=FieldType.ENTITY_REF,
                      entity_kind="stock_unit", required_when={"work_performed": "transformer_replacement"},
                      role_triggers=["installed", "new unit", "replacement unit", "put in", "swapped in"]),
            FieldSpec(
                key="condition_found", label="Condition found", type=FieldType.ENUM,
                options=[
                    CodeOption(code="oil_leak", label="Oil leak", synonyms=["oil leak", "leaking oil", "leaked oil",
                                                                            "oil leaking", "leaking"]),
                    CodeOption(code="corrosion", label="Corrosion", synonyms=["corrosion", "corroded", "rust"]),
                    CodeOption(code="damage", label="Physical damage", synonyms=["damaged", "cracked", "damage"]),
                    CodeOption(code="overheating", label="Overheating", synonyms=["overheating", "overheated", "burnt"]),
                    CodeOption(code="none", label="No issues", synonyms=["no issues", "no problems", "looked fine"]),
                ],
            ),
            FieldSpec(key="customer_notified", label="Customer notified", type=FieldType.BOOLEAN,
                      true_triggers=["customer notified", "notified the customer", "informed the customer",
                                     "customer was notified"]),
            FieldSpec(key="kva_rating", label="kVA rating", type=FieldType.NUMBER, unit="kVA", min_value=5,
                      max_value=500, unit_triggers=["kva"], label_triggers=["rating", "rated"]),
            FieldSpec(key="notes", label="Notes", type=FieldType.TEXT, fill_from_transcript=True),
        ],
    )


def golden_assets() -> list[Asset]:
    return [
        Asset(id="123", kind="pole", label="Pole 123"),
        Asset(id="132", kind="pole", label="Pole 132"),
        Asset(id="A77", kind="pole", label="Pole A77"),
        Asset(id="T9921", kind="transformer", label="Transformer T9921", attributes={"parent_pole": "123"}),
        Asset(id="456", kind="stock_unit", label="Stock unit 456"),
        Asset(id="465", kind="stock_unit", label="Stock unit 465"),
        Asset(id="789", kind="stock_unit", label="Stock unit 789"),
    ]
