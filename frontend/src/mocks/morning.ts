/** Mock jobs for the morning routine: bundle download, model preparation and the readiness self-test. */
import type { BundleSummary, JobStatus, MorningResult, MorningStep, ReadinessCheck, ReadinessReport, ReadinessStatus } from '@/api/types';
import { startJob } from './jobs';
import { buildBundle, installBundle, seedHistory, type MockDb } from './db';
import { offlineError, unauthenticatedError } from './router';
import { MODEL_MANIFEST } from './fixtures/world';

export function summarizeBundle(b: NonNullable<MockDb['bundle']>): BundleSummary {
  return {
    bundle_id: b.bundle_id,
    worker_id: b.worker.id,
    issued_at: b.issued_at,
    expires_at: b.expires_at,
    n_work_orders: b.work_orders.length,
    n_forms: b.forms.length,
    n_assets: b.assets.length,
    n_kb_docs: b.kb_docs.length,
    content_hash: b.content_hash,
  };
}

const worstOf = (statuses: ReadinessStatus[]): ReadinessStatus => (statuses.includes('fail') ? 'fail' : statuses.includes('warn') ? 'warn' : 'pass');

export function buildReadiness(db: MockDb): ReadinessReport {
  const required = MODEL_MANIFEST.requirements.filter((r) => r.required);
  const missing = required.filter((r) => db.engines.find((e) => e.id === r.engine_id)?.availability !== 'ready');
  const unsynced = db.outbox.filter((i) => i.state !== 'synced').length;
  const b = db.bundle;
  const checks: ReadinessCheck[] = [
    { id: 'auth', label: 'Worker signed in', status: db.session ? 'pass' : 'fail', detail: db.session ? `${db.session.worker.name} (${db.session.mode === 'online' ? 'online sign-in' : 'offline unlock'})` : 'Nobody is signed in', duration_ms: 3 },
    { id: 'bundle', label: "Today's bundle downloaded", status: b ? 'pass' : 'fail', detail: b ? `${b.work_orders.length} work orders; valid until ${new Date(b.expires_at).toLocaleString()}` : 'No bundle on this device', duration_ms: 6 },
    { id: 'forms', label: 'Forms match the work orders', status: b ? 'pass' : 'fail', detail: b ? `${b.forms.length} forms, every work order's form version is present` : 'No bundle', duration_ms: 9 },
    { id: 'kb', label: 'Knowledge base indexed', status: b ? 'pass' : 'fail', detail: b ? `${b.kb_docs.length} documents searchable offline` : 'No bundle', duration_ms: 41 },
    { id: 'models_cached', label: 'Required models are cached', status: missing.length ? 'fail' : 'pass', detail: missing.length ? `Missing: ${missing.map((m) => m.alias).join(', ')}` : `${required.length} required models are in the local cache`, duration_ms: 18 },
    { id: 'models_load', label: 'Models load from the cache', status: missing.length ? 'fail' : 'pass', detail: missing.length ? 'Skipped (models missing)' : 'Pinned CPU variants loaded; accelerator variants were not used', duration_ms: 2310 },
    { id: 'self_test', label: 'End-to-end self-test', status: missing.length ? 'fail' : 'pass', detail: missing.length ? 'Skipped (models missing)' : 'The canned utterance produced every required field', duration_ms: 880 },
    { id: 'disk', label: 'Free disk space', status: 'pass', detail: 'Enough room for photos and the local store (demo value)', duration_ms: 5 },
    {
      id: 'storage',
      label: 'Local store',
      status: unsynced > 0 ? 'warn' : 'pass',
      detail: unsynced > 0 ? `${unsynced} item${unsynced === 1 ? ' is' : 's are'} still waiting to sync (see the Sync screen)` : 'Nothing waiting to sync',
      duration_ms: 12,
    },
  ];
  return { overall: worstOf(checks.map((c) => c.status)), checks, generated_at: new Date().toISOString() };
}

// ---- morning job ------------------------------------------------------------------------------------------------

const PLAN: Array<{ id: MorningStep['id']; label: string; ms: number }> = [
  { id: 'authenticate', label: 'Authenticate', ms: 600 },
  { id: 'download_bundle', label: "Download today's work orders, forms and knowledge base", ms: 1700 },
  { id: 'sync_reference', label: 'Sync reference data (assets and stock inventory)', ms: 1100 },
  { id: 'ensure_models', label: 'Make sure the local AI models are present', ms: 4400 },
  { id: 'readiness', label: 'Self-test and readiness checks', ms: 1800 },
];
const TOTAL_MS = PLAN.reduce((a, s) => a + s.ms, 0);

