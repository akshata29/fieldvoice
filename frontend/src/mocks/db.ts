/** In-memory state of the mock backend: device store, remote system of record, engines, datasets and runs. */
import type {
  AuthSession,
  Bundle,
  CaseResult,
  CatalogModel,
  EngineInfo,
  EvalCase,
  EvalDatasetInfo,
  FieldValue,
  FormDraft,
  OutboxItem,
  PhotoRef,
  ReadinessReport,
  RunConfig,
  RunSummary,
  Scalar,
  SorFaults,
  WorkOrder,
} from '@/api/types';
import { registerResourceUrl } from '@/api/urls';
import { buildDatasetInfo, generateCases } from './dataset';
import { buildRun } from './evalRuns';
import { buildCatalog, buildEngines } from './fixtures/engines';
import { ASSETS, FORMS, KB_DOCS, MODEL_MANIFEST, buildWorkOrders } from './fixtures/world';

export const DEFAULT_DATASET_ID = 'synth-v1';

export interface MockRun {
  summary: RunSummary;
  results: Map<string, CaseResult[]>;
}

export interface MockDb {
  online: boolean;
  onlineSince: string;
  session: AuthSession | null;
  offlineGrant: { workerId: string; expiresAt: string } | null;
  bundle: Bundle | null;
  readiness: ReadinessReport | null;
  drafts: Map<string, FormDraft>;
  outbox: OutboxItem[];
  historySeeded: boolean;
  sorWorkOrders: WorkOrder[];
  sorCompletions: Array<Record<string, unknown>>;
  sorPhotoIds: Set<string>;
  sorOps: Set<string>;
  faults: SorFaults;
  photos: Map<string, PhotoRef>;
  engines: EngineInfo[];
  catalog: CatalogModel[];
  datasets: Map<string, { info: EvalDatasetInfo; cases: EvalCase[] }>;
  runs: Map<string, MockRun>;
  runsBuilt: boolean;
  counters: { op: number; photo: number; run: number };
}

const NO_FAULTS: SorFaults = { fail_next: 0, latency_ms: 0, drop_response_next: 0, conflict_next: 0 };

const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();
const HOUR = 3_600_000;

function createState(): MockDb {
  const datasets = new Map<string, { info: EvalDatasetInfo; cases: EvalCase[] }>();
  const mainOpts = { id: DEFAULT_DATASET_ID, name: 'synth-v1', n: 72, seed: 11, audioLimit: 36, augment: true, createdAt: iso(-26 * HOUR) };
  const hardOpts = { id: 'synth-noisy-v1', name: 'synth-noisy-v1', n: 30, seed: 23, audioLimit: null, augment: true, createdAt: iso(-5 * HOUR) };
  for (const opts of [mainOpts, hardOpts]) {
    const cases = generateCases(opts);
    datasets.set(opts.id, { info: buildDatasetInfo(opts, cases), cases });
  }

  const sorWorkOrders = buildWorkOrders('w-101').map((w) => (w.id === 'WO-1006' ? { ...w, version: 3 } : w));
  return {
    online: true,
    onlineSince: iso(-2 * HOUR),
    session: null,
    offlineGrant: null,
    bundle: null,
    readiness: null,
    drafts: new Map(),
    outbox: [],
    historySeeded: false,
    sorWorkOrders,
    sorCompletions: [],
    sorPhotoIds: new Set(),
    sorOps: new Set(),
    faults: { ...NO_FAULTS },
    photos: new Map(),
    engines: buildEngines(),
    catalog: buildCatalog(),
    datasets,
    runs: new Map(),
    runsBuilt: false,
    counters: { op: 3, photo: 0, run: 2 },
  };
}

let state: MockDb = createState();

export const getDb = (): MockDb => state;

export function resetDb(): void {
  state = createState();
}

// ---- helpers ----------------------------------------------------------------------------------------------------

const val = (key: string, value: Scalar, source: FieldValue['source'] = 'rule', confidence = 0.95, status: FieldValue['status'] = 'filled'): FieldValue => ({
  key,
  value,
  source,
  confidence,
  status,
  evidence: null,
  note: null,
  candidates: [],
});

