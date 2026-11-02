import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowPathIcon, CloudArrowUpIcon, SignalSlashIcon, WifiIcon } from '@heroicons/react/24/solid';
import type { OutboxItem, SyncSummary } from '@/api/types';
import { syncApi } from '@/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, PageHeader } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/Feedback';
import { useToast } from '@/components/ui/Toast';
import { ConflictDialog } from '@/components/domain/sync/ConflictDialog';
import { DispatcherConsole } from '@/components/domain/sync/DispatcherConsole';
import { OutboxTable } from '@/components/domain/sync/OutboxTable';
import { invalidateLocalState, qk, useOnline, useOutbox, useSetConnectivity, useSystemStatus, useWorkOrders } from '@/hooks/queries';
import { plural } from '@/lib/format';

function SummaryCard({ summary, onDismiss }: { summary: SyncSummary; onDismiss: () => void }) {
  const tone = summary.conflicts > 0 ? 'warn' : summary.failed > 0 ? 'error' : 'success';
  return (
    <Alert
      tone={tone}
      title={summary.attempted === 0 ? 'Nothing needed sending' : `Sync finished: ${summary.synced} of ${summary.attempted} item${summary.attempted === 1 ? '' : 's'} sent`}
      live
      actions={
        <Button size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      }
    >
      <p className="flex flex-wrap gap-2 pt-1">
        <Badge tone="blue">attempted {summary.attempted}</Badge>
        <Badge tone="green">synced {summary.synced}</Badge>
        <Badge tone={summary.failed > 0 ? 'red' : 'gray'}>failed {summary.failed}</Badge>
        <Badge tone={summary.conflicts > 0 ? 'amber' : 'gray'}>conflicts {summary.conflicts}</Badge>
      </p>
      {summary.failed > 0 ? <p className="mt-2">Failed items stay in the outbox and are retried next time. Retries reuse the same operation id, so they cannot create duplicates.</p> : null}
      {summary.conflicts > 0 ? <p className="mt-2">Conflicting items need a decision: use Resolve in the table below.</p> : null}
    </Alert>
  );
}

export default function SyncPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const { data: status } = useSystemStatus();
  const outbox = useOutbox();
  const workOrders = useWorkOrders();
  const connectivity = useSetConnectivity();
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [resolving, setResolving] = useState<OutboxItem | null>(null);

  const items = outbox.data ?? [];
  const waiting = items.filter((i) => i.state !== 'synced');
  const conflicts = items.filter((i) => i.state === 'conflict');
  const known = new Set((workOrders.data ?? []).map((w) => w.work_order.id));

  const run = useMutation({
    mutationFn: syncApi.run,
    onSuccess: (s) => {
      setSummary(s);
      invalidateLocalState(qc);
      void qc.invalidateQueries({ queryKey: qk.sor });
      void qc.invalidateQueries({ queryKey: qk.outbox });
      if (s.attempted > 0 && s.synced === s.attempted) toast.success('Everything synced', `${s.synced} item${s.synced === 1 ? '' : 's'} reached dispatch.`);
    },
  });

  return (
    <>
      <PageHeader
        eyebrow="Back online"
        title="Sync"
        subtitle="Approved forms and photos wait in the outbox until the device is online, then upload to the system of record. Retries are idempotent and conflicts need a human decision."
        actions={
          <Button
            variant="primary"
            size="lg"
            icon={CloudArrowUpIcon}
            loading={run.isPending}
            disabled={!online || waiting.length === 0}
            title={!online ? 'Offline: switch the device to Online to sync' : waiting.length === 0 ? 'Nothing is waiting to sync' : undefined}
            onClick={() => run.mutate()}
          >
            Sync now
          </Button>
        }
      />

      <div className="space-y-5">
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className={online ? 'flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700' : 'flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-800'}>
                {online ? <WifiIcon className="h-7 w-7" aria-hidden="true" /> : <SignalSlashIcon className="h-7 w-7" aria-hidden="true" />}
              </span>
              <div>
                <p className="text-lg font-semibold text-ink">{online ? 'Online' : 'Offline (airplane mode)'}</p>
                <p className="text-sm text-muted">
                  {online
                    ? waiting.length > 0
                      ? `${plural(waiting.length, 'item')} waiting to sync.`
                      : 'Nothing is waiting to sync.'
                    : `Syncing needs a connection. ${plural(waiting.length, 'item')} will wait in the outbox.`}
                </p>
              </div>
            </div>
            <Button
              icon={online ? SignalSlashIcon : WifiIcon}
              loading={connectivity.isPending}
              onClick={() => connectivity.mutate(!online)}
              title={status ? undefined : 'Waiting for device status'}
            >
              {online ? 'Go offline' : 'Go online'}
            </Button>
          </CardBody>
        </Card>

        {!online && waiting.length > 0 ? (
          <Alert tone="warn" title="Sync is paused" live>
            Switch the device back to Online to send {plural(waiting.length, 'queued item')}. Approving more forms still works offline.
          </Alert>
        ) : null}
        {summary ? <SummaryCard summary={summary} onDismiss={() => setSummary(null)} /> : null}
        {conflicts.length > 0 ? (
          <Alert tone="warn" title={`${plural(conflicts.length, 'conflict')} to resolve`}>
            Dispatch changed {conflicts.length === 1 ? 'a job' : 'jobs'} after you completed {conflicts.length === 1 ? 'it' : 'them'}. Pick Keep mine or Take theirs.
          </Alert>
        ) : null}

        <Card>
          <CardHeader
            title="Outbox"
            subtitle="Every approved completion and photo, newest state first."
            icon={<ArrowPathIcon className="h-6 w-6" aria-hidden="true" />}
            actions={<Badge tone={waiting.length > 0 ? 'amber' : 'green'}>{waiting.length > 0 ? `${waiting.length} waiting` : 'All synced'}</Badge>}
          />
          <CardBody className="!px-0 !py-0">
            {outbox.isLoading ? (
              <LoadingBlock />
            ) : outbox.isError ? (
              <div className="p-4">
                <ErrorState error={outbox.error} onRetry={() => void outbox.refetch()} />
              </div>
            ) : items.length === 0 ? (
              <EmptyState
                title="Nothing queued"
                action={
                  <Link to="/" className={buttonClasses({ variant: 'primary' })}>
                    Open Today's work
                  </Link>
                }
              >
                Approve a form on a job and it will appear here, ready to sync.
              </EmptyState>
            ) : (
              <OutboxTable items={items} knownWorkOrders={known} onResolve={setResolving} />
            )}
          </CardBody>
        </Card>

        <DispatcherConsole />
      </div>

      <ConflictDialog item={resolving} onClose={() => setResolving(null)} />
    </>
  );
}
