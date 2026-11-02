# API and data contracts

`backend/schemas/*.py` is the **source of truth for every JSON shape**; this document defines the conventions, endpoints
and the WebSocket protocol around those schemas.

## 1. What we are building

An offline-first **voice-to-form** proof of concept for utility field technicians, built on **Microsoft Foundry Local**
(in-process SDK, no containers, no cloud at inference time). Phases of the worker's day:

1. **Morning (connected)** - authenticate, download today's work orders, forms, KB/procedures, reference data (assets),
   make sure local models are present and pass a self-test ("offline ready").
2. **Day (disconnected)** - worker speaks ("I replaced the transformer at pole 123. The old unit was leaking oil and
   I installed unit 456."); local ASR -> normalization -> closed-world entity resolution -> small-LLM only for what is
   left -> validation; worker reviews/edits; form is saved locally (SQLite) with photos.
3. **Back online** - outbox syncs completions + photos to the system of record (idempotent, conflict-aware).

Plus an **evaluation harness** that compares STT engines (Whisper variants, Nemotron/Parakeet streaming, Azure embedded,
Azure cloud as a non-offline ceiling) and extraction models/strategies (Qwen, Phi, Ministral, SmolLM, Gemma ...) on
**synthetic data** with metrics for accuracy, silent-wrong rate, latency, memory.

Key design rules (verified in research, see docs/FINDINGS.md): constrain *structure* with grammars but resolve ids and
enums **deterministically**; never let the LLM invent identifiers; score the **silent-wrong rate**, not JSON validity;
pin model variants (auto-selection can pick an NPU variant that fails to load); everything must degrade gracefully
(`rules_only` always works without any model).

## 2. Repository layout

```
backend/
  config.py                      settings (env FV_*)
  schemas/                       Pydantic v2 contracts  <-- source of truth
  core/                          normalize, resolver, formpack, validate, prompts, strategies, pipeline
  engines/                       STT/LLM engines, Foundry runtime, registry
  evalkit/                       metrics, runner, report, hardware, CLI
  synth/                         synthetic world, utterances, TTS, augmentation, dataset builder
  demo/                          store, auth, bundle, kb, sync, connectivity, readiness, mock system of record (sor/)
  api/main.py                    app composition + static frontend hosting
  api/routers/                   system, engines, voice, lab, eval, samples, morning, jobs, auth, bundle, workorders, kb, sync, sor
  tests/                         one sub-package per area (core, synth, demo, api)
frontend/                        React 18 + TypeScript + Vite + Tailwind
docs/  scripts/  ios-spike/  results/
data/                            generated at runtime (git-ignored): datasets/ runs/ models/ demo/ bench/
```

The modules below depend on each other only through the interfaces in section 5.

## 3. Conventions

* Python 3.11+, `from __future__ import annotations`, module docstring, type hints, `logging.getLogger(__name__)`,
  Pydantic v2, snake_case files. No secrets in code. No fabricated measurements or performance numbers anywhere.
* Run from the repo root with the shared venv: `.venv\Scripts\python.exe -m pytest`, `-m backend.<module>`.
  Windows paths; PowerShell (no bash heredocs).
* Timestamps are ISO-8601 UTC strings ending in `Z`. Ids are short strings.
* Every long-running operation is a **job**: returns `JobStatus` (HTTP 202); poll `GET /api/v1/jobs/{id}` until
  `state` is `succeeded` | `failed` | `cancelled`. Progress is 0..1; `result` holds the payload.
* Errors use FastAPI's `{"detail": ...}`. Offline gating: HTTP 503 `{"detail": {"code": "offline", "message": "..."}}`.
  Not logged in: 401 `{"detail": {"code": "unauthenticated", ...}}`. Optimistic-concurrency: 409
  `{"detail": {"code": "version_conflict", "server_version": N}}`.
* Single-user device app: the server holds the worker session, so **no Authorization header** is needed.
* Engine id convention `{provider}:{kind}:{alias}[:{device}]`, e.g. `foundry:stt:whisper-base:cpu`,
  `foundry:stt:nemotron-speech-streaming-en-0.6b:cpu`, `foundry:llm:qwen2.5-0.5b:cpu`, `azure-embedded:stt:en-US`,
  `azure-cloud:stt:default`. Special ids: `oracle:stt:transcript`, `rules:llm:none` (see `schemas/engines.py`).
* Strategy ids (`GET /engines` returns them with descriptions - clients must not hardcode the list): `free_json`,
  `schema_constrained`, `enum_grammar`, `hybrid`, `hybrid_always`, `rules_only`.

## 4. Data on disk

```
data/datasets/<dataset_id>/   manifest.json (EvalDatasetInfo)  world.json (DemoWorld)  cases.jsonl (EvalCase per line)
                              audio/<case_id>.wav  (16 kHz mono PCM16)
data/runs/<run_id>/           summary.json (RunSummary)  cases.jsonl (CaseResult per line)
data/models/                  Foundry Local model cache
data/demo/                    app.db (SQLite local store)  sor.db or in-memory SoR  photos/
```
Default dataset id: `synth-v1`.

## 5. Internal interfaces

```python
# backend/synth/world.py
def build_world(seed: int = 7) -> DemoWorld                       # deterministic
# backend/synth/build_dataset.py
def build_dataset(name: str, n_cases: int, seed: int, with_audio: bool, audio_limit: int | None,
                  augment: bool, progress: Callable[[float, str], None] | None = None) -> EvalDatasetInfo
#   CLI: python -m backend.synth.build_dataset --name synth-v1 --cases 240 --seed 11 --audio --audio-limit 120
# backend/synth/tts.py
class TtsUnavailable(RuntimeError): ...
def synthesize(text: str, out_wav: Path, voice: str | None = None, rate: int = 0) -> str   # returns voice used; 16 kHz mono PCM16

# backend/demo/connectivity.py
class OfflineError(RuntimeError): ...
class Connectivity:  online: bool; since: str; set_online(bool); require_online() -> None (raises OfflineError)
connectivity: Connectivity                                          # process-wide singleton
# backend/demo/store.py   LocalStore (SQLite)
class LocalStore:
    def __init__(self, path: Path): ...
    def get_bundle(self) -> Bundle | None;  def save_bundle(self, bundle: Bundle) -> None
    def get_session(self) -> AuthSession | None; def save_session(...); def clear_session()
    def get_draft(self, work_order_id) -> FormDraft | None; def save_draft(self, draft: FormDraft) -> None
    def approve_draft(self, work_order_id) -> FormDraft   # atomic: sets approved + operation_id AND inserts outbox rows
    def list_outbox(self) -> list[OutboxItem]
def get_store() -> LocalStore                                       # process-wide singleton
# backend/demo/bundle.py
def sync_bundle(progress: Callable[[float, str], None] | None = None) -> BundleSummary   # online required; downloads + stores
def get_bundle() -> Bundle | None
def job_assets(work_order_id: str) -> list[Asset]                  # job assets + stock inventory
# backend/demo/kb.py
def search(q: str, work_order_id: str | None = None, k: int = 5) -> list[KbHit]
# backend/core/pipeline.py  (called by api/routers/voice.py)
async/sync pipeline API, see that module
```

## 6. REST API (prefix `/api/v1`)

System / jobs
* `GET  /system/status` -> `SystemStatus`
* `POST /system/connectivity` body `ConnectivityRequest` -> `ConnectivityState`   (device airplane-mode switch)
* `GET  /system/hardware` -> `HardwareInfo`
* `GET  /jobs` -> `list[JobStatus]`; `GET /jobs/{id}` -> `JobStatus`; `POST /jobs/{id}/cancel` -> `JobStatus`

Auth
* `GET  /auth/workers` -> `list[Worker]` (demo picker, no PINs)
* `POST /auth/login` body `LoginRequest` -> `AuthSession` (online: validates with the SoR and stores an offline grant;
  offline: allowed only with a valid offline grant for the same worker -> `mode: "offline_unlock"`, else 503 offline)
* `POST /auth/logout` -> 204;  `GET /auth/session` -> `AuthSession | null`

Morning prep
* `POST /morning/start` -> `JobStatus`. `result` is `MorningResult`; steps update live as the job runs:
  `authenticate` (verifies a session exists) -> `download_bundle` -> `sync_reference` -> `ensure_models` -> `readiness`.
* `GET  /bundle` -> `BundleSummary | null`; `POST /bundle/sync` -> `JobStatus`
* `GET  /readiness` -> `ReadinessReport | null`; `POST /readiness/run` -> `JobStatus`

Work orders, knowledge base, photos
* `GET  /workorders` -> `list[WorkOrderListItem]`
* `GET  /workorders/{id}` -> `WorkOrderDetail` (includes form, closed-world assets, draft, top KB hits)
* `PUT  /workorders/{id}/draft` body `FormDraft` -> `FormDraft` (autosave; status stays `draft`)
* `POST /workorders/{id}/approve` -> `FormDraft` (atomic approve + outbox rows; works offline)
* `POST /workorders/{id}/photos` multipart `file` -> `PhotoRef`;  `GET /photos/{photo_id}` -> image bytes
* `GET  /kb/search?q=&work_order_id=&k=` -> `list[KbHit]`

Sync + dispatcher console
* `GET  /sync/outbox` -> `list[OutboxItem]`
* `POST /sync/run` -> `SyncSummary` (online required, else 503 offline)
* `POST /sync/resolve` body `ResolveRequest` -> `OutboxItem`
* `GET  /sor/state` -> `SorState`; `POST /sor/workorders/{id}/bump` body `BumpRequest` -> `WorkOrder`;
  `POST /sor/faults` body `SorFaults` -> `SorFaults`; `POST /sor/reset` -> 204.
  (The dispatcher console is the *remote* world: always reachable regardless of the device switch.)
* The device->SoR HTTP API itself lives under `/sor/api/...` (not `/api/v1`) and is only used by the device client.

Engines / models
* `GET  /engines` -> `EngineList`;  `GET /engines/catalog` -> `list[CatalogModel]` (Foundry catalog)
* `POST /engines/{engine_id}/prepare` -> `JobStatus` (download + load, progress 0..1)
* `POST /engines/{engine_id}/unload` -> `EngineInfo`

Samples / voice / lab
* `GET  /samples?form_id=&tag=&limit=` -> `list[SampleInfo]` (from dataset `synth-v1`; empty list if absent)
* `GET  /samples/{id}/audio` -> `audio/wav`
* `POST /voice/extract` body `ExtractRequest` -> `ExtractionResult`
* `POST /voice/extract-audio` multipart: `audio` (WAV) + form fields `work_order_id|form_id`, `stt_engine_id`,
  `llm_engine_id`, `strategy_id` -> `ExtractionResult`
* `POST /lab/compare` body `LabCompareRequest` -> `JobStatus`; `result` is `LabCompareResult`

Evaluation
* `GET  /eval/datasets` -> `list[EvalDatasetInfo]`; `GET /eval/datasets/{id}/cases?offset=&limit=&tag=&split=` -> `list[EvalCase]`
* `POST /eval/datasets/generate` body `DatasetGenerateRequest` -> `JobStatus` (result `EvalDatasetInfo`)
* `POST /eval/runs` body `RunRequest` -> `JobStatus` (result `{"run_id": str}`); `GET /eval/runs` -> `list[RunSummary]`
* `GET  /eval/runs/{run_id}` -> `RunSummary` (progress while running)
* `GET  /eval/runs/{run_id}/cases?config_key=&only_failures=&offset=&limit=` -> `list[CaseResult]`
* `GET  /eval/runs/{run_id}/decision?max_p95_ms=&min_id_field_accuracy=&max_silent_wrong=&max_peak_rss_mb=&min_field_accuracy=`
  -> `DecisionReport`;  `GET /eval/runs/{run_id}/export?format=csv|json`;  `DELETE /eval/runs/{run_id}`

## 7. WebSocket `/ws/voice` (live capture)

Client -> server
```
text   {"type":"start","work_order_id":str|null,"form_id":str|null,"stt_engine_id":str,"llm_engine_id":str,
        "strategy_id":str,"sample_rate":16000}
binary PCM16 little-endian mono at 16 kHz, any frame size (about 100 ms recommended)
text   {"type":"stop"}                                   end of speech -> server finalizes
text   {"type":"play_sample","sample_id":str,"realtime":bool}   server feeds a dataset sample as if from the mic
text   {"type":"cancel"}
```
Server -> client (JSON text frames)
```
{"type":"ready"}
{"type":"partial","text":str,"t_ms":number}              interim transcript; replaces the previous partial
{"type":"transcript","text":str,"final":true,"stt_ms":number,"audio_ms":number}
{"type":"stage","stage":"stt"|"normalize"|"resolve"|"llm"|"validate","ms":number}   "stt" only when real speech recognition ran
{"type":"fields","stage":"resolve"|"llm"|"validate","fields":{<key>:FieldValue},"unresolved":[str]}   progressive fill
{"type":"result","result":ExtractionResult}             final, includes timings
{"type":"error","message":str}
```
Order: `ready`, `partial`*, `transcript`, [`stage(stt)`], `stage(normalize)`, `fields(resolve)`, `stage(resolve)`,
[`fields(llm)`, `stage(llm)`], `fields(validate)`, `result`. Engines without streaming emit no `partial` frames.
`Evidence.start/end` index into `ExtractionResult.transcript_normalized`.

## 7b. Behaviour beyond the sketch above (the implementation is the source of truth where it differs)

* **Single-flight jobs**: starting a second `morning_sync`, `eval_run` or `bundle_sync` while one is queued/running returns
  409 `{"detail":{"code":"morning_in_progress"|"run_in_progress"|"sync_in_progress","job_id":...}}`. `POST /eval/runs` returns the
  `run_id` immediately in `JobStatus.result` (before the run starts); a job cancelled while queued never starts.
* **Work orders**: 409 `no_bundle` (nothing downloaded / bundle belongs to another worker), 409 `draft_locked` (approved forms
  are read-only), 409 `no_draft`, 422 `missing_required_fields` (`detail.fields` = keys), 415/413 for photos that are not
  images / larger than 15 MB. `PUT draft` ignores client-supplied `status`, `operation_id`, `approved_at`.
* **Sync**: `OutboxItem.detail.server_status` is `"accepted"` or `"duplicate"` (a retried send the server had already applied);
  401 `session_expired` when the server no longer knows the session.
* **Dispatcher**: `POST /sor/reset?device=true` also wipes the device's local store and last readiness report and sets the
  connectivity switch back to Online (clean demo run).
* **Eval**: `GET /eval/runs/{id}/export?format=csv|json|md`; `GET /samples?form_id=&tag=&split=&with_audio=&limit=` lists the
  scripted `demo-script` lines first, then `synth-v1`; `POST /lab/compare` counts what dispatch pre-filled (`prefill`) as correct.
* **Engines**: unknown engine id -> 404 on `prepare`/`unload`; unavailable-but-known engines are listed with their reason.
  `GET /engines` tags the engines named by the downloaded work package's model manifest `in-work-package` and lists them first
  within each kind.
* **Settings**: `FV_PATCH_PROMPT` (`v0`..`v4`, default `v4`) selects the hybrid pipeline's model prompt.

## 8. Testing conventions

* Code is typed and importable, with tests that pass: `.venv\Scripts\python.exe -m pytest backend/tests/<area>`.
* Tests need no network and no model download (they use mocks and fixtures).
* Every area has a short `docs/<NAME>.md` (what it does, how to run it, known gaps) that is honest about what is untested.
