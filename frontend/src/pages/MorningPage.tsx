import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRightOnRectangleIcon,
  CheckCircleIcon,
  CloudArrowDownIcon,
  ExclamationTriangleIcon,
  MinusCircleIcon,
  PlayIcon,
  ShieldCheckIcon,
  SignalSlashIcon,
  UserCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/solid';
import type { AuthSession, MorningResult, MorningStep, ReadinessReport, Worker } from '@/api/types';
import { authApi, bundleApi, isApiError, morningApi, readinessApi } from '@/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, KeyValue, PageHeader } from '@/components/ui/Card';
import { Alert, ErrorState, LoadingBlock, Progress, Spinner } from '@/components/ui/Feedback';
import { Table, Td, Th, Tr } from '@/components/ui/Table';
import { useToast } from '@/components/ui/Toast';
import { DemoTag } from '@/components/domain/DemoTag';
import { PinPad } from '@/components/domain/PinPad';
import { ReadinessStatusBadge } from '@/components/domain/StatusBadges';
import { invalidateLocalState, qk, useBundle, useJob, useOnline, useReadiness, useSetConnectivity, useSystemStatus, useWorkers } from '@/hooks/queries';
import { cn } from '@/lib/cn';
import { fmtDateTime, fmtMs, initials, plural } from '@/lib/format';
import { USE_MOCKS } from '@/lib/env';

const STEP_LABELS: Array<Pick<MorningStep, 'id' | 'label'>> = [
  { id: 'authenticate', label: 'Authenticate' },
  { id: 'download_bundle', label: "Download today's work orders, forms and knowledge base" },
  { id: 'sync_reference', label: 'Sync reference data (assets and stock inventory)' },
  { id: 'ensure_models', label: 'Make sure the local AI models are present' },
  { id: 'readiness', label: 'Self-test and readiness checks' },
];

const pendingSteps = (): MorningStep[] => STEP_LABELS.map((s) => ({ ...s, status: 'pending', detail: '', duration_ms: null }));

function StepIcon({ status }: { status: MorningStep['status'] }) {
  switch (status) {
    case 'pass':
      return <CheckCircleIcon className="h-7 w-7 text-emerald-600" aria-label="done" />;
    case 'warn':
      return <ExclamationTriangleIcon className="h-7 w-7 text-amber-500" aria-label="warning" />;
    case 'fail':
      return <XCircleIcon className="h-7 w-7 text-red-600" aria-label="failed" />;
    case 'running':
      return <Spinner className="h-7 w-7 text-brand-600" label="running" />;
    default:
      return <MinusCircleIcon className="h-7 w-7 text-slate-300" aria-label="waiting" />;
  }
}

