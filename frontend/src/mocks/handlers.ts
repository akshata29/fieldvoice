/** Mock handlers: system, jobs, auth, bundle, work orders, knowledge base, photos, sync and the dispatcher console. */
import type {
  AuthSession,
  BumpRequest,
  FormDraft,
  KbHit,
  LoginRequest,
  OutboxItem,
  PhotoRef,
  ResolveRequest,
  SorFaults,
  SyncSummary,
  WorkOrder,
  WorkOrderDetail,
  WorkOrderListItem,
} from '@/api/types';
import { registerResourceUrl } from '@/api/urls';
import { summarizeForm } from '@/lib/formLogic';
import { getDb, placeholderPhoto, type MockDb } from './db';
import { resetDemo } from './controls';
import { MOCK_HARDWARE } from './evalRuns';
import { DEMO_PIN, FORMS, KB_DOCS, WORKERS, buildWorkOrders, closedWorld } from './fixtures/world';
import { cancelJob, getJob, listJobs } from './jobs';
import { startBundleSync, startMorningJob, startReadinessJob, summarizeBundle } from './morning';
import {
  badRequest,
  clone,
  HttpError,
  json,
  noContent,
  notFound,
  offlineError,
  route,
  sleep,
  unauthenticatedError,
} from './router';

const HOUR = 3_600_000;
const nowIso = (): string => new Date().toISOString();

function requireSession(db: MockDb): AuthSession {
  if (!db.session) throw unauthenticatedError();
  return db.session;
}

// ---- system / jobs ----------------------------------------------------------------------------------------------

route('GET', '/system/status', () => {
  const db = getDb();
  return json({
    connectivity: { online: db.online, since: db.onlineSince },
    session: db.session,
    bundle: db.bundle ? summarizeBundle(db.bundle) : null,
    readiness: db.readiness,
    hardware: MOCK_HARDWARE,
    foundry: {
      available: true,
      sdk_version: 'mock',
      catalog_count: db.catalog.length,
      eps_registered: false,
      model_cache_dir: 'data\\models (mock)',
      error: null,
    },
    version: '0.1.0-mock',
  });
});

route('POST', '/system/connectivity', ({ body }) => {
  const db = getDb();
  const online = Boolean((body as { online?: boolean } | undefined)?.online);
  if (online !== db.online) {
    db.online = online;
    db.onlineSince = nowIso();
  }
  return json({ online: db.online, since: db.onlineSince });
});

route('GET', '/system/hardware', () => json(MOCK_HARDWARE));

route('GET', '/jobs', () => json(listJobs()));
route('GET', '/jobs/:id', ({ params }) => {
  const job = getJob(params.id as string);
  if (!job) throw notFound('Job');
  return json(job);
});
route('POST', '/jobs/:id/cancel', ({ params }) => {
  const job = cancelJob(params.id as string);
  if (!job) throw notFound('Job');
  return json(job);
});

// ---- auth -------------------------------------------------------------------------------------------------------

route('GET', '/auth/workers', () => json(WORKERS));

route('POST', '/auth/login', ({ body }) => {
  const db = getDb();
  const { worker_id, pin } = (body ?? {}) as Partial<LoginRequest>;
  const worker = WORKERS.find((w) => w.id === worker_id);
  if (!worker) throw notFound('Worker');
  const grantEnds = new Date(Date.now() + 36 * HOUR).toISOString();

  let mode: AuthSession['mode'] = 'online';
  if (!db.online) {
    const grant = db.offlineGrant;
    if (!grant || grant.workerId !== worker.id || Date.parse(grant.expiresAt) <= Date.now()) {
      throw offlineError(
        db.offlineGrant && db.offlineGrant.workerId !== worker.id
          ? `You are offline and this device only holds an offline grant for another worker. ${worker.name} must sign in once while connected.`
          : `You are offline and ${worker.name} has no valid offline grant on this device. Sign in once while connected; the PIN then unlocks the app offline until the grant expires.`,
      );
    }
    mode = 'offline_unlock';
  }
  if (pin !== DEMO_PIN) throw new HttpError(401, { code: 'invalid_pin', message: 'That PIN is not correct.' });

  if (db.bundle && db.bundle.worker.id !== worker.id) {
    db.bundle = null;
    db.readiness = null;
  }
  const session: AuthSession = {
    worker,
    token: `mock-${worker.id}-${Date.now().toString(36)}`,
    issued_at: nowIso(),
    expires_at: new Date(Date.now() + 12 * HOUR).toISOString(),
    offline_grant_expires_at: mode === 'online' ? grantEnds : (db.offlineGrant?.expiresAt ?? grantEnds),
    mode,
  };
  if (mode === 'online') db.offlineGrant = { workerId: worker.id, expiresAt: grantEnds };
  db.session = session;
  return json(session);
});