export function startMorningJob(db: MockDb): JobStatus<MorningResult> {
  if (!db.session) throw unauthenticatedError();
  if (!db.online) throw offlineError('Morning preparation downloads the bundle and models, so it needs a connection. Switch to Online first.');

  const toDownload = MODEL_MANIFEST.requirements
    .map((r) => db.engines.find((e) => e.id === r.engine_id))
    .filter((e): e is NonNullable<typeof e> => !!e && e.availability === 'needs_download');
  let bundleDone = false;
  let modelsDone = false;
  let readinessDone = false;
  let report: ReadinessReport | null = null;

  const build = (elapsed: number): { result: MorningResult; message: string } => {
    let start = 0;
    let message = 'Starting...';
    const steps = PLAN.map<MorningStep>((p) => {
      const end = start + p.ms;
      const step: MorningStep = { id: p.id, label: p.label, status: 'pending', detail: '', duration_ms: null };
      if (elapsed >= end) {
        step.status = 'pass';
        step.duration_ms = p.ms;
      } else if (elapsed >= start) {
        step.status = 'running';
        const frac = (elapsed - start) / p.ms;
        switch (p.id) {
          case 'authenticate':
            step.detail = 'Checking the stored session...';
            break;
          case 'download_bundle':
            step.detail = `Downloading... ${Math.min(6, Math.floor(frac * 7))} of 6 work orders`;
            break;
          case 'sync_reference':
            step.detail = 'Fetching assets and truck stock inventory...';
            break;
          case 'ensure_models': {
            if (toDownload.length > 0 && frac < 0.8) {
              const per = 0.8 / toDownload.length;
              const idx = Math.min(toDownload.length - 1, Math.floor(frac / per));
              const within = (frac - idx * per) / per;
              const model = toDownload[idx];
              const size = model?.size_mb ?? 0;
              step.detail = `Downloading ${model?.alias ?? 'model'}: ${Math.round(within * 100)}% (${Math.round(within * size)} / ${Math.round(size)} MB)`;
            } else {
              step.detail = 'Loading the pinned CPU variants and running a self-test...';
            }
            break;
          }
          case 'readiness':
            step.detail = 'Running the end-to-end self-test...';
            break;
        }
        message = step.detail;
      }
      start = end;
      return step;
    });

    if (elapsed >= PLAN[0]!.ms && !db.session) throw unauthenticatedError();
    const bundleEnd = PLAN[0]!.ms + PLAN[1]!.ms;
    const modelsEnd = bundleEnd + PLAN[2]!.ms + PLAN[3]!.ms;
    if (!bundleDone && elapsed >= bundleEnd) {
      bundleDone = true;
      installBundle(db);
    }
    if (!modelsDone && elapsed >= modelsEnd) {
      modelsDone = true;
      for (const r of MODEL_MANIFEST.requirements) {
        const e = db.engines.find((x) => x.id === r.engine_id);
        if (e && e.availability === 'needs_download') {
          e.availability = 'ready';
          e.availability_reason = null;
          e.loaded = true;
        }
      }
      for (const m of db.catalog) for (const v of m.variants) if (toDownload.some((e) => e.variant_id === v.id)) v.cached = true;
    }
    if (!readinessDone && elapsed >= TOTAL_MS) {
      readinessDone = true;
      report = buildReadiness(db);
      db.readiness = report;
    }

    const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
    if (bundleDone && db.bundle) byId.download_bundle!.detail = `${db.bundle.work_orders.length} work orders, ${db.bundle.forms.length} forms, ${db.bundle.kb_docs.length} knowledge-base documents`;
    if (elapsed >= PLAN[0]!.ms) byId.authenticate!.detail = `Signed in as ${db.session?.worker.name ?? 'worker'} (${db.session?.mode === 'offline_unlock' ? 'offline unlock' : 'online'})`;
    if (elapsed >= bundleEnd + PLAN[2]!.ms) byId.sync_reference!.detail = `${db.bundle?.assets.length ?? 0} assets including stock inventory`;
    if (modelsDone) {
      byId.ensure_models!.detail = toDownload.length > 0 ? `Downloaded ${toDownload.map((e) => e.alias).join(', ')}; all required models are ready` : 'All required models were already in the cache';
    }
    if (readinessDone && report) {
      byId.readiness!.status = report.overall === 'fail' ? 'fail' : report.overall === 'warn' ? 'warn' : 'pass';
      byId.readiness!.detail = report.overall === 'pass' ? 'All checks passed' : report.overall === 'warn' ? 'Ready, with warnings (see below)' : 'A check failed (see below)';
    }
    return {
      result: { steps, readiness: report, ready_to_go_offline: readinessDone && report !== null && (report as ReadinessReport).overall !== 'fail' },
      message: readinessDone ? 'Ready to go offline' : message,
    };
  };

  return startJob<MorningResult>({
    kind: 'morning_sync',
    durationMs: TOTAL_MS,
    message: 'Starting...',
    initialResult: build(0).result,
    tick: (job, _p, elapsed) => {
      const out = build(elapsed);
      job.result = out.result;
      job.message = out.message;
    },
    complete: (job) => {
      const out = build(TOTAL_MS + 1);
      job.message = 'Ready to go offline';
      return out.result;
    },
  });
}

export function startBundleSync(db: MockDb): JobStatus<BundleSummary> {
  if (!db.session) throw unauthenticatedError();
  if (!db.online) throw offlineError('Bundle sync needs a connection.');
  return startJob<BundleSummary>({
    kind: 'bundle_sync',
    durationMs: 1600,
    message: 'Downloading the bundle...',
    complete: () => {
      db.bundle = buildBundle(db, db.session?.worker.id ?? 'w-101');
      seedHistory(db);
      return summarizeBundle(db.bundle);
    },
  });
}

export function startReadinessJob(db: MockDb): JobStatus<ReadinessReport> {
  return startJob<ReadinessReport>({
    kind: 'readiness',
    durationMs: 2400,
    message: 'Running checks...',
    complete: () => {
      const report = buildReadiness(db);
      db.readiness = report;
      return report;
    },
  });
}
