/** In-memory job runner for the mock backend. Jobs advance on a timer and are polled through GET /jobs/{id}. */
import type { JobStatus } from '@/api/types';

export interface JobSpec<R> {
  kind: string;
  durationMs: number;
  message?: string;
  /** Result visible from the first poll (e.g. the run id of an evaluation run). */
  initialResult?: R;
  /** Runs on every tick while the job is running (progress is already updated). May update message / result. */
  tick?: (job: JobStatus<R>, progress: number, elapsedMs: number) => void;
  /** Produces the final result. Throwing fails the job with the error message. */
  complete?: (job: JobStatus<R>) => R | null;
  /** Fail the job at this elapsed fraction with this message (simulates e.g. an engine that cannot load). */
  failAt?: { progress: number; error: string };
}

interface Record_ {
  job: JobStatus<unknown>;
  spec: JobSpec<unknown>;
  startedAtMs: number;
}

const TICK_MS = 120;
const jobs = new Map<string, Record_>();
let timer: ReturnType<typeof setInterval> | null = null;
let counter = 0;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isActive = (j: JobStatus): boolean => j.state === 'queued' || j.state === 'running';

function ensureTimer(): void {
  if (timer !== null) return;
  timer = setInterval(tickAll, TICK_MS);
}

function stopTimerIfIdle(): void {
  if (timer === null) return;
  for (const { job } of jobs.values()) if (isActive(job)) return;
  clearInterval(timer);
  timer = null;
}

function step(rec: Record_, nowMs: number): void {
  const { job, spec } = rec;
  if (!isActive(job)) return;
  const elapsed = nowMs - rec.startedAtMs;
  if (job.state === 'queued') {
    job.state = 'running';
    job.started_at = new Date(rec.startedAtMs).toISOString();
  }
  const progress = Math.min(1, Math.max(0, elapsed / spec.durationMs));
  job.progress = progress < 1 ? Math.round(progress * 1000) / 1000 : 1;

  if (spec.failAt && progress >= spec.failAt.progress) {
    job.state = 'failed';
    job.error = spec.failAt.error;
    job.message = spec.failAt.error;
    job.finished_at = new Date(nowMs).toISOString();
    return;
  }
  try {
    spec.tick?.(job, progress, elapsed);
  } catch (error) {
    job.state = 'failed';
    job.error = error instanceof Error ? error.message : String(error);
    job.message = job.error;
    job.finished_at = new Date(nowMs).toISOString();
    return;
  }
  if (progress >= 1) {
    try {
      const result = spec.complete ? spec.complete(job) : null;
      if (result !== null) job.result = result;
      job.state = 'succeeded';
      job.progress = 1;
      if (!job.message || job.message.endsWith('...')) job.message = 'Done';
    } catch (error) {
      job.state = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.message = job.error;
    }
    job.finished_at = new Date(nowMs).toISOString();
  }
}

function tickAll(): void {
  const now = Date.now();
  for (const rec of jobs.values()) step(rec, now);
  stopTimerIfIdle();
}

export function startJob<R>(spec: JobSpec<R>): JobStatus<R> {
  counter += 1;
  const job: JobStatus<R> = {
    id: `job-${String(counter).padStart(4, '0')}`,
    kind: spec.kind,
    state: 'queued',
    progress: 0,
    message: spec.message ?? 'Queued',
    started_at: null,
    finished_at: null,
    result: spec.initialResult ?? null,
    error: null,
  };
  jobs.set(job.id, { job: job as JobStatus<unknown>, spec: spec as JobSpec<unknown>, startedAtMs: Date.now() });
  ensureTimer();
  return clone(job);
}

export function getJob(id: string): JobStatus | undefined {
  const rec = jobs.get(id);
  if (!rec) return undefined;
  // Advance lazily too, so a poll right after a long timer throttle (background tab) still sees fresh state.
  step(rec, Date.now());
  return clone(rec.job);
}

export function listJobs(): JobStatus[] {
  return Array.from(jobs.values())
    .map((r) => clone(r.job))
    .reverse();
}

export function cancelJob(id: string): JobStatus | undefined {
  const rec = jobs.get(id);
  if (!rec) return undefined;
  if (isActive(rec.job)) {
    rec.job.state = 'cancelled';
    rec.job.message = 'Cancelled';
    rec.job.finished_at = new Date().toISOString();
    stopTimerIfIdle();
  }
  return clone(rec.job);
}

/** Test helper: drop all jobs and stop the timer. */
export function resetJobs(): void {
  jobs.clear();
  counter = 0;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
