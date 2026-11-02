/** Demo shortcuts used by the "Demo data" menu in the header (mock mode only). */
import { getDb, installBundle, resetDb } from './db';
import { MODEL_MANIFEST, WORKERS } from './fixtures/world';
import { resetJobs } from './jobs';
import { buildReadiness } from './morning';

export function resetDemo(): void {
  resetJobs();
  resetDb();
}

/** Sign in, download the bundle, make the required models ready and mark the device offline-ready. */
export function skipMorning(): void {
  const db = getDb();
  const worker = db.session?.worker ?? WORKERS[0];
  if (!worker) return;
  const stamp = Date.now();
  db.session = {
    worker,
    token: `mock-${worker.id}-${stamp.toString(36)}`,
    issued_at: new Date(stamp).toISOString(),
    expires_at: new Date(stamp + 12 * 3_600_000).toISOString(),
    offline_grant_expires_at: new Date(stamp + 36 * 3_600_000).toISOString(),
    mode: 'online',
  };
  db.offlineGrant = { workerId: worker.id, expiresAt: db.session.offline_grant_expires_at };
  for (const r of MODEL_MANIFEST.requirements) {
    const e = db.engines.find((x) => x.id === r.engine_id);
    if (e && e.availability === 'needs_download') {
      e.availability = 'ready';
      e.availability_reason = null;
      e.loaded = true;
    }
  }
  installBundle(db);
  db.readiness = buildReadiness(db);
}
