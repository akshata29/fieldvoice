/**
 * Drives the real typed API client (src/api/*) against the mock backend, endpoint by endpoint. This is what proves
 * that every endpoint the UI uses has a mock handler and that the mock honours the contract's semantics
 * (offline gating, idempotent retries, conflicts, jobs).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authApi,
  bundleApi,
  enginesApi,
  evalApi,
  http,
  jobsApi,
  kbApi,
  labApi,
  morningApi,
  readinessApi,
  samplesApi,
  sorApi,
  syncApi,
  systemApi,
  voiceApi,
  workOrdersApi,
} from '@/api/client';
import type { FieldValue, FormDraft, JobStatus, MorningResult } from '@/api/client';
import { photoUrl } from '@/api/urls';
import { encodeWav } from '@/lib/audio/wav';
import { DEFAULT_GATES } from '@/lib/gates';
import { createMockAdapter, setMockLatency } from '@/mocks/adapter';
import { resetDemo, skipMorning } from '@/mocks/controls';
import { setMockSleepScale } from '@/mocks/router';
import { resetJobs } from '@/mocks/jobs';

const T0 = new Date('2026-10-30T09:00:00Z').getTime();

async function untilDone<R>(id: string, step = 1000, max = 120): Promise<JobStatus<R>> {
  for (let i = 0; i < max; i++) {
    const job = await jobsApi.get<R>(id);
    if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') return job;
    vi.setSystemTime(Date.now() + step);
  }
  throw new Error(`job ${id} did not finish`);
}

const fv = (key: string, value: FieldValue['value']): FieldValue => ({ key, value, source: 'user', confidence: 1, status: 'filled', evidence: null, note: null, candidates: [] });

function draftFor(id: string, formId: string, version: number, values: Record<string, FieldValue>): FormDraft {
  return {
    work_order_id: id,
    form_id: formId,
    form_version: version,
    base_version: 1,
    values,
    transcript: null,
    stt_engine_id: null,
    llm_engine_id: null,
    strategy_id: null,
    timings: [],
    photos: [],
    status: 'draft',
    operation_id: null,
    updated_at: '',
    approved_at: null,
  };
}

describe('mock backend through the typed API client', () => {
  const originalAdapter = http.defaults.adapter;

  beforeAll(() => {
    http.defaults.adapter = createMockAdapter();
    setMockLatency(0, 0);
    setMockSleepScale(0);
  });
  afterAll(() => {
    http.defaults.adapter = originalAdapter;
    setMockSleepScale(1);
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T0);
    resetDemo();
  });
  afterEach(() => {
    resetJobs();
    vi.useRealTimers();
  });

  describe('system, auth and the morning flow', () => {
    it('reports connectivity, hardware and an empty device before sign-in', async () => {
      const status = await systemApi.status();
      expect(status).toMatchObject({ connectivity: { online: true }, session: null, bundle: null, readiness: null });
      expect(status.foundry.available).toBe(true);
      expect((await systemApi.hardware()).device_profile).toBe('dev-box');
      expect(await authApi.session()).toBeNull();
      expect(await bundleApi.get()).toBeNull();
      expect(await readinessApi.get()).toBeNull();
    });

    it('requires a session for work orders (401 unauthenticated)', async () => {
      await expect(workOrdersApi.list()).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
      await expect(workOrdersApi.get('WO-1001')).rejects.toMatchObject({ code: 'unauthenticated' });
    });

    it('lists 5 workers and checks the PIN', async () => {
      expect(await authApi.workers()).toHaveLength(5);
      await expect(authApi.login({ worker_id: 'w-101', pin: '0000' })).rejects.toMatchObject({ code: 'invalid_pin', status: 401 });
      await expect(authApi.login({ worker_id: 'nobody', pin: '1234' })).rejects.toMatchObject({ status: 404 });
      const session = await authApi.login({ worker_id: 'w-102', pin: '1234' });
      expect(session).toMatchObject({ mode: 'online', worker: { id: 'w-102' } });
      expect(Date.parse(session.offline_grant_expires_at)).toBeGreaterThan(Date.parse(session.expires_at));
      expect((await authApi.session())?.worker.name).toBe('Marcus Okafor');
      await authApi.logout();
      expect(await authApi.session()).toBeNull();
    });

    it('offline sign-in works only with a stored offline grant for the same worker', async () => {
      await systemApi.setConnectivity(false);
      await expect(authApi.login({ worker_id: 'w-101', pin: '1234' })).rejects.toMatchObject({ code: 'offline', status: 503 });
      await systemApi.setConnectivity(true);
      await authApi.login({ worker_id: 'w-101', pin: '1234' });
      await authApi.logout();
      await systemApi.setConnectivity(false);
      await expect(authApi.login({ worker_id: 'w-103', pin: '1234' })).rejects.toMatchObject({ code: 'offline' });
      await expect(authApi.login({ worker_id: 'w-101', pin: '9999' })).rejects.toMatchObject({ code: 'invalid_pin' });
      const session = await authApi.login({ worker_id: 'w-101', pin: '1234' });
      expect(session.mode).toBe('offline_unlock');
    });

    it('runs the five-step morning job: live steps, model download, bundle, readiness, ready to go offline', async () => {
      await authApi.login({ worker_id: 'w-101', pin: '1234' });
      const queued = await morningApi.start();
      expect(queued.kind).toBe('morning_sync');
      expect(queued.result?.steps.map((s) => s.id)).toEqual(['authenticate', 'download_bundle', 'sync_reference', 'ensure_models', 'readiness']);

      vi.setSystemTime(Date.now() + 5000); // mid-way: during the model step
      const mid = await jobsApi.get<MorningResult>(queued.id);
      expect(mid.state).toBe('running');
      expect(mid.progress).toBeGreaterThan(0.3);
      expect(mid.progress).toBeLessThan(1);
      expect(mid.result?.steps.find((s) => s.id === 'ensure_models')?.status).toBe('running');
      expect(mid.result?.steps.find((s) => s.id === 'ensure_models')?.detail).toMatch(/Downloading qwen2\.5-1\.5b: \d+%/);
      expect(mid.result?.ready_to_go_offline).toBe(false);
      expect((await bundleApi.get())?.n_work_orders).toBe(6); // the bundle landed when its step finished

      const done = await untilDone<MorningResult>(queued.id);
      expect(done.state).toBe('succeeded');
      expect(done.progress).toBe(1);
      expect(done.result?.steps.every((s) => s.status === 'pass' || s.status === 'warn')).toBe(true);
      expect(done.result?.steps.every((s) => s.duration_ms !== null)).toBe(true);
      expect(done.result?.ready_to_go_offline).toBe(true);
      expect(done.result?.readiness?.checks.map((c) => c.id)).toEqual(['auth', 'bundle', 'forms', 'kb', 'models_cached', 'models_load', 'self_test', 'disk', 'storage']);
      expect((await readinessApi.get())?.overall).toBe(done.result?.readiness?.overall);
      const engines = await enginesApi.list();
      expect(engines.llm.find((e) => e.id === 'foundry:llm:qwen2.5-1.5b:cpu')?.availability).toBe('ready');
      expect((await systemApi.status()).readiness).not.toBeNull();
    });

    it('refuses the morning job without a session or without a connection', async () => {
      await expect(morningApi.start()).rejects.toMatchObject({ code: 'unauthenticated' });
      await authApi.login({ worker_id: 'w-101', pin: '1234' });
      await systemApi.setConnectivity(false);
      await expect(morningApi.start()).rejects.toMatchObject({ code: 'offline' });
    });

    it('supports bundle sync, readiness re-runs, listing and cancelling jobs, and unknown job ids', async () => {
      skipMorning();
      const sync = await bundleApi.sync();
      expect((await untilDone(sync.id)).result).toMatchObject({ n_work_orders: 6, n_forms: 3 });
      const rr = await readinessApi.run();
      expect((await untilDone<{ overall: string }>(rr.id)).result?.overall).toMatch(/pass|warn/);
      const j = await bundleApi.sync();
      expect((await jobsApi.cancel(j.id)).state).toBe('cancelled');
      expect((await jobsApi.list()).length).toBeGreaterThanOrEqual(3);
      await expect(jobsApi.get('job-9999')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('work orders, drafts, approval, photos and the knowledge base', () => {
    beforeEach(() => skipMorning());

    it('lists the six work orders with form titles and draft statuses', async () => {
      const list = await workOrdersApi.list();
      expect(list).toHaveLength(6);
      expect(list.find((i) => i.work_order.id === 'WO-1001')).toMatchObject({ form_title: 'Transformer replacement', draft_status: 'none' });
      expect(new Set(list.map((i) => i.draft_status))).toEqual(new Set(['none', 'draft', 'approved', 'synced', 'conflict']));
      expect(new Set(list.map((i) => i.work_order.priority)).size).toBeGreaterThanOrEqual(3);
    });

    it('returns the form, the closed world, the draft and top knowledge-base hits for one job', async () => {
      const d = await workOrdersApi.get('WO-1002');
      expect(d.form.fields.map((f) => f.type)).toEqual(expect.arrayContaining(['enum', 'entity_ref', 'number', 'boolean', 'text']));
      expect(d.assets.some((a) => a.kind === 'pole')).toBe(true);
      expect(d.assets.some((a) => a.kind === 'stock_unit')).toBe(true);
      expect(d.draft?.values.pole_id).toMatchObject({ value: '518', source: 'prefill' });
      expect(d.kb.length).toBeGreaterThan(0);
      await expect(workOrdersApi.get('WO-0000')).rejects.toMatchObject({ code: 'not_found' });
    });

    it('autosaves a draft, enforces required fields on approve, then approves atomically with outbox rows (works offline)', async () => {
      await systemApi.setConnectivity(false);
      const draft = draftFor('WO-1001', 'transformer_replacement', 3, { pole_id: fv('pole_id', '123') });
      const saved = await workOrdersApi.saveDraft('WO-1001', draft);
      expect(saved).toMatchObject({ status: 'draft', operation_id: null });
      expect(saved.updated_at).not.toBe('');
      expect((await workOrdersApi.list()).find((i) => i.work_order.id === 'WO-1001')?.draft_status).toBe('draft');

      await expect(workOrdersApi.approve('WO-1001')).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/Work performed/) });

      const full = draftFor('WO-1001', 'transformer_replacement', 3, {
        work_performed: fv('work_performed', 'transformer_replacement'),
        pole_id: fv('pole_id', '123'),
        old_unit_condition: fv('old_unit_condition', 'leaking_oil'),
        new_unit_id: fv('new_unit_id', '456'),
      });
      await workOrdersApi.saveDraft('WO-1001', full);
      const photo = await workOrdersApi.uploadPhoto('WO-1001', new File([new Uint8Array([1, 2, 3, 4])], 'oil.jpg', { type: 'image/jpeg' }));
      expect(photo).toMatchObject({ filename: 'oil.jpg', content_type: 'image/jpeg', size_bytes: 4 });
      expect(photo.sha256).toHaveLength(64);
      await workOrdersApi.saveDraft('WO-1001', { ...full, photos: [photo] });

      const before = (await syncApi.outbox()).length;
      const approved = await workOrdersApi.approve('WO-1001');
      expect(approved).toMatchObject({ status: 'approved' });
      expect(approved.operation_id).toMatch(/^op-/);
      const outbox = await syncApi.outbox();
      expect(outbox.length).toBe(before + 2);
      expect(outbox.filter((i) => i.work_order_id === 'WO-1001').map((i) => [i.kind, i.state])).toEqual([
        ['completion', 'pending'],
        ['photo', 'pending'],
      ]);
      expect((await workOrdersApi.approve('WO-1001')).operation_id).toBe(approved.operation_id); // idempotent
      await expect(workOrdersApi.saveDraft('WO-1001', full)).rejects.toMatchObject({ status: 409, code: 'locked' });
      expect((await workOrdersApi.get('WO-1001')).work_order.status).toBe('completed');
    });

    it('serves uploaded photos back as bytes and exposes a thumbnail URL', async () => {
      const photo = await workOrdersApi.uploadPhoto('WO-1001', new File([new Uint8Array([9, 8, 7])], 'a.png', { type: 'image/png' }));
      expect(photoUrl(photo.id)).toMatch(/^data:image\/png;base64,/);
      const res = await http.get<Blob>(`/photos/${photo.id}`, { responseType: 'blob' });
      expect(res.data.size).toBe(3);
      expect(photoUrl('ph-1004-a')).toMatch(/^data:image\/svg\+xml/);
      await expect(http.get('/photos/ph-missing')).rejects.toMatchObject({ status: 404 });
    });

    it('searches the knowledge base with ranking, scope and k', async () => {
      const hits = await kbApi.search('oil leak', 'WO-1001', 3);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.length).toBeLessThanOrEqual(3);
      expect(hits[0]).toMatchObject({ doc_id: expect.stringMatching(/^KB-/), heading: expect.any(String), revision: expect.any(String) });
      expect(hits[0]!.snippet.toLowerCase()).toMatch(/oil|leak/);
      for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
      expect(await kbApi.search('zzzzqqq', 'WO-1001')).toEqual([]);
      expect((await kbApi.search('', 'WO-1001')).length).toBeGreaterThan(0);
    });
  });

  describe('sync and the dispatcher console', () => {
    beforeEach(() => skipMorning());

    async function approveWO1001(flushLeftovers = true): Promise<string> {
      // Yesterday's failed item would otherwise absorb the first injected fault, so clear the queue first.
      if (flushLeftovers) await syncApi.run();
      const full = draftFor('WO-1001', 'transformer_replacement', 3, {
        work_performed: fv('work_performed', 'transformer_replacement'),
        pole_id: fv('pole_id', '123'),
        old_unit_condition: fv('old_unit_condition', 'leaking_oil'),
        new_unit_id: fv('new_unit_id', '456'),
      });
      await workOrdersApi.saveDraft('WO-1001', full);
      return (await workOrdersApi.approve('WO-1001')).operation_id as string;
    }

    it('shows outbox items in every state', async () => {
      const outbox = await syncApi.outbox();
      expect(new Set(outbox.map((i) => i.state))).toEqual(new Set(['pending', 'sending', 'synced', 'failed', 'conflict']));
      expect(outbox.find((i) => i.state === 'conflict')).toMatchObject({ base_version: 2, server_version: 3 });
      expect(outbox.find((i) => i.state === 'failed')?.last_error).toBeTruthy();
    });

    it('refuses to sync while offline (503 offline) and needs no session for the dispatcher console', async () => {
      await systemApi.setConnectivity(false);
      await expect(syncApi.run()).rejects.toMatchObject({ code: 'offline', status: 503 });
      expect((await sorApi.state()).work_orders).toHaveLength(6);
    });

    it('syncs queued completions and photos, retries failed items, and leaves conflicts for a human', async () => {
      const op = await approveWO1001(false);
      const summary = await syncApi.run();
      const mine = summary.items.filter((i) => i.work_order_id === 'WO-1001');
      expect(mine.map((i) => i.state)).toEqual(['synced']);
      expect(summary.synced).toBeGreaterThan(0);
      expect(summary.conflicts).toBe(0); // WO-1006's conflict item is not retried automatically
      const state = await sorApi.state();
      expect(state.completions.some((c) => c.operation_id === op)).toBe(true);
      const after = await syncApi.outbox();
      expect(after.find((i) => i.id === op)?.state).toBe('synced');
      expect(after.find((i) => i.id === 'op-0003')?.state).toBe('conflict');
      expect(after.find((i) => i.id === 'op-0002')?.state).toBe('synced'); // the failed item was retried successfully
      expect((await workOrdersApi.list()).find((i) => i.work_order.id === 'WO-1001')?.draft_status).toBe('synced');
    });

    it('fail_next: injected 503s mark items failed with a reason, and the next sync succeeds', async () => {
      const op = await approveWO1001();
      await sorApi.setFaults({ fail_next: 1, latency_ms: 0, drop_response_next: 0, conflict_next: 0 });
      const first = await syncApi.run();
      expect(first.failed).toBe(1);
      expect((await syncApi.outbox()).find((i) => i.id === op)?.last_error).toMatch(/503/);
      expect((await sorApi.state()).faults.fail_next).toBe(0);
      const second = await syncApi.run();
      expect(second.items.find((i) => i.id === op)?.state).toBe('synced');
    });

    it('drop_response_next: the server commits, the reply is lost, and the retry creates no duplicate', async () => {
      const op = await approveWO1001();
      await sorApi.setFaults({ fail_next: 0, latency_ms: 0, drop_response_next: 1, conflict_next: 0 });
      await syncApi.run();
      let item = (await syncApi.outbox()).find((i) => i.id === op)!;
      expect(item.state).toBe('failed');
      expect(item.last_error).toMatch(/504/);
      expect((await sorApi.state()).completions.filter((c) => c.operation_id === op)).toHaveLength(1);
      await syncApi.run();
      item = (await syncApi.outbox()).find((i) => i.id === op)!;
      expect(item.state).toBe('synced');
      expect(item.detail.idempotent_replay).toBe(true);
      expect((await sorApi.state()).completions.filter((c) => c.operation_id === op)).toHaveLength(1);
    });

    it('conflict_next and "bump version" produce conflicts; keep_mine re-sends, take_theirs discards', async () => {
      const op = await approveWO1001();
      const bumped = await sorApi.bump('WO-1001', { note: 'gate code changed' });
      expect(bumped.version).toBe(2);
      expect(bumped.description).toMatch(/gate code changed/);
      const run = await syncApi.run();
      expect(run.conflicts).toBe(1); // yesterday's conflict (op-0003) is skipped; only the new completion is attempted
      const item = (await syncApi.outbox()).find((i) => i.id === op)!;
      expect(item).toMatchObject({ state: 'conflict', base_version: 1, server_version: 2 });
      expect((await workOrdersApi.get('WO-1001')).draft?.status).toBe('conflict');

      const kept = await syncApi.resolve({ item_id: op, action: 'keep_mine' });
      expect(kept).toMatchObject({ state: 'pending', base_version: 2 });
      const again = await syncApi.run();
      expect(again.items.find((i) => i.id === op)?.state).toBe('synced');

      const theirs = await syncApi.resolve({ item_id: 'op-0003', action: 'take_theirs' });
      expect(theirs.state).toBe('synced');
      expect((await syncApi.outbox()).find((i) => i.id === 'op-0003-p1')?.state).toBe('synced');
      await expect(syncApi.resolve({ item_id: op, action: 'keep_mine' })).rejects.toMatchObject({ status: 409 });
      await expect(syncApi.resolve({ item_id: 'nope', action: 'keep_mine' })).rejects.toMatchObject({ status: 404 });
    });

    it('conflict_next fault rejects the next completion as if dispatch changed the job', async () => {
      const op = await approveWO1001();
      await sorApi.setFaults({ fail_next: 0, latency_ms: 0, drop_response_next: 0, conflict_next: 1 });
      const run = await syncApi.run();
      expect(run.conflicts).toBe(1);
      expect((await syncApi.outbox()).find((i) => i.id === op)).toMatchObject({ state: 'conflict', server_version: 2 });
    });

    it('stores fault settings, clamps negatives, and resets the system of record', async () => {
      expect(await sorApi.setFaults({ fail_next: -3, latency_ms: 250.9, drop_response_next: 2, conflict_next: 1 })).toEqual({ fail_next: 0, latency_ms: 250, drop_response_next: 2, conflict_next: 1 });
      await sorApi.bump('WO-1003');
      await sorApi.reset();
      const s = await sorApi.state();
      expect(s.faults).toEqual({ fail_next: 0, latency_ms: 0, drop_response_next: 0, conflict_next: 0 });
      expect(s.work_orders.find((w) => w.id === 'WO-1003')?.version).toBe(1);
      expect(s.completions).toEqual([]);
      await expect(sorApi.bump('WO-0000')).rejects.toMatchObject({ status: 404 });
    });

    it('a reset with device=true also wipes the device: signed out, no bundle, no readiness report', async () => {
      skipMorning();
      expect(await authApi.session()).not.toBeNull();
      expect(await bundleApi.get()).not.toBeNull();
      await sorApi.reset(); // the remote world only: the device keeps its session and bundle
      expect(await authApi.session()).not.toBeNull();
      await sorApi.reset({ device: true });
      expect(await authApi.session()).toBeNull();
      expect(await bundleApi.get()).toBeNull();
      expect(await readinessApi.get()).toBeNull();
      expect((await sorApi.state()).completions).toEqual([]);
    });
  });

  describe('engines and the catalog', () => {
    it('lists STT and LLM engines and strategies', async () => {
      const list = await enginesApi.list();
      expect(list.stt.length).toBeGreaterThanOrEqual(8);
      expect(list.llm.length).toBeGreaterThanOrEqual(8);
      expect(list.strategies.map((s) => s.id)).toEqual(['free_json', 'schema_constrained', 'enum_grammar', 'hybrid', 'rules_only']);
      expect(list.stt.some((e) => e.id === 'oracle:stt:transcript')).toBe(true);
      expect(list.llm.some((e) => e.id === 'rules:llm:none')).toBe(true);
      expect(list.stt.filter((e) => e.supports_streaming).length).toBeGreaterThan(0);
    });

    it('prepares a model with progress and then reports it ready; unload clears `loaded`', async () => {
      const id = 'foundry:stt:whisper-small:cpu';
      const job = await enginesApi.prepare(id);
      expect(job.kind).toBe('prepare_engine');
      vi.setSystemTime(Date.now() + 1000);
      const mid = await jobsApi.get(job.id);
      expect(mid.progress).toBeGreaterThan(0);
      expect(mid.message).toMatch(/Downloading/);
      const done = await untilDone(job.id);
      expect(done.state).toBe('succeeded');
      const engine = (await enginesApi.list()).stt.find((e) => e.id === id)!;
      expect(engine).toMatchObject({ availability: 'ready', loaded: true, availability_reason: null });
      expect((await enginesApi.catalog()).find((m) => m.alias === 'whisper-small')?.variants.find((v) => v.device === 'cpu')?.cached).toBe(true);
      expect((await enginesApi.unload(id)).loaded).toBe(false);
    });

    it('fails to prepare engines in the error state and refuses unavailable ones', async () => {
      const failing = await enginesApi.prepare('foundry:llm:qwen2.5-0.5b:npu');
      const done = await untilDone(failing.id);
      expect(done.state).toBe('failed');
      expect(done.error).toMatch(/NPU variant failed to load/);
      await expect(enginesApi.prepare('azure-embedded:stt:en-US')).rejects.toMatchObject({ status: 409, code: 'engine_unavailable' });
      await expect(enginesApi.prepare('nope:stt:x')).rejects.toMatchObject({ status: 404 });
    });

    it('serves a Foundry catalog with CPU/GPU/NPU variants and tasks', async () => {
      const catalog = await enginesApi.catalog();
      expect(new Set(catalog.map((m) => m.task))).toEqual(new Set(['automatic-speech-recognition', 'chat-completion', 'vision-language-chat', 'embeddings']));
      const q = catalog.find((m) => m.alias === 'qwen2.5-0.5b')!;
      expect(new Set(q.variants.map((v) => v.device))).toEqual(new Set(['cpu', 'gpu', 'npu']));
      expect(q.variants.every((v) => v.execution_provider.length > 0)).toBe(true);
    });
  });

  describe('samples, voice extraction and the lab', () => {
    beforeEach(() => skipMorning());

    it('lists samples per form with tag filters and serves audio', async () => {
      const all = await samplesApi.list({ form_id: 'transformer_replacement', limit: 100 });
      expect(all.length).toBeGreaterThan(10);
      expect(all[0]).toMatchObject({ id: 'tr-0001', has_audio: true });
      expect(all.every((s) => s.form_id === 'transformer_replacement')).toBe(true);
      const corr = await samplesApi.list({ form_id: 'transformer_replacement', tag: 'correction' });
      expect(corr.length).toBeGreaterThan(0);
      expect(corr.every((s) => s.tags.includes('correction'))).toBe(true);
      expect(await samplesApi.list({ form_id: 'transformer_replacement', limit: 2 })).toHaveLength(2);
      const audio = await http.get<Blob>('/samples/tr-0001/audio', { responseType: 'blob' });
      expect(audio.data.type).toBe('audio/wav');
      await expect(http.get('/samples/zzz/audio')).rejects.toMatchObject({ status: 404 });
    });

    it('extracts from typed text with evidence and from a dataset sample with the engines requested', async () => {
      const typed = await voiceApi.extract({ work_order_id: 'WO-1001', transcript: 'I replaced the transformer at pole one two three and installed unit four five six.', llm_engine_id: 'rules:llm:none', strategy_id: 'hybrid' });
      expect(typed.fields.pole_id).toMatchObject({ value: '123', status: 'filled' });
      expect(typed.fields.new_unit_id?.value).toBe('456');
      expect(typed.transcript_normalized).toContain('pole 123');
      expect(typed.timings.length).toBeGreaterThan(2);
      expect(typed.total_ms).toBeGreaterThan(0);

      const sample = await voiceApi.extract({
        work_order_id: 'WO-1001',
        sample_id: 'tr-0001',
        stt_engine_id: 'foundry:stt:whisper-base:cpu',
        llm_engine_id: 'foundry:llm:qwen2.5-0.5b:cpu',
        strategy_id: 'hybrid',
      });
      expect(sample).toMatchObject({ stt_engine_id: 'foundry:stt:whisper-base:cpu', strategy_id: 'hybrid' });
      expect(sample.audio_ms).toBeGreaterThan(1000);

      await expect(voiceApi.extract({ work_order_id: 'WO-1001' })).rejects.toMatchObject({ status: 422 });
      await expect(voiceApi.extract({ transcript: 'x' })).rejects.toMatchObject({ status: 422 });
      await expect(voiceApi.extract({ work_order_id: 'WO-1001', transcript: 'x', llm_engine_id: 'foundry:llm:phi-4-mini:cpu' })).rejects.toMatchObject({ status: 409, code: 'engine_not_ready' });
    });

    it('extracts from an uploaded WAV (multipart) and says that the mock did not transcribe it', async () => {
      const wav = new Blob([encodeWav(new Int16Array(16000 * 3), 16000)], { type: 'audio/wav' });
      const result = await voiceApi.extractAudio(wav, { work_order_id: 'WO-1001', stt_engine_id: 'foundry:stt:whisper-base:cpu', llm_engine_id: 'rules:llm:none', strategy_id: 'rules_only' });
      expect(result.audio_ms).toBeCloseTo(3000, 0);
      expect(result.warnings.join(' ')).toMatch(/not transcribed/);
      expect(result.fields.pole_id?.value).toBeTruthy();
      await expect(voiceApi.extractAudio(new Blob(['nope']), { work_order_id: 'WO-1001', stt_engine_id: 'x', llm_engine_id: 'rules:llm:none', strategy_id: 'rules_only' })).rejects.toMatchObject({ status: 422 });
    });

    it('compares several combinations as a job and scores them against the sample ground truth', async () => {
      const combos = [
        { stt_engine_id: 'oracle:stt:transcript', llm_engine_id: 'rules:llm:none', strategy_id: 'rules_only' },
        { stt_engine_id: 'oracle:stt:transcript', llm_engine_id: 'foundry:llm:qwen2.5-0.5b:cpu', strategy_id: 'free_json' },
        { stt_engine_id: 'foundry:stt:whisper-medium:cpu', llm_engine_id: 'foundry:llm:qwen2.5-0.5b:cpu', strategy_id: 'hybrid' }, // not downloaded
      ];
      const job = await labApi.compare({ work_order_id: 'WO-1001', sample_id: 'tr-0001', combos });
      expect(job.kind).toBe('lab_compare');
      const done = await untilDone<NonNullable<typeof job.result>>(job.id);
      const result = done.result!;
      expect(result.expected).toMatchObject({ pole_id: '123', new_unit_id: '456' });
      expect(result.items.map((i) => i.config)).toEqual(combos);
      expect(result.items[0]!.field_correct).toMatchObject({ pole_id: true, new_unit_id: true, old_unit_condition: true, work_performed: true });
      expect(result.items[2]).toMatchObject({ extraction: null, error: expect.stringMatching(/not ready/) });
      await expect(labApi.compare({ work_order_id: 'WO-1001', sample_id: 'tr-0001', combos: [] })).rejects.toMatchObject({ status: 422 });
      const typed = await untilDone<NonNullable<typeof job.result>>((await labApi.compare({ form_id: 'pole_inspection', transcript: 'Pole 305 is leaning.', combos: combos.slice(0, 1) })).id);
      expect(typed.result?.expected).toBeNull();
      expect(typed.result?.items[0]?.field_correct).toBeNull();
    });
  });

  describe('evaluation', () => {
    it('lists datasets and filters their cases', async () => {
      const datasets = await evalApi.datasets();
      expect(datasets.map((d) => d.id)).toEqual(['synth-v1', 'synth-noisy-v1']);
      expect(datasets[0]).toMatchObject({ n_cases: 72, synthetic: true });
      expect(Object.keys(datasets[0]!.tag_counts)).toEqual(expect.arrayContaining(['correction', 'negation', 'missing']));
      const page = await evalApi.datasetCases('synth-v1', { offset: 0, limit: 10 });
      expect(page).toHaveLength(10);
      const heldout = await evalApi.datasetCases('synth-v1', { split: 'heldout', limit: 100 });
      expect(heldout.every((c) => c.split === 'heldout')).toBe(true);
      const tagged = await evalApi.datasetCases('synth-v1', { tag: 'negation', limit: 100 });
      expect(tagged.length).toBeGreaterThan(0);
      expect(tagged.every((c) => c.tags.includes('negation'))).toBe(true);
      expect((await evalApi.datasetCases('synth-v1', { offset: 70, limit: 10 })).length).toBe(2);
      await expect(evalApi.datasetCases('nope')).rejects.toMatchObject({ status: 404 });
    });

    it('generates a dataset as a job with progress', async () => {
      const job = await evalApi.generateDataset({ name: 'my set', n_cases: 30, seed: 3, with_audio: true, audio_limit: 10, augment: false });
      vi.setSystemTime(Date.now() + 1500);
      expect((await jobsApi.get(job.id)).message).toMatch(/Generating|Synthesizing/);
      const done = await untilDone<{ id: string; n_cases: number; n_with_audio: number }>(job.id);
      expect(done.result).toMatchObject({ id: 'my-set', n_cases: 30, n_with_audio: 10 });
      expect((await evalApi.datasets()).some((d) => d.id === 'my-set')).toBe(true);
    });

    it('ships two finished runs with 8-10 configurations, computed metrics and hardware', async () => {
      const runs = await evalApi.runs();
      expect(runs).toHaveLength(2);
      for (const r of runs) {
        expect(r.status).toBe('succeeded');
        expect(r.configs.length).toBeGreaterThanOrEqual(8);
        expect(r.configs.length).toBeLessThanOrEqual(10);
        expect(r.hardware.device_profile).toBe('dev-box');
      }
      const run = await evalApi.run('run-0001');
      for (const m of run.configs) {
        expect(m.field_accuracy).toBeGreaterThan(0);
        expect(m.field_accuracy).toBeLessThanOrEqual(1);
        expect(m.latency_total.p95).toBeGreaterThanOrEqual(m.latency_total.p50 ?? 0);
        expect(m.silent_wrong_rate).toBeGreaterThanOrEqual(0);
        expect(m.safe_outcome_rate).toBeGreaterThan(0.8);
      }
      const byKey = Object.fromEntries(run.configs.map((m) => [m.config_key, m]));
      const rules = byKey['oracle:stt:transcript|rules:llm:none|rules_only']!;
      expect(rules.latency_total.p95).toBeLessThan(100);
      expect(rules.schema_valid_rate).toBeNull();
      expect(byKey['oracle:stt:transcript|foundry:llm:qwen2.5-0.5b:cpu|free_json']!.latency_total.p95).toBeGreaterThan(rules.latency_total.p95!);
      const speech = (await evalApi.run('run-0002')).configs;
      expect(speech.some((m) => m.wer !== null && m.wer_normalized !== null && m.wer_normalized < m.wer)).toBe(true);
      await expect(evalApi.run('run-9999')).rejects.toMatchObject({ code: 'not_found' });
    });

    it('computes decision gating server-side-style: pass/fail, reasons, rank and Pareto', async () => {
      const loose = await evalApi.decision('run-0001', { ...DEFAULT_GATES, max_p95_ms: 60_000, min_id_field_accuracy: 0, max_silent_wrong: 1 });
      expect(loose.rows.every((r) => r.passes)).toBe(true);
      expect(loose.rows.filter((r) => r.rank !== null)).toHaveLength(loose.rows.length);
      const strict = await evalApi.decision('run-0001', { ...DEFAULT_GATES, max_p95_ms: 50, max_peak_rss_mb: 600 });
      expect(strict.rows.some((r) => !r.passes && r.failed_gates.includes('max_p95_ms'))).toBe(true);
      expect(strict.gates.max_peak_rss_mb).toBe(600);
      expect(strict.pareto).toHaveLength(10);
      expect(strict.pareto.some((p) => p.pareto_optimal)).toBe(true);
    });

    it('returns per-config case results and supports only_failures, paging and unknown configs', async () => {
      const key = 'oracle:stt:transcript|foundry:llm:qwen2.5-0.5b:cpu|free_json';
      const all = await evalApi.runCases('run-0001', { config_key: key, limit: 100 });
      expect(all.length).toBe(72);
      expect(all[0]).toMatchObject({ config_key: key, ok: true });
      expect(all[0]!.extraction?.fields).toBeDefined();
      const failures = await evalApi.runCases('run-0001', { config_key: key, only_failures: true, limit: 100 });
      expect(failures.length).toBeGreaterThan(0);
      expect(failures.length).toBeLessThan(all.length);
      expect(failures.every((c) => Object.values(c.field_correct).some((ok) => !ok))).toBe(true);
      expect(await evalApi.runCases('run-0001', { config_key: key, offset: 5, limit: 3 })).toHaveLength(3);
      expect(await evalApi.runCases('run-0001', { config_key: 'unknown|x|y' })).toEqual([]);
    });

    it('exports a run as CSV and JSON', async () => {
      const csv = await evalApi.exportRun('run-0001', 'csv');
      expect(csv.filename).toBe('run-0001.csv');
      const text = await csv.blob.text();
      expect(text.split('\n')[0]).toContain('field_accuracy');
      expect(text.split('\n')).toHaveLength(11);
      const json = await evalApi.exportRun('run-0002', 'json');
      expect(JSON.parse(await json.blob.text()).run_id).toBe('run-0002');
    });

    it('starts a run as a job, exposes progress through GET /eval/runs/{id}, finishes with computed metrics and can delete it', async () => {
      const configs = [
        { stt_engine_id: 'oracle:stt:transcript', llm_engine_id: 'rules:llm:none', strategy_id: 'rules_only' },
        { stt_engine_id: 'oracle:stt:transcript', llm_engine_id: 'foundry:llm:qwen2.5-0.5b:cpu', strategy_id: 'hybrid' },
      ];
      const job = await evalApi.createRun({ dataset_id: 'synth-v1', configs, limit: 20, splits: ['dev'], repeats: 2, label: 'quick check' });
      expect(job.kind).toBe('eval_run');
      const runId = (job.result as { run_id: string }).run_id;
      expect(runId).toMatch(/^run-/);
      vi.setSystemTime(Date.now() + 2500);
      await jobsApi.get(job.id);
      const mid = await evalApi.run(runId);
      expect(mid.status).toBe('running');
      expect(mid.progress).toBeGreaterThan(0);
      expect(mid.progress).toBeLessThan(1);
      expect((await evalApi.runs())[0]!.run_id).toBe(runId); // newest first
      await untilDone(job.id);
      const finished = await evalApi.run(runId);
      expect(finished).toMatchObject({ status: 'succeeded', progress: 1, label: 'quick check' });
      expect(finished.configs).toHaveLength(2);
      expect(finished.configs.every((m) => m.n_cases === 20 || m.n_cases < 20)).toBe(true);
      expect(finished.request).toMatchObject({ limit: 20, repeats: 2, splits: ['dev'], confidence_threshold: 0.8 });
      await evalApi.deleteRun(runId);
      await expect(evalApi.run(runId)).rejects.toMatchObject({ status: 404 });
      await expect(evalApi.createRun({ dataset_id: 'nope', configs })).rejects.toMatchObject({ status: 404 });
      await expect(evalApi.createRun({ dataset_id: 'synth-v1', configs: [] })).rejects.toMatchObject({ status: 422 });
    });
  });

  it('answers unknown routes with 404 so a missing handler is loud', async () => {
    await expect(http.get('/definitely/not/a/route')).rejects.toMatchObject({ status: 404 });
  });
});
