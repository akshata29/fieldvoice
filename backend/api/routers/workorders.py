"""Work orders, drafts, approval and photos - all served from the local store, so every route works offline."""
from __future__ import annotations

import hashlib
import logging
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from backend.config import get_settings
from backend.demo import auth, bundle, kb
from backend.demo.connectivity import now_iso
from backend.demo.store import get_store
from backend.schemas.api import WorkOrderDetail, WorkOrderListItem
from backend.schemas.extraction import FieldStatus, FieldValue
from backend.schemas.forms import FormSchema
from backend.schemas.workorders import AuthSession, Bundle, FormDraft, PhotoRef, WorkOrder

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1", tags=["workorders"])
MAX_PHOTO_BYTES = 15 * 1024 * 1024
_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic", "image/gif": ".gif"}


def _session() -> AuthSession:
    s = auth.current_session()
    if s is None:
        raise auth.AuthError(401, "unauthenticated", "Sign in first.")
    return s


def _bundle(session: AuthSession) -> Bundle:
    b = bundle.get_bundle()
    if b is None or b.worker.id != session.worker.id:
        raise HTTPException(409, detail={"code": "no_bundle", "message": "No work package on this device yet. Run morning prep."})
    return b


def _find(b: Bundle, work_order_id: str) -> tuple[WorkOrder, FormSchema]:
    wo = next((w for w in b.work_orders if w.id == work_order_id), None)
    if wo is None:
        raise HTTPException(404, detail=f"work order {work_order_id!r} is not in the local package")
    form = next((f for f in b.forms if f.id == wo.form_id and f.version == wo.form_version), None) \
        or next((f for f in b.forms if f.id == wo.form_id), None)
    if form is None:
        raise HTTPException(404, detail=f"form {wo.form_id!r} is not in the local package")
    return wo, form


@router.get("/workorders", response_model=list[WorkOrderListItem])
def list_work_orders() -> list[WorkOrderListItem]:
    b = _bundle(_session())
    drafts = {d.work_order_id: d for d in get_store().list_drafts()}
    forms = {f.id: f for f in b.forms}
    return [WorkOrderListItem(work_order=w, form_title=forms[w.form_id].title if w.form_id in forms else w.form_id,
                              draft_status=drafts[w.id].status if w.id in drafts else "none") for w in b.work_orders]


@router.get("/workorders/{work_order_id}", response_model=WorkOrderDetail)
def get_work_order(work_order_id: str) -> WorkOrderDetail:
    b = _bundle(_session())
    wo, form = _find(b, work_order_id)
    return WorkOrderDetail(
        work_order=wo, form=form, assets=bundle.job_assets(work_order_id), draft=get_store().get_draft(work_order_id),
        kb=kb.search(f"{wo.title} {wo.description}", wo.id, 3))


@router.put("/workorders/{work_order_id}/draft", response_model=FormDraft)
def save_draft(work_order_id: str, draft: FormDraft) -> FormDraft:
    b = _bundle(_session())
    wo, form = _find(b, work_order_id)
    if draft.work_order_id != work_order_id:
        raise HTTPException(422, detail="draft.work_order_id does not match the URL")
    store = get_store()
    existing = store.get_draft(work_order_id)
    if existing is not None and existing.status != "draft":
        raise HTTPException(409, detail={"code": "draft_locked", "message": f"This form is already {existing.status}."})
    draft.status, draft.operation_id, draft.approved_at = "draft", None, None
    draft.form_id, draft.form_version = wo.form_id, form.version
    draft.base_version = existing.base_version if existing else (draft.base_version or wo.version)
    draft.updated_at = now_iso()
    store.save_draft(draft)
    return store.get_draft(work_order_id) or draft


def _is_empty(fv: FieldValue | None) -> bool:
    return fv is None or fv.value is None or fv.value == "" or fv.status == FieldStatus.MISSING


def missing_required(form: FormSchema, values: dict[str, FieldValue]) -> list[str]:
    out: list[str] = []
    for spec in form.fields:
        required = spec.required
        if not required and spec.required_when:
            required = all((values.get(k).value if values.get(k) else None) == v for k, v in spec.required_when.items())
        if required and _is_empty(values.get(spec.key)):
            out.append(spec.key)
    return out


@router.post("/workorders/{work_order_id}/approve", response_model=FormDraft)
def approve(work_order_id: str) -> FormDraft:
    b = _bundle(_session())
    _, form = _find(b, work_order_id)
    store = get_store()
    draft = store.get_draft(work_order_id)
    if draft is None:
        raise HTTPException(409, detail={"code": "no_draft", "message": "There is nothing to approve yet."})
    if draft.status == "draft":
        missing = missing_required(form, draft.values)
        if missing:
            labels = [form.field(k).label for k in missing]
            raise HTTPException(422, detail={"code": "missing_required_fields", "fields": missing,
                                             "message": "Required fields are empty: " + ", ".join(labels)})
    return store.approve_draft(work_order_id)


@router.post("/workorders/{work_order_id}/photos", response_model=PhotoRef)
async def upload_photo(work_order_id: str, file: UploadFile = File(...)) -> PhotoRef:
    b = _bundle(_session())
    wo, form = _find(b, work_order_id)
    content_type = (file.content_type or "").lower()
    if not content_type.startswith("image/"):
        raise HTTPException(415, detail="only image uploads are accepted")
    data = await file.read()
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(413, detail="photo is larger than 15 MB")
    store = get_store()
    existing = store.get_draft(work_order_id)
    if existing is not None and existing.status != "draft":
        raise HTTPException(409, detail={"code": "draft_locked", "message": f"This form is already {existing.status}."})
    photo_id = "ph-" + uuid.uuid4().hex[:10]
    folder = get_settings().demo_dir / "photos"
    folder.mkdir(parents=True, exist_ok=True)
    path: Path = folder / f"{photo_id}{_EXT.get(content_type, '.img')}"
    path.write_bytes(data)
    photo = PhotoRef(id=photo_id, filename=Path(file.filename or photo_id).name, content_type=content_type,
                     sha256=hashlib.sha256(data).hexdigest(), size_bytes=len(data), taken_at=now_iso())
    store.add_photo(work_order_id, photo, path)
    draft = existing or FormDraft(work_order_id=work_order_id, form_id=wo.form_id, form_version=form.version,
                                  base_version=wo.version)
    draft.updated_at = now_iso()
    store.save_draft(draft)  # merges the stored photos into the draft
    return photo


@router.get("/photos/{photo_id}")
def get_photo(photo_id: str) -> FileResponse:
    _session()
    found = get_store().get_photo(photo_id)
    if found is None or not found[1].exists():
        raise HTTPException(404, detail="photo not found")
    photo, path = found
    return FileResponse(path, media_type=photo.content_type, filename=photo.filename)