route('POST', '/auth/logout', () => {
  getDb().session = null;
  return noContent();
});
route('GET', '/auth/session', () => json(getDb().session));

// ---- morning / bundle / readiness -------------------------------------------------------------------------------

route('POST', '/morning/start', () => json(startMorningJob(getDb()), 202));
route('GET', '/bundle', () => {
  const db = getDb();
  return json(db.bundle ? summarizeBundle(db.bundle) : null);
});
route('POST', '/bundle/sync', () => json(startBundleSync(getDb()), 202));
route('GET', '/readiness', () => json(getDb().readiness));
route('POST', '/readiness/run', () => json(startReadinessJob(getDb()), 202));

// ---- work orders ------------------------------------------------------------------------------------------------

function effectiveStatus(db: MockDb, wo: WorkOrder): WorkOrder['status'] {
  const d = db.drafts.get(wo.id);
  if (d && d.status !== 'draft') return 'completed';
  if (d && Object.keys(d.values).length > 0) return 'in_progress';
  return wo.status === 'completed' ? 'completed' : wo.status;
}

function withStatus(db: MockDb, wo: WorkOrder): WorkOrder {
  return { ...wo, status: effectiveStatus(db, wo) };
}

route('GET', '/workorders', () => {
  const db = getDb();
  requireSession(db);
  const items: WorkOrderListItem[] = (db.bundle?.work_orders ?? []).map((wo) => ({
    work_order: withStatus(db, wo),
    form_title: FORMS.find((f) => f.id === wo.form_id)?.title ?? wo.form_id,
    draft_status: db.drafts.get(wo.id)?.status ?? 'none',
  }));
  return json(clone(items));
});