export function placeholderPhoto(label: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 45% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 50% 38%)"/></linearGradient></defs><rect width="640" height="480" fill="url(#g)"/><g fill="none" stroke="rgba(255,255,255,.55)" stroke-width="6"><path d="M0 340 L640 300"/><path d="M0 380 L640 350"/></g><rect x="250" y="120" width="140" height="170" rx="10" fill="rgba(15,23,42,.65)"/><text x="320" y="420" text-anchor="middle" font-family="Segoe UI, Arial" font-size="30" fill="#fff">${label}</text><text x="320" y="455" text-anchor="middle" font-family="Segoe UI, Arial" font-size="18" fill="rgba(255,255,255,.8)">demo photo</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function fixturePhoto(db: MockDb, id: string, filename: string, hue: number): PhotoRef {
  const ref: PhotoRef = { id, filename, content_type: 'image/svg+xml', sha256: `demo-${id}`.padEnd(64, '0'), size_bytes: 4200, taken_at: iso(-20 * HOUR) };
  db.photos.set(id, ref);
  registerResourceUrl(`/photos/${encodeURIComponent(id)}`, placeholderPhoto(filename, hue));
  return ref;
}

function outboxItem(partial: Partial<OutboxItem> & Pick<OutboxItem, 'id' | 'kind' | 'work_order_id' | 'state' | 'base_version'>): OutboxItem {
  return {
    attempts: 0,
    last_error: null,
    created_at: iso(-20 * HOUR),
    updated_at: iso(-19 * HOUR),
    server_version: null,
    detail: {},
    ...partial,
  };
}