function StepList({ steps }: { steps: MorningStep[] }) {
  return (
    <ol className="space-y-1" aria-label="Morning steps" aria-live="polite">
      {steps.map((s, i) => {
        const pct = s.status === 'running' ? /(\d{1,3})\s*%/.exec(s.detail)?.[1] : undefined;
        return (
          <li key={s.id} className={cn('flex gap-3 rounded-xl px-3 py-3', s.status === 'running' && 'bg-brand-50 field:border-2 field:border-black')}>
            <div className="mt-0.5 shrink-0">
              <StepIcon status={s.status} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className={cn('text-base font-semibold', s.status === 'pending' ? 'text-muted' : 'text-ink')}>
                  <span className="mr-2 text-sm font-medium text-muted">{i + 1}.</span>
                  {s.label}
                </p>
                {s.duration_ms !== null ? (
                  <span className="flex items-center gap-1.5 text-xs tabular-nums text-muted">
                    {fmtMs(s.duration_ms)} <DemoTag />
                  </span>
                ) : null}
              </div>
              {s.detail ? <p className="text-sm text-muted">{s.detail}</p> : null}
              {pct !== undefined ? <Progress className="mt-2" value={Number(pct) / 100} size="sm" label="Model download" /> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function ReadinessTable({ report }: { report: ReadinessReport }) {
  return (
    <Table aria-label="Readiness checks">
      <thead>
        <tr>
          <Th>Check</Th>
          <Th>Status</Th>
          <Th>Detail</Th>
          <Th align="right">Time</Th>
        </tr>
      </thead>
      <tbody>
        {report.checks.map((c) => (
          <Tr key={c.id}>
            <Td className="font-medium text-ink">{c.label}</Td>
            <Td>
              <ReadinessStatusBadge status={c.status} />
            </Td>
            <Td className="text-muted">{c.detail}</Td>
            <Td align="right" className="whitespace-nowrap text-muted">
              {c.duration_ms !== null ? fmtMs(c.duration_ms) : '-'}
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

function OfflineRules({ highlight }: { highlight?: boolean }) {
  return (
    <Alert tone={highlight ? 'warn' : 'info'} title="Signing in while offline">
      <ul className="mt-1 list-disc space-y-1 pl-5">
        <li>You can unlock the app offline with your PIN only if you already signed in <strong>on this device while connected</strong>; that stores an offline grant.</li>
        <li>The grant is for the same worker only, and it expires (the date is shown once you are signed in).</li>
        <li>If there is no grant, switch the device to Online, sign in, and run Start my day. Then you can go offline.</li>
      </ul>
    </Alert>
  );
}

function WorkerPicker({ workers, selected, onSelect }: { workers: Worker[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Who is working today?" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
      {workers.map((w) => {
        const on = w.id === selected;
        return (
          <button
            key={w.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onSelect(w.id)}
            className={cn(
              'flex min-h-[4.25rem] items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300',
              on ? 'border-brand-600 bg-brand-50 ring-2 ring-brand-600 field:border-black field:ring-black' : 'border-line bg-surface hover:bg-slate-50 field:border-2',
            )}
          >
            <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-bold', on ? 'bg-brand-600 text-white' : 'bg-slate-200 text-slate-700')}>{initials(w.name)}</span>
            <span className="min-w-0">
              <span className="block truncate text-base font-semibold text-ink">{w.name}</span>
              <span className="block truncate text-xs text-muted">
                {w.role} - crew {w.crew}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SignInCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const { data: status } = useSystemStatus();
  const workers = useWorkers();
  const [workerId, setWorkerId] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const session = status?.session ?? null;

  const login = useMutation({
    mutationFn: () => authApi.login({ worker_id: workerId as string, pin }),
    meta: { silent: true },
    onSuccess: (s: AuthSession) => {
      setPin('');
      invalidateLocalState(qc);
      void qc.invalidateQueries({ queryKey: qk.session });
      toast.success(`Signed in as ${s.worker.name}`, s.mode === 'offline_unlock' ? 'Unlocked offline with the stored grant.' : 'Offline grant stored on this device.');
    },
    onError: () => setPin(''),
  });
  const logout = useMutation({
    mutationFn: authApi.logout,
    onSuccess: () => {
      invalidateLocalState(qc);
      void qc.invalidateQueries({ queryKey: qk.session });
    },
  });

  if (session) {
    return (
      <Card>
        <CardHeader title="1. Signed in" icon={<UserCircleIcon className="h-6 w-6" aria-hidden="true" />} />
        <CardBody className="space-y-4">
          <div className="flex items-center gap-4">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-lg font-bold text-white">{initials(session.worker.name)}</span>
            <div className="min-w-0">
              <p className="text-lg font-semibold text-ink">{session.worker.name}</p>
              <p className="text-sm text-muted">
                {session.worker.role} - crew {session.worker.crew}
              </p>
            </div>
          </div>
          <KeyValue
            items={[
              ['Sign-in mode', <Badge key="m" tone={session.mode === 'online' ? 'green' : 'amber'}>{session.mode === 'online' ? 'Online' : 'Offline unlock'}</Badge>],
              ['Session until', fmtDateTime(session.expires_at)],
              ['PIN works offline until', fmtDateTime(session.offline_grant_expires_at)],
            ]}
          />
          <Button icon={ArrowRightOnRectangleIcon} loading={logout.isPending} onClick={() => logout.mutate()}>
            Sign out / switch worker
          </Button>
        </CardBody>
      </Card>
    );
  }

  const error = login.error;
  const offlineError = isApiError(error) && error.code === 'offline';
  const wrongPin = isApiError(error) && error.code === 'invalid_pin';

  return (
    <Card>
      <CardHeader title="1. Sign in" subtitle="Pick your name, then enter your PIN." icon={<UserCircleIcon className="h-6 w-6" aria-hidden="true" />} />
      <CardBody className="space-y-4">
        {!online && !offlineError ? <OfflineRules /> : null}
        {workers.isLoading ? <LoadingBlock label="Loading workers..." /> : null}
        {workers.isError ? <ErrorState error={workers.error} onRetry={() => void workers.refetch()} /> : null}
        {workers.data ? <WorkerPicker workers={workers.data} selected={workerId} onSelect={setWorkerId} /> : null}

        {workerId ? (
          <div className="space-y-3 border-t border-line/70 pt-4">
            <PinPad value={pin} onChange={setPin} disabled={login.isPending} invalid={wrongPin} onSubmit={() => pin && login.mutate()} />
            {wrongPin ? (
              <p className="text-center text-sm font-semibold text-red-700" role="alert">
                That PIN is not correct. Try again.
              </p>
            ) : null}
            {USE_MOCKS ? <p className="text-center text-xs text-fuchsia-800">Demo PIN: 1234 (mock mode)</p> : null}
            <Button variant="primary" size="lg" fullWidth loading={login.isPending} disabled={pin.length === 0} onClick={() => login.mutate()}>
              Sign in
            </Button>
            {offlineError ? (
              <div className="space-y-3">
                <Alert tone="warn" title="Cannot sign in while offline" live>
                  {error.message}
                </Alert>
                <OfflineRules highlight />
              </div>
            ) : null}
            {isApiError(error) && !offlineError && !wrongPin ? (
              <Alert tone="error" live>
                {error.message}
              </Alert>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted">Select your name to continue.</p>
        )}
      </CardBody>
    </Card>
  );
}

function StartDayCard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const { data: status } = useSystemStatus();
  const bundle = useBundle();
  const storedReadiness = useReadiness();
  const goOffline = useSetConnectivity();
  const session = status?.session ?? null;

  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob<MorningResult>(jobId, 600);
  const finished = useRef<string | null>(null);

  const start = useMutation({
    mutationFn: morningApi.start,
    onSuccess: (j) => {
      finished.current = null;
      setJobId(j.id);
    },
  });

  const state = job.data?.state;
  useEffect(() => {
    if (!jobId || !state || (state !== 'succeeded' && state !== 'failed' && state !== 'cancelled') || finished.current === jobId) return;
    finished.current = jobId;
    invalidateLocalState(qc);
    for (const key of [qk.bundle, qk.readiness, qk.engines, qk.session]) void qc.invalidateQueries({ queryKey: key });
    if (state === 'succeeded') toast.success('Morning prep finished', 'Review the checks below, then go offline.');
  }, [jobId, state, qc, toast]);

  // A sign-out invalidates the job's premise; start fresh.
  useEffect(() => {
    if (!session) setJobId(null);
  }, [session]);

  const result = job.data?.result ?? null;
  const steps = result?.steps ?? pendingSteps();
  const running = start.isPending || state === 'queued' || state === 'running';
  const report = result?.readiness ?? (jobId ? null : (storedReadiness.data ?? null));
  const ready = result ? result.ready_to_go_offline : !jobId && !!report && report.overall !== 'fail';
  const failed = state === 'failed' || state === 'cancelled';

  const bundleSync = useMutation({ mutationFn: bundleApi.sync });
  const readinessRun = useMutation({ mutationFn: readinessApi.run });
  const [auxJob, setAuxJob] = useState<string | null>(null);
  const aux = useJob(auxJob, 500);
  const auxState = aux.data?.state;
  useEffect(() => {
    if (auxState === 'succeeded' || auxState === 'failed') {
      for (const key of [qk.bundle, qk.readiness, qk.status, qk.workOrders]) void qc.invalidateQueries({ queryKey: key });
      if (auxState === 'failed') toast.error('That did not finish', aux.data?.error ?? undefined);
      setAuxJob(null);
    }
  }, [auxState, aux.data?.error, qc, toast]);

  const b = bundle.data;

  return (
    <Card>
      <CardHeader
        title="2. Start my day"
        subtitle="Downloads today's work and makes sure this device can work without a connection."
        icon={<CloudArrowDownIcon className="h-6 w-6" aria-hidden="true" />}
      />
      <CardBody className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" icon={PlayIcon} loading={running} disabled={!session || !online} onClick={() => start.mutate()}>
            {jobId && !running ? 'Run it again' : 'Start my day'}
          </Button>
          {!session ? <span className="text-sm text-muted">Sign in first.</span> : !online ? <span className="text-sm font-medium text-amber-800">You are offline: downloads need a connection. Switch to Online.</span> : null}
        </div>

        {jobId || running ? (
          <div className="space-y-3">
            <Progress value={job.data?.progress ?? 0} label={job.data?.message || 'Starting...'} tone={failed ? 'red' : 'brand'} />
            <StepList steps={steps} />
          </div>
        ) : (
          <StepList steps={steps} />
        )}

        {failed ? (
          <Alert tone="error" title="Morning prep did not finish" live>
            {job.data?.error ?? 'The job was cancelled.'}
          </Alert>
        ) : null}
        {start.isError && isApiError(start.error) && start.error.code === 'offline' ? <OfflineRules highlight /> : null}

        {report ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-base font-semibold text-ink">
                <ShieldCheckIcon className="h-5 w-5 text-brand-600" aria-hidden="true" /> Readiness
                <ReadinessStatusBadge status={report.overall} />
              </h3>
              <Button size="sm" loading={readinessRun.isPending || (auxJob !== null && aux.data?.kind === 'readiness')} disabled={!session || running} onClick={() => readinessRun.mutate(undefined, { onSuccess: (j) => setAuxJob(j.id) })}>
                Re-run checks
              </Button>
            </div>
            <ReadinessTable report={report} />
          </div>
        ) : null}

        <div className={cn('rounded-2xl border-2 p-4', ready ? 'border-emerald-500 bg-emerald-50 field:bg-white field:border-black' : 'border-dashed border-line bg-surface-2')}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-lg font-bold text-ink">
                <SignalSlashIcon className="h-6 w-6" aria-hidden="true" /> Ready to go offline?
              </p>
              <p className="text-sm text-muted">
                {ready
                  ? report?.overall === 'warn'
                    ? 'Everything essential is in place (see the warnings above).'
                    : 'Work orders, procedures and models are on this device.'
                  : running
                    ? 'Waiting for the checks to finish...'
                    : 'Run the checks first: Start my day.'}
              </p>
            </div>
            <Button
              variant="success"
              size="lg"
              icon={SignalSlashIcon}
              disabled={!ready || !online || running}
              loading={goOffline.isPending}
              onClick={() =>
                goOffline.mutate(false, {
                  onSuccess: () => {
                    toast.info('You are offline', 'Working from local data.');
                    navigate('/');
                  },
                })
              }
            >
              Go offline
            </Button>
          </div>
          {!online ? <p className="mt-2 text-sm font-medium text-emerald-800">This device is already offline.</p> : null}
        </div>

        {b ? (
          <div className="rounded-xl border border-line bg-surface-2 p-4 field:border-2">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-ink">Downloaded bundle</h3>
              <Button size="sm" icon={CloudArrowDownIcon} disabled={!session || !online || running} loading={bundleSync.isPending} onClick={() => bundleSync.mutate(undefined, { onSuccess: (j) => setAuxJob(j.id) })}>
                Re-sync bundle
              </Button>
            </div>
            <KeyValue
              items={[
                ['Contents', `${plural(b.n_work_orders, 'work order')}, ${plural(b.n_forms, 'form')}, ${plural(b.n_assets, 'asset')}, ${plural(b.n_kb_docs, 'document')}`],
                ['Issued', fmtDateTime(b.issued_at)],
                ['Valid until', fmtDateTime(b.expires_at)],
                ['Content hash', <code key="h" className="break-all text-xs">{b.content_hash}</code>],
              ]}
            />
            {auxJob && aux.data ? <Progress className="mt-3" value={aux.data.progress} label={aux.data.message} size="sm" /> : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

export default function MorningPage() {
  const { isLoading, isError, error, refetch } = useSystemStatus();
  return (
    <>
      <PageHeader
        eyebrow="Connected"
        title="Morning prep"
        subtitle="Sign in, download today's work, make sure the AI models are ready, then go offline for the day."
      />
      {isLoading ? (
        <LoadingBlock label="Checking the device..." />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => void refetch()} title="Cannot reach the backend" />
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] xl:items-start">
          <SignInCard />
          <StartDayCard />
        </div>
      )}
    </>
  );
}
