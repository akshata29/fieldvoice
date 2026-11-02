# Field Voice UI (frontend)

React 18 + TypeScript (strict) + Vite + Tailwind + React Router 6 + TanStack Query 5 + Axios (`/api/v1`) + Recharts. Source: `frontend/`. Full details in `frontend/README.md`.

## Run

```powershell
cd frontend
npm install
npm run dev          # :5173, proxies /api -> 127.0.0.1:8010 and /ws -> ws://127.0.0.1:8010 (real backend; FV_API_PORT overrides the port)
npm run dev:mock     # same UI, no backend (mock mode)
npm run build        # -> frontend/dist (static, hash routing; the backend can serve it as plain files)
npm run typecheck ; npm test
```

The dev server's first page load is slow (Vite transforms modules on demand). For demos use `npm run build` and serve `dist/`.

## Pages and routes (hash routing: `#/...`)

| Route | Page | Contract endpoints used |
|---|---|---|
| `#/` | **Today**: work-order cards, search, priority filter, To do / Done / All (a job is done once dispatch closed it or the worker approved it on the device) | `GET /workorders` |
| `#/morning` | **Morning**: worker picker + PIN pad, "Start my day" job (5 live steps, model download %, readiness table), "Go offline" | `/auth/*`, `POST /morning/start`, `/jobs/{id}`, `/bundle*`, `/readiness*` |
| `#/jobs/:id` | **Job / capture**: info + assets + KB search, voice panel (record, play sample, upload WAV, typed text, engine picker - defaults to the engines morning prep prepared - timing waterfall, evidence highlight), form with status/source/confidence badges, autosave, photos, Approve & save locally | `/workorders/{id}`, `/draft`, `/approve`, `/photos`, `/kb/search`, `/samples`, `/voice/extract(-audio)`, `WS /ws/voice` |
| `#/sync` | **Sync**: outbox table, Sync now, conflict dialog (keep mine / take theirs), **Dispatcher console** (bump version, fault injection, reset - optionally wiping this device too - received completions) | `/sync/*`, `/sor/*` |
| `#/lab` | **Lab**: source (dataset sample / typed text / audio) x combo matrix (STT x LLM x strategy, presets), side-by-side result cards scored against ground truth | `POST /lab/compare`, `/voice/extract-audio`, `/eval/datasets*` |
| `#/results/datasets`, `#/results/runs`, `#/results/runs/:id` | **Results**: dataset generation/browse, run builder with progress, run detail (hardware banner, sortable metrics, Pareto scatter, decision gates, case drill-down, CSV/JSON export) | `/eval/*` |
| `#/models` | **Models**: hardware + Foundry status, STT/LLM engine tables (prepare / unload), catalog browser | `/engines*`, `/system/*` |
| `#/about` | **About**: architecture + verified findings (from `docs/FINDINGS.md`), iOS/iPad status stated honestly | none |

Header (all pages): connectivity switch (`POST /system/connectivity`) with an "Offline - working from local data" banner, readiness chip, worker chip, Field mode toggle. `GET /system/status` is polled every ~3 s and after mutations.

Typed client: `frontend/src/api/` (`authApi`, `morningApi`, `workOrdersApi`, `kbApi`, `syncApi`, `sorApi`, `enginesApi`, `samplesApi`, `voiceApi`, `labApi`, `evalApi`, `systemApi`, `jobsApi`); types mirror `backend/schemas/*.py` in `src/api/types.ts`.

## Mock mode

`npm run dev:mock` (= `vite --mode mock`, `.env.mock` sets `VITE_USE_MOCKS=true`) installs an in-memory axios adapter for every endpoint and a `MockVoiceSocket` that replays the section 7 protocol (word-by-word partials for streaming engines, stage and progressive `fields` events, final `result`). Mock code is not in the production bundle.

- Everything is fabricated; the header shows a **Demo data** badge (menu: *Skip morning*, *Reset demo*). Mock timings, WER, RAM and run metrics are not measurements.
- Starts as a fresh device: sign in as any worker with PIN **1234**, then Start my day.
- State lives in memory; reloading the page resets it.
- Mock ids (workers w-101.., work orders WO-1001..) are its own; the real backend's ids (w-1001.., WO-10231) are never hard-coded in the UI.

## Field mode

Header toggle (persisted in `localStorage` key `fv.fieldMode`): larger type, 52 px touch targets, black borders, high-contrast palette for sunlight. Implemented as `data-field-mode="on"` on `<html>` plus a Tailwind `field:` variant, so every component adapts.

## Smoke test (real browser)

```powershell
npm run dev:mock                       # terminal 1
npm run smoke                          # terminal 2; optional: --only=day,mic,routes,field,lab  SMOKE_URL=...  SMOKE_OUT=...
```

Drives the already-installed Edge/Chrome through `playwright-core` (fake microphone device): morning flow, offline, sample playback, mic record/stop and press-and-hold, approve, sync, conflict dialog, every route at 768/1024/1366 px (horizontal-overflow check), Field mode (touch-target size check), Lab and Results. It records console errors/warnings, uncaught exceptions and failed requests, exits non-zero on any, and writes screenshots to `frontend/smoke-output/` (git-ignored). It targets mock mode only.

## Known gaps

- Integrated and exercised against the real backend in a browser: sign-in, morning prep with real model loads, offline voice
  (sample playback through real Whisper-base), approve, sync with an injected "reply lost" fault and an idempotent retry, Lab
  comparison and Results on real runs. Microphone capture itself has **not** been exercised against the real backend (the test browser
  has no microphone); the WebSocket audio path is covered by backend tests with fake engines, and mic capture by the mock-mode smoke test.
- Never verified on a real iPad/Safari or Windows tablet. Microphone capture needs HTTPS or localhost; iOS Safari additionally needs a user gesture and AudioWorklet support.
- The mock microphone path replays a canned sample for the form, not the speaker's words.
- Lab "recorded/uploaded audio" calls `/voice/extract-audio` once per combination (the contract's `/lab/compare` has no audio input).
- Whisper engines are treated as non-streaming (live partials only for engines with `supports_streaming`).
- Smoke test coverage is partial and mock-only.