/** Yesterday's leftovers: drafts and outbox rows in every state, so the Sync screen has something to show. */
export function seedHistory(db: MockDb): void {
  if (db.historySeeded || !db.bundle) return;
  db.historySeeded = true;
  const wo = (id: string): WorkOrder => db.bundle?.work_orders.find((w) => w.id === id) as WorkOrder;
  const draftBase = (id: string, formId: string, formVersion: number) => ({
    work_order_id: id,
    form_id: formId,
    form_version: formVersion,
    base_version: wo(id).version,
    stt_engine_id: 'foundry:stt:nemotron-speech-streaming-en-0.6b:cpu',
    llm_engine_id: 'foundry:llm:qwen2.5-0.5b:cpu',
    strategy_id: 'hybrid',
    timings: [],
    updated_at: iso(-21 * HOUR),
  });

  // WO-1002: a partly filled draft (dispatch pre-filled the pole)
  db.drafts.set('WO-1002', {
    ...draftBase('WO-1002', 'transformer_replacement', 3),
    values: {
      work_performed: val('work_performed', 'transformer_replacement', 'rule', 0.94),
      pole_id: { ...val('pole_id', '518', 'prefill', 1), note: 'Pre-filled by dispatch' },
    },
    transcript: 'replaced the transformer',
    photos: [],
    status: 'draft',
    operation_id: null,
    approved_at: null,
  });

  const p1 = fixturePhoto(db, 'ph-1004-a', 'meter-register.jpg', 205);
  db.drafts.set('WO-1004', {
    ...draftBase('WO-1004', 'meter_exchange', 1),
    values: {
      old_meter_id: val('old_meter_id', '88201', 'rule', 0.97),
      new_meter_id: val('new_meter_id', '70155', 'rule', 0.97),
      final_reading_kwh: val('final_reading_kwh', 482, 'rule', 0.95),
      exchange_reason: val('exchange_reason', 'scheduled_upgrade', 'user', 1),
      seal_applied: val('seal_applied', true, 'rule', 0.95),
    },
    transcript: 'exchanged meter 88201 for new meter 70155. final reading was 482 kilowatt hours. seal applied.',
    photos: [p1],
    status: 'synced',
    operation_id: 'op-0001',
    approved_at: iso(-20 * HOUR),
  });
  const p2 = fixturePhoto(db, 'ph-1005-a', 'pole-base.jpg', 28);
  db.drafts.set('WO-1005', {
    ...draftBase('WO-1005', 'pole_inspection', 2),
    values: {
      pole_id: val('pole_id', '734', 'rule', 0.97),
      pole_condition: val('pole_condition', 'leaning', 'rule', 0.94),
      lean_angle_deg: val('lean_angle_deg', 14, 'rule', 0.95),
      needs_treatment: val('needs_treatment', true, 'user', 1),
    },
    transcript: 'pole 734 is leaning. lean angle about 14 degrees.',
    photos: [p2],
    status: 'approved',
    operation_id: 'op-0002',
    approved_at: iso(-3 * HOUR),
  });
  const p3 = fixturePhoto(db, 'ph-1006-a', 'meter-seal-holes.jpg', 340);
  db.drafts.set('WO-1006', {
    ...draftBase('WO-1006', 'meter_exchange', 1),
    values: {
      old_meter_id: val('old_meter_id', '88207', 'rule', 0.97),
      new_meter_id: val('new_meter_id', '70171', 'rule', 0.97),
      final_reading_kwh: val('final_reading_kwh', 1203, 'user', 1),
      exchange_reason: val('exchange_reason', 'tamper_suspected', 'rule', 0.93),
    },
    transcript: 'tamper suspected on meter 88207. installed new meter 70171, final reading 1203 kilowatt hours.',
    photos: [p3],
    status: 'conflict',
    operation_id: 'op-0003',
    approved_at: iso(-2 * HOUR),
  });

  db.outbox = [
    outboxItem({ id: 'op-0001', kind: 'completion', work_order_id: 'WO-1004', state: 'synced', attempts: 1, base_version: 1, server_version: 1, updated_at: iso(-19 * HOUR), detail: { form_id: 'meter_exchange', fields: 5 } }),
    outboxItem({ id: 'op-0001-p1', kind: 'photo', work_order_id: 'WO-1004', state: 'synced', attempts: 1, base_version: 1, server_version: 1, updated_at: iso(-19 * HOUR), detail: { photo_id: 'ph-1004-a', filename: 'meter-register.jpg' } }),
    outboxItem({
      id: 'op-0002',
      kind: 'completion',
      work_order_id: 'WO-1005',
      state: 'failed',
      attempts: 2,
      last_error: '503 Service Unavailable: the system of record did not respond. Will retry.',
      base_version: 1,
      created_at: iso(-3 * HOUR),
      updated_at: iso(-40 * 60_000),
      detail: { form_id: 'pole_inspection', fields: 4 },
    }),
    outboxItem({ id: 'op-0002-p1', kind: 'photo', work_order_id: 'WO-1005', state: 'sending', attempts: 1, base_version: 1, created_at: iso(-3 * HOUR), updated_at: iso(-30 * 60_000), detail: { photo_id: 'ph-1005-a', filename: 'pole-base.jpg' } }),
    outboxItem({
      id: 'op-0003',
      kind: 'completion',
      work_order_id: 'WO-1006',
      state: 'conflict',
      attempts: 1,
      last_error: 'Dispatch changed this job (version 2 to 3) after you started it.',
      base_version: 2,
      server_version: 3,
      created_at: iso(-2 * HOUR),
      updated_at: iso(-90 * 60_000),
      detail: { form_id: 'meter_exchange', fields: 4 },
    }),
    outboxItem({ id: 'op-0003-p1', kind: 'photo', work_order_id: 'WO-1006', state: 'pending', attempts: 0, base_version: 2, created_at: iso(-2 * HOUR), updated_at: iso(-2 * HOUR), detail: { photo_id: 'ph-1006-a', filename: 'meter-seal-holes.jpg' } }),
  ];

  db.sorCompletions.push({
    operation_id: 'op-0001',
    work_order_id: 'WO-1004',
    base_version: 1,
    committed_at: iso(-19 * HOUR),
    values: { old_meter_id: '88201', new_meter_id: '70155', final_reading_kwh: 482, exchange_reason: 'scheduled_upgrade', seal_applied: true },
  });
  db.sorOps.add('op-0001');
  db.sorPhotoIds.add('ph-1004-a');
}

/** Builds the worker's morning bundle from the system of record (all of today's jobs are assigned to the signed-in worker). */
export function buildBundle(db: MockDb, workerId: string): Bundle {
  const worker = db.session?.worker;
  if (!worker) throw new Error('no session');
  const workOrders = buildWorkOrders(workerId).map((w) => {
    const sor = db.sorWorkOrders.find((s) => s.id === w.id);
    // the device copy keeps the version it downloaded unless this is a refresh (handled by the caller)
    return { ...w, version: sor && db.bundle ? sor.version : w.version };
  });
  const issued = iso();
  return {
    bundle_id: `bundle-${Date.now().toString(36)}`,
    worker,
    issued_at: issued,
    expires_at: iso(36 * HOUR),
    work_orders: workOrders,
    forms: FORMS,
    assets: ASSETS,
    kb_docs: KB_DOCS,
    model_manifest: MODEL_MANIFEST,
    content_hash: `sha256:${Math.abs(Array.from(issued).reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)).toString(16).padStart(8, '0')}c0ffee`,
  };
}

