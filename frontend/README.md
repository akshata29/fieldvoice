# Field Voice frontend

Offline-first voice-to-form UI for utility field technicians (Microsoft Foundry Local proof of concept), plus the evaluation Lab.
React 18, TypeScript (strict), Vite, Tailwind CSS, React Router 6, TanStack Query 5, Axios, Recharts, Heroicons, clsx, Vitest.
Page-by-page summary: [`../docs/UI.md`](../docs/UI.md). Contract: [`../docs/CONTRACT.md`](../docs/CONTRACT.md).

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Dev server on :5173; proxies `/api` to `http://127.0.0.1:8010` and `/ws` to `ws://127.0.0.1:8010` (set `FV_API_PORT` to use another backend port) |
| `npm run dev:mock` | Same UI with **no backend** (mock mode, Windows-safe: `vite --mode mock`) |
| `npm run build` | Typecheck + production build into `dist/` (the backend serves it) |
| `npm run preview` | Serve `dist/` on :4173 |
| `npm test` | Vitest unit tests |
| `npm run typecheck` | `tsc --noEmit` for the app and the Vite config |
| `npm run smoke` | Real-browser smoke test against a running `dev:mock` (see `../docs/UI.md`) |

Mock mode can also be switched on with an environment variable: `$env:VITE_USE_MOCKS='true'; npm run dev`.

## Mock mode

`src/mocks/` implements the whole backend in memory behind an axios adapter, selected at build time by `VITE_USE_MOCKS`.
`main.tsx` imports it dynamically, so the production bundle contains no mock code.

- Fixtures: 5 workers, 6 work orders, 3 forms (transformer replacement with ENUM / ENTITY_REF / NUMBER / BOOLEAN / TEXT fields), assets, 7 KB documents, outbox items in every state, engines in all four availability states (ready / needs_download / unavailable / error) with reasons, a Foundry catalog, a synthetic dataset, and 2 finished runs (9 and 10 configurations).
- Behaviour: PIN login (demo PIN `1234`), offline unlock grant, morning job with live steps and model download progress, bundle and readiness, drafts and approval (atomic outbox rows), photos, KB search, sync with idempotent retries, fault injection (fail / latency / drop response / conflict) and the dispatcher console, engine prepare/unload jobs, dataset generation, Lab compare, eval runs with progress, decision gating, CSV/JSON export.
- `MockVoiceSocket` replays `docs/CONTRACT.md` section 7: ready, partial words (only for streaming engines), transcript, stage and progressive `fields` events, `result` with timings. Microphone use plays a canned sample of the form (it does not transcribe your voice).
- Every number is fabricated. The header shows a **Demo data** badge (menu: *Skip morning*, *Reset demo*) and mock-only panels carry "demo" tags. Never quote mock numbers as measurements.

## Structure

```
src/
  api/          types.ts (hand mirror of backend/schemas), errors.ts, http.ts, per-domain clients (system, workorders, engines), urls.ts
  lib/          pure logic with unit tests: waterfall, fieldDiff, gates, fieldMerge, formState, evidence, combos, voiceSession, voiceSocket, audio/{resample,wav,capture}
  hooks/        TanStack Query hooks (status polling every 3 s), useVoiceSession, useFieldMode, useDebounced, useLocalStorage
  components/   ui/ (Button, Card, Badge, Tabs, Table, Progress, Toast, Dialog, Spinner, controls), layout/ (Header, Nav, AppShell, ErrorBoundary), domain/ (form, job, sync, results, ...)
  pages/        Today, Morning, Job, Sync, Lab, Results (+ results/), Models, About
  mocks/        in-memory backend + MockVoiceSocket + fixtures (+ tests)
scripts/smoke.mjs
```

## How it maps to the contract

- **REST (section 6):** every endpoint the UI uses has a typed function in `src/api/` (`authApi`, `morningApi`, `bundleApi`, `readinessApi`, `workOrdersApi`, `kbApi`, `syncApi`, `sorApi`, `enginesApi`, `samplesApi`, `voiceApi`, `labApi`, `evalApi`, `systemApi`, `jobsApi`), all through one axios instance with `baseURL: '/api/v1'`. Errors are normalised to `ApiError` (`offline`, `unauthenticated`, `version_conflict`, `validation`, ...).
- **WebSocket (section 7):** `lib/voiceSocket.ts` (typed client) + `hooks/useVoiceSession.ts`; microphone capture in `lib/audio/capture.ts` (AudioWorklet from a Blob URL, 16 kHz mono Int16 frames of ~100 ms, level meter, graceful no-device errors) and a PCM16-to-WAV builder for uploads.
- **Jobs:** `POST` returns 202 `JobStatus`; the UI polls `GET /jobs/{id}` (progress 0..1, then `succeeded` / `failed`).
- **Schemas:** `src/api/types.ts` mirrors `backend/schemas/*.py`, enums as string-literal unions.
- **Routing:** hash routing by default, so the backend only needs to serve `dist/` as static files. Set `VITE_ROUTER=browser` at build time for history routing (the backend must then rewrite unknown paths to `index.html`).

## Contract ambiguities and the interpretation taken

- `POST /eval/runs` is assumed to expose `run_id` immediately (in the 202 job result) so the UI can poll `GET /eval/runs/{id}` for progress; it falls back to job progress.
- `/lab/compare` has no audio field, so a Lab "audio" source calls `/voice/extract-audio` once per combination. Forms for the Lab come from `GET /workorders` and dataset `form_ids` (there is no forms endpoint).
- `failed_gates` are rendered from codes (`max_p95_ms`, `min_id_field_accuracy`, `max_silent_wrong`, `max_peak_rss_mb`, `min_field_accuracy`, `no_successful_cases`); unknown codes are shown raw.
- `RunConfig.key` is not serialised, so the UI keys a configuration as `stt|llm|strategy`.
- Wrong PIN is assumed to return `401` with code `invalid_pin`; offline sign-in without a stored grant is assumed to return code `offline`.
- Approve is blocked client-side while required fields are missing or a number is out of range; values still `needs_review` ask for confirmation first.
- Evidence is highlighted only for fields from the latest extraction, and only after the span is verified against `transcript_normalized`.
- Morning "Go offline" is enabled from the job's `ready_to_go_offline`, or from the stored readiness report when no job was started in this visit.
- Live partials are assumed only for engines with `supports_streaming` (Whisper engines are not streaming).

## Tests

`npm test` runs about 190 unit tests: PCM resampling/encoding, WAV header, timing-waterfall math, field correctness diff, gate evaluation (incl. `no_successful_cases`), progressive field merge, evidence spans, combo expansion, the voice-session reducer and event parser, and the whole mock backend driven through the real typed API client plus the mock WebSocket replay.

## Known gaps

- Exercised against the real backend by hand in a browser (see `docs/UI.md`), not by an automated end-to-end test: the browser smoke test is mock-only. Microphone capture against the real backend and real iPad/Safari or Windows tablets are untested. Microphone capture needs HTTPS or localhost.
- Mock microphone playback is a canned sample; real timings, WER and memory only come from the backend.
- No component-level (jsdom) tests; the browser smoke test is mock-only and partial.