export function kbSearch(db: MockDb, q: string, workOrderId: string | null, k: number): KbHit[] {
  const wo = workOrderId ? db.bundle?.work_orders.find((w) => w.id === workOrderId) : undefined;
  const tokens = q
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((t) => t.length > 1);
  const hits: KbHit[] = [];
  for (const doc of KB_DOCS) {
    const inJob = wo ? wo.kb_doc_ids.includes(doc.id) : false;
    for (const s of doc.sections) {
      const hay = `${s.heading} ${s.text}`.toLowerCase();
      let score = 0;
      if (tokens.length === 0) score = inJob && s === doc.sections[0] ? 1 : 0;
      else {
        for (const t of tokens) {
          if (doc.title.toLowerCase().includes(t)) score += 2;
          if (s.heading.toLowerCase().includes(t)) score += 1.5;
          const count = hay.split(t).length - 1;
          score += Math.min(count, 3);
        }
        if (score > 0 && inJob) score += 0.75;
      }
      if (score <= 0) continue;
      const first = tokens.length ? hay.indexOf(tokens.find((t) => hay.includes(t)) ?? '') : 0;
      const from = Math.max(0, first - 60);
      const text = s.text;
      hits.push({
        doc_id: doc.id,
        title: doc.title,
        heading: s.heading,
        snippet: `${from > 0 ? '...' : ''}${text.slice(from, from + 220)}${from + 220 < text.length ? '...' : ''}`,
        score: Math.round(score * 100) / 100,
        revision: doc.revision,
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, k);
}

route('GET', '/workorders/:id', ({ params }) => {
  const db = getDb();
  requireSession(db);
  const wo = db.bundle?.work_orders.find((w) => w.id === params.id);
  if (!wo) throw notFound('Work order');
  const form = db.bundle?.forms.find((f) => f.id === wo.form_id) ?? FORMS.find((f) => f.id === wo.form_id);
  if (!form) throw notFound('Form');
  const detail: WorkOrderDetail = {
    work_order: withStatus(db, wo),
    form,
    assets: closedWorld(wo),
    draft: db.drafts.get(wo.id) ?? null,
    kb: kbSearch(db, `${form.title} ${wo.title}`, wo.id, 3),
  };
  return json(clone(detail));
});

route('PUT', '/workorders/:id/draft', ({ params, body }) => {
  const db = getDb();
  requireSession(db);
  const wo = db.bundle?.work_orders.find((w) => w.id === params.id);
  if (!wo) throw notFound('Work order');
  const incoming = body as FormDraft;
  const existing = db.drafts.get(wo.id);
  if (existing && existing.status !== 'draft') {
    throw new HttpError(409, { code: 'locked', message: `This form is already ${existing.status}; it can no longer be edited.` });
  }
  const stored: FormDraft = { ...incoming, work_order_id: wo.id, status: 'draft', operation_id: null, approved_at: null, updated_at: nowIso() };
  db.drafts.set(wo.id, stored);
  return json(clone(stored));
});

const photoBytes = new Map<string, { bytes: Uint8Array; type: string }>();

function nextOp(db: MockDb): string {
  db.counters.op += 1;
  return `op-${String(db.counters.op).padStart(4, '0')}`;
}

route('POST', '/workorders/:id/approve', ({ params }) => {
  const db = getDb();
  requireSession(db);
  const wo = db.bundle?.work_orders.find((w) => w.id === params.id);
  if (!wo) throw notFound('Work order');
  const draft = db.drafts.get(wo.id);
  if (!draft) throw badRequest('There is nothing to approve yet: fill in the form first.');
  if (draft.status !== 'draft') return json(clone(draft)); // idempotent
  const form = db.bundle?.forms.find((f) => f.id === wo.form_id);
  if (form) {
    const missing = summarizeForm(form, draft.values).requiredMissing;
    if (missing.length > 0) throw badRequest(`Required fields are missing: ${missing.map((m) => m.label).join(', ')}.`);
  }
  const op = nextOp(db);
  const stamp = nowIso();
  const approved: FormDraft = { ...draft, status: 'approved', operation_id: op, approved_at: stamp, updated_at: stamp, base_version: wo.version };
  db.drafts.set(wo.id, approved);
  const items: OutboxItem[] = [
    {
      id: op,
      kind: 'completion',
      work_order_id: wo.id,
      state: 'pending',
      attempts: 0,
      last_error: null,
      created_at: stamp,
      updated_at: stamp,
      base_version: wo.version,
      server_version: null,
      detail: { form_id: wo.form_id, fields: Object.keys(approved.values).length },
    },
    ...approved.photos.map<OutboxItem>((p, i) => ({
      id: `${op}-p${i + 1}`,
      kind: 'photo',
      work_order_id: wo.id,
      state: 'pending',
      attempts: 0,
      last_error: null,
      created_at: stamp,
      updated_at: stamp,
      base_version: wo.version,
      server_version: null,
      detail: { photo_id: p.id, filename: p.filename },
    })),
  ];
  db.outbox.push(...items);
  return json(clone(approved));
});

// ---- photos -----------------------------------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return Array.from(bytes.subarray(0, 32))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .padEnd(64, '0');
  }
}

route('POST', '/workorders/:id/photos', async ({ params, form }) => {
  const db = getDb();
  requireSession(db);
  const wo = db.bundle?.work_orders.find((w) => w.id === params.id);
  if (!wo) throw notFound('Work order');
  const file = form?.get('file');
  if (!(file instanceof Blob)) throw badRequest('file: field required');
  const bytes = new Uint8Array(await file.arrayBuffer());
  db.counters.photo += 1;
  const id = `ph-${wo.id.toLowerCase()}-${String(db.counters.photo).padStart(3, '0')}`;
  const type = file.type || 'image/jpeg';
  const ref: PhotoRef = {
    id,
    filename: (file as File).name || `photo-${db.counters.photo}.jpg`,
    content_type: type,
    sha256: await sha256Hex(bytes),
    size_bytes: bytes.length,
    taken_at: nowIso(),
  };
  db.photos.set(id, ref);
  photoBytes.set(id, { bytes, type });
  registerResourceUrl(`/photos/${encodeURIComponent(id)}`, `data:${type};base64,${toBase64(bytes)}`);
  return json(ref);
});

route('GET', '/photos/:id', ({ params }) => {
  const db = getDb();
  const id = params.id as string;
  const ref = db.photos.get(id);
  if (!ref) throw notFound('Photo');
  const stored = photoBytes.get(id);
  if (stored) return { status: 200, data: new Blob([stored.bytes as unknown as BlobPart], { type: stored.type }), headers: { 'content-type': stored.type } };
  const svg = decodeURIComponent(placeholderPhoto(ref.filename, 200).split(',')[1] ?? '');
  return { status: 200, data: new Blob([svg], { type: 'image/svg+xml' }), headers: { 'content-type': 'image/svg+xml' } };
});

route('GET', '/kb/search', ({ query }) => {
  const db = getDb();
  return json(kbSearch(db, query.q ?? '', query.work_order_id ?? null, Math.max(1, Math.min(20, Number(query.k ?? 5) || 5))));
});

// ---- sync + dispatcher console ----------------------------------------------------------------------------------

route('GET', '/sync/outbox', () => json(clone(getDb().outbox)));

function failItem(item: OutboxItem, message: string): void {
  item.state = 'failed';
  item.attempts += 1;
  item.last_error = message;
  item.updated_at = nowIso();
}

function syncOne(db: MockDb, item: OutboxItem): void {
  const sorWo = db.sorWorkOrders.find((w) => w.id === item.work_order_id);
  const faults = db.faults;
  const attempt = () => {
    item.updated_at = nowIso();
  };
  if (faults.fail_next > 0) {
    faults.fail_next -= 1;
    failItem(item, '503 Service Unavailable (injected fault): the system of record rejected the request before doing any work.');
    return;
  }
  if (item.kind === 'completion') {
    if (faults.conflict_next > 0 && sorWo) {
      faults.conflict_next -= 1;
      sorWo.version += 1;
      item.state = 'conflict';
      item.attempts += 1;
      item.server_version = sorWo.version;
      item.last_error = `Dispatch changed this job (version ${item.base_version} to ${sorWo.version}) after you started it.`;
      attempt();
      const d = db.drafts.get(item.work_order_id);
      if (d) db.drafts.set(d.work_order_id, { ...d, status: 'conflict' });
      return;
    }
    if (sorWo && sorWo.version !== item.base_version && !db.sorOps.has(item.id)) {
      item.state = 'conflict';
      item.attempts += 1;
      item.server_version = sorWo.version;
      item.last_error = `Dispatch changed this job (version ${item.base_version} to ${sorWo.version}) after you started it.`;
      attempt();
      const d = db.drafts.get(item.work_order_id);
      if (d) db.drafts.set(d.work_order_id, { ...d, status: 'conflict' });
      return;
    }
    const duplicate = db.sorOps.has(item.id);
    if (!duplicate) {
      const d = db.drafts.get(item.work_order_id);
      db.sorOps.add(item.id);
      db.sorCompletions.push({
        operation_id: item.id,
        work_order_id: item.work_order_id,
        base_version: item.base_version,
        committed_at: nowIso(),
        values: Object.fromEntries(Object.entries(d?.values ?? {}).map(([k, v]) => [k, v.value])),
      });
      if (sorWo) sorWo.status = 'completed';
    }
    if (faults.drop_response_next > 0) {
      faults.drop_response_next -= 1;
      failItem(item, '504 Gateway Timeout: the server committed the completion but the reply was lost. The retry reuses the same operation id, so no duplicate is created.');
      item.detail = { ...item.detail, server_committed: true };
      return;
    }
    item.state = 'synced';
    item.attempts += 1;
    item.last_error = null;
    item.server_version = sorWo?.version ?? item.base_version;
    item.detail = { ...item.detail, server_committed: true, idempotent_replay: duplicate };
    attempt();
    const d = db.drafts.get(item.work_order_id);
    if (d) db.drafts.set(d.work_order_id, { ...d, status: 'synced' });
    return;
  }
  const photoId = String(item.detail.photo_id ?? item.id);
  db.sorPhotoIds.add(photoId);
  item.state = 'synced';
  item.attempts += 1;
  item.last_error = null;
  item.server_version = sorWo?.version ?? item.base_version;
  attempt();
}

route('POST', '/sync/run', async () => {
  const db = getDb();
  if (!db.online) throw offlineError('Syncing needs a connection. Switch the device back to Online to send the queued items.');
  const latency = Math.min(4000, Math.max(0, db.faults.latency_ms));
  await sleep(450 + latency);
  const summary: SyncSummary = { attempted: 0, synced: 0, failed: 0, conflicts: 0, items: [] };
  const queue = db.outbox.filter((i) => i.state === 'pending' || i.state === 'failed' || i.state === 'sending');
  const ordered = [...queue.filter((i) => i.kind === 'completion'), ...queue.filter((i) => i.kind === 'photo')];
  for (const item of ordered) {
    if (item.kind === 'photo') {
      const completion = db.outbox.find((i) => i.kind === 'completion' && i.work_order_id === item.work_order_id);
      if (completion && completion.state !== 'synced') continue; // photos follow their completion
    }
    summary.attempted += 1;
    syncOne(db, item);
    summary.items.push(clone(item));
    if (item.state === 'synced') summary.synced += 1;
    else if (item.state === 'failed') summary.failed += 1;
    else if (item.state === 'conflict') summary.conflicts += 1;
  }
  return json(summary);
});

route('POST', '/sync/resolve', ({ body }) => {
  const db = getDb();
  const { item_id, action } = (body ?? {}) as Partial<ResolveRequest>;
  const item = db.outbox.find((i) => i.id === item_id);
  if (!item) throw notFound('Outbox item');
  if (item.state !== 'conflict') throw new HttpError(409, { code: 'not_in_conflict', message: 'This item is not in conflict.' });
  const sorWo = db.sorWorkOrders.find((w) => w.id === item.work_order_id);
  const serverVersion = item.server_version ?? sorWo?.version ?? item.base_version;
  const draft = db.drafts.get(item.work_order_id);
  const deviceWo = db.bundle?.work_orders.find((w) => w.id === item.work_order_id);
  if (action === 'keep_mine') {
    item.base_version = serverVersion;
    item.state = 'pending';
    item.last_error = null;
    item.detail = { ...item.detail, resolution: 'keep_mine' };
    if (draft) db.drafts.set(draft.work_order_id, { ...draft, status: 'approved', base_version: serverVersion });
  } else if (action === 'take_theirs') {
    item.state = 'synced';
    item.last_error = null;
    item.detail = { ...item.detail, resolution: 'take_theirs' };
    if (draft) db.drafts.set(draft.work_order_id, { ...draft, status: 'synced' });
    for (const other of db.outbox) {
      if (other.work_order_id === item.work_order_id && other.kind === 'photo' && other.state !== 'synced') {
        other.state = 'synced';
        other.detail = { ...other.detail, resolution: 'discarded' };
      }
    }
  } else {
    throw badRequest('action must be keep_mine or take_theirs');
  }
  if (deviceWo) deviceWo.version = serverVersion;
  item.updated_at = nowIso();
  return json(clone(item));
});

route('GET', '/sor/state', () => {
  const db = getDb();
  return json(clone({ work_orders: db.sorWorkOrders, completions: db.sorCompletions, photos: db.sorPhotoIds.size, faults: db.faults }));
});

route('POST', '/sor/workorders/:id/bump', ({ params, body }) => {
  const db = getDb();
  const wo = db.sorWorkOrders.find((w) => w.id === params.id);
  if (!wo) throw notFound('Work order');
  const { title, note } = (body ?? {}) as BumpRequest;
  wo.version += 1;
  if (title) wo.title = title;
  if (note) wo.description = `${wo.description}\n\nDispatch note (v${wo.version}): ${note}`;
  return json(clone(wo));
});

route('POST', '/sor/faults', ({ body }) => {
  const db = getDb();
  const b = (body ?? {}) as Partial<SorFaults>;
  const n = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
  db.faults = { fail_next: n(b.fail_next), latency_ms: n(b.latency_ms), drop_response_next: n(b.drop_response_next), conflict_next: n(b.conflict_next) };
  return json(db.faults);
});

route('POST', '/sor/reset', ({ query }) => {
  if (query.device === 'true') resetDemo(); // a fresh device too: no session, bundle, drafts or outbox
  const db = getDb();
  db.sorWorkOrders = buildWorkOrders(db.session?.worker.id ?? 'w-101').map((w) => (w.id === 'WO-1006' ? { ...w, version: 3 } : w));
  db.sorCompletions = [];
  db.sorPhotoIds = new Set();
  db.sorOps = new Set();
  db.faults = { fail_next: 0, latency_ms: 0, drop_response_next: 0, conflict_next: 0 };
  return noContent();
});