export function installBundle(db: MockDb): void {
  if (!db.session) return;
  db.bundle = buildBundle(db, db.session.worker.id);
  seedHistory(db);
}

/** The two pre-built runs are deterministic and read-only, so "Reset demo" can reuse them instead of recomputing. */
const demoRunCache = new Map<string, ReturnType<typeof buildRun>>();

export function ensureRuns(db: MockDb): void {
  if (db.runsBuilt) return;
  db.runsBuilt = true;
  if (demoRunCache.size > 0) {
    demoRunCache.forEach((built, id) => db.runs.set(id, built));
    return;
  }
  const main = db.datasets.get(DEFAULT_DATASET_ID);
  if (!main) return;
  const O = 'oracle:stt:transcript';
  const N = 'rules:llm:none';
  const q05 = 'foundry:llm:qwen2.5-0.5b:cpu';
  const q15 = 'foundry:llm:qwen2.5-1.5b:cpu';
  const phi = 'foundry:llm:phi-3.5-mini:cpu';
  const phi4 = 'foundry:llm:phi-4-mini:cpu';
  const q3 = 'foundry:llm:qwen3-0.6b:cpu';
  const cfg = (s: string, l: string, st: string): RunConfig => ({ stt_engine_id: s, llm_engine_id: l, strategy_id: st });

  const ladder: RunConfig[] = [
    cfg(O, N, 'rules_only'),
    cfg(O, q05, 'free_json'),
    cfg(O, q05, 'schema_constrained'),
    cfg(O, q05, 'enum_grammar'),
    cfg(O, q05, 'hybrid'),
    cfg(O, q3, 'hybrid'),
    cfg(O, q15, 'hybrid'),
    cfg(O, phi, 'free_json'),
    cfg(O, phi, 'hybrid'),
    cfg(O, phi4, 'hybrid'),
  ];
  const stt = 'foundry:stt:';
  const speech: RunConfig[] = [
    cfg(`${stt}whisper-tiny:cpu`, N, 'rules_only'),
    cfg(`${stt}whisper-base:cpu`, N, 'rules_only'),
    cfg(`${stt}whisper-small:cpu`, N, 'rules_only'),
    cfg(`${stt}whisper-medium:cpu`, N, 'rules_only'),
    cfg(`${stt}nemotron-speech-streaming-en-0.6b:cpu`, N, 'rules_only'),
    cfg(`${stt}whisper-base:cpu`, q05, 'hybrid'),
    cfg(`${stt}nemotron-speech-streaming-en-0.6b:cpu`, q05, 'hybrid'),
    cfg(`${stt}whisper-small:cpu`, q15, 'hybrid'),
    cfg('azure-cloud:stt:default', N, 'rules_only'),
  ];

  const request = (configs: RunConfig[], label: string, repeats: number, extra: Partial<RunSummary['request']> = {}): RunSummary['request'] => ({
    dataset_id: DEFAULT_DATASET_ID,
    configs,
    limit: null,
    splits: null,
    tags: null,
    repeats,
    warmup: 1,
    confidence_threshold: 0.8,
    label,
    ...extra,
  });

  const specs = [
    { id: 'run-0001', label: 'Strategy x model ladder (reference transcript)', request: request(ladder, 'Strategy x model ladder (reference transcript)', 3), at: -24 * HOUR },
    { id: 'run-0002', label: 'Speech engines (rules only) and hybrid pairs', request: request(speech, 'Speech engines (rules only) and hybrid pairs', 3), at: -3 * HOUR },
  ];
  for (const s of specs) {
    const built = buildRun({
      runId: s.id,
      label: s.label,
      dataset: { id: main.info.id, cases: main.cases },
      request: s.request,
      forms: FORMS,
      assets: ASSETS,
      createdAt: iso(s.at),
      finishedAt: iso(s.at + 9 * 60_000),
    });
    db.runs.set(s.id, built);
    demoRunCache.set(s.id, built);
  }
}
