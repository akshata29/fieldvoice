import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowPathIcon, BoltIcon, BuildingOffice2Icon, TrashIcon } from '@heroicons/react/24/outline';
import type { SorFaults, WorkOrder } from '@/api/types';
import { sorApi } from '@/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/Controls';
import { Dialog } from '@/components/ui/Dialog';
import { Alert, ErrorState, LoadingBlock } from '@/components/ui/Feedback';
import { Table, Td, Th, Tr } from '@/components/ui/Table';
import { useToast } from '@/components/ui/Toast';
import { WorkOrderStatusBadge } from '@/components/domain/StatusBadges';
import { JsonView } from '@/components/domain/JsonView';
import { invalidateLocalState, qk, useSorState } from '@/hooks/queries';
import { plural } from '@/lib/format';

type FaultKey = keyof SorFaults;

const FAULT_CONTROLS: Array<{ key: FaultKey; label: string; unit: string; help: string }> = [
  { key: 'fail_next', label: 'Fail next requests', unit: 'requests', help: 'The next N requests get a 503 before the server does any work. A retry should simply succeed.' },
  { key: 'latency_ms', label: 'Added latency', unit: 'ms', help: 'Delays every request, to see how the device behaves on a slow link.' },
  { key: 'drop_response_next', label: 'Drop response next', unit: 'completions', help: 'The server commits the completion but the reply is lost (504). A retry must not create a duplicate.' },
  { key: 'conflict_next', label: 'Conflict next', unit: 'completions', help: 'The next N completions are rejected with 409, as if dispatch had changed the job in the meantime.' },
];

const toInt = (v: string): number => Math.max(0, Math.floor(Number(v) || 0));

function FaultsEditor({ faults }: { faults: SorFaults }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<Record<FaultKey, string>>(() => ({
    fail_next: String(faults.fail_next),
    latency_ms: String(faults.latency_ms),
    drop_response_next: String(faults.drop_response_next),
    conflict_next: String(faults.conflict_next),
  }));
  const [dirty, setDirty] = useState(false);

  // while the user is not editing, mirror the server: counters tick down as faults get used up
  useEffect(() => {
    if (dirty) return;
    setForm({
      fail_next: String(faults.fail_next),
      latency_ms: String(faults.latency_ms),
      drop_response_next: String(faults.drop_response_next),
      conflict_next: String(faults.conflict_next),
    });
  }, [faults, dirty]);

  const apply = useMutation({
    mutationFn: (next: SorFaults) => sorApi.setFaults(next),
    onSuccess: () => {
      setDirty(false);
      void qc.invalidateQueries({ queryKey: qk.sor });
      toast.success('Fault injection updated');
    },
  });

  const active = (Object.keys(form) as FaultKey[]).filter((k) => faults[k] > 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-base font-semibold text-ink">
          <BoltIcon className="h-5 w-5 text-amber-600" aria-hidden="true" /> Fault injection
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {active.length === 0 ? <Badge tone="green">No faults armed</Badge> : active.map((k) => <Badge key={k} tone="amber">{k.replace(/_/g, ' ')}: {faults[k]}</Badge>)}
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {FAULT_CONTROLS.map((c) => (
          <Field key={c.key} label={c.label} hint={c.help}>
            {(props) => (
              <div className="flex items-center gap-2">
                <Input
                  {...props}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={form[c.key]}
                  className="font-mono tabular-nums"
                  onChange={(e) => {
                    setDirty(true);
                    setForm((f) => ({ ...f, [c.key]: e.target.value }));
                  }}
                />
                <span className="w-20 shrink-0 text-xs text-muted">{c.unit}</span>
              </div>
            )}
          </Field>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          loading={apply.isPending}
          onClick={() => apply.mutate({ fail_next: toInt(form.fail_next), latency_ms: toInt(form.latency_ms), drop_response_next: toInt(form.drop_response_next), conflict_next: toInt(form.conflict_next) })}
        >
          Apply faults
        </Button>
        <Button
          disabled={apply.isPending}
          onClick={() => {
            setDirty(false);
            apply.mutate({ fail_next: 0, latency_ms: 0, drop_response_next: 0, conflict_next: 0 });
          }}
        >
          Clear all
        </Button>
      </div>
    </div>
  );
}

export function DispatcherConsole() {
  const sor = useSorState();
  const qc = useQueryClient();
  const toast = useToast();
  const [bumping, setBumping] = useState<WorkOrder | null>(null);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [wipeDevice, setWipeDevice] = useState(false);

  const bump = useMutation({
    mutationFn: (id: string) => sorApi.bump(id, { title: title.trim() || null, note: note.trim() || null }),
    onSuccess: (wo) => {
      setBumping(null);
      setTitle('');
      setNote('');
      void qc.invalidateQueries({ queryKey: qk.sor });
      toast.success(`${wo.id} is now version ${wo.version}`, 'A completion based on the older version will hit a conflict on the next sync.');
    },
  });

  const reset = useMutation({
    mutationFn: (device: boolean) => sorApi.reset({ device }),
    onSuccess: (_data, device) => {
      setConfirmReset(false);
      setWipeDevice(false);
      invalidateLocalState(qc);
      void qc.invalidateQueries({ queryKey: qk.sor });
      toast.success(
        device ? 'System of record and device reset' : 'System of record reset',
        device ? 'Sign in again from the Morning screen to start a clean take.' : 'Work-order versions, received completions and faults were cleared.',
      );
    },
  });

  return (
    <Card>
      <CardHeader
        title="Dispatcher console"
        subtitle="The remote world (system of record). Always reachable, even when this device is in airplane mode."
        icon={<BuildingOffice2Icon className="h-6 w-6" aria-hidden="true" />}
        actions={
          <Button size="sm" variant="ghost" icon={ArrowPathIcon} onClick={() => void sor.refetch()} loading={sor.isFetching && !sor.isLoading}>
            Refresh
          </Button>
        }
      />
      <CardBody className="space-y-6">
        {sor.isLoading ? <LoadingBlock label="Reaching the system of record..." /> : null}
        {sor.isError ? <ErrorState error={sor.error} onRetry={() => void sor.refetch()} title="The dispatcher console is not responding" /> : null}
        {sor.data ? (
          <>
            <div className="space-y-2">
              <h3 className="text-base font-semibold text-ink">Work orders at dispatch</h3>
              <p className="text-sm text-muted">"Bump version" simulates dispatch editing a job after the worker downloaded it. A completion that was based on the old version then conflicts.</p>
              <Table aria-label="System-of-record work orders">
                <thead>
                  <tr>
                    <Th>Id</Th>
                    <Th>Title</Th>
                    <Th align="right">Version</Th>
                    <Th>Status</Th>
                    <Th>
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {sor.data.work_orders.map((w) => (
                    <Tr key={w.id}>
                      <Td className="whitespace-nowrap font-mono text-sm">{w.id}</Td>
                      <Td className="min-w-[12rem] text-ink">{w.title}</Td>
                      <Td align="right" className="font-mono font-semibold">
                        v{w.version}
                      </Td>
                      <Td>
                        <WorkOrderStatusBadge status={w.status} />
                      </Td>
                      <Td align="right">
                        <Button size="sm" onClick={() => setBumping(w)}>
                          Bump version
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>

            <FaultsEditor faults={sor.data.faults} />

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-semibold text-ink">
                  Received at dispatch <span className="font-normal text-muted">({plural(sor.data.completions.length, 'completion')}, {plural(sor.data.photos, 'photo')})</span>
                </h3>
                <Button size="sm" variant="danger" icon={TrashIcon} onClick={() => setConfirmReset(true)}>
                  Reset system of record
                </Button>
              </div>
              {sor.data.completions.length === 0 ? <p className="text-sm text-muted">Nothing received yet. Approve a form and sync.</p> : <JsonView value={sor.data.completions} />}
            </div>
          </>
        ) : null}
      </CardBody>

      <Dialog
        open={bumping !== null}
        onClose={() => setBumping(null)}
        title={`Bump ${bumping?.id ?? ''}`}
        description={bumping ? `Currently version ${bumping.version}. Optionally change the title or add a dispatcher note.` : undefined}
        size="sm"
        footer={
          <>
            <Button onClick={() => setBumping(null)}>Cancel</Button>
            <Button variant="primary" loading={bump.isPending} onClick={() => bumping && bump.mutate(bumping.id)}>
              Bump to v{(bumping?.version ?? 0) + 1}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="New title (optional)">{(props) => <Input {...props} value={title} placeholder={bumping?.title} onChange={(e) => setTitle(e.target.value)} />}</Field>
          <Field label="Dispatcher note (optional)">{(props) => <Textarea {...props} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Customer called back: access gate code changed." />}</Field>
        </div>
      </Dialog>

      <Dialog
        open={confirmReset}
        onClose={() => {
          setConfirmReset(false);
          setWipeDevice(false);
        }}
        title="Reset the system of record?"
        size="sm"
        footer={
          <>
            <Button
              onClick={() => {
                setConfirmReset(false);
                setWipeDevice(false);
              }}
            >
              Cancel
            </Button>
            <Button variant="danger" loading={reset.isPending} onClick={() => reset.mutate(wipeDevice)}>
              Reset
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Alert tone="warn">This clears received completions and photos, restores the original work-order versions and removes armed faults.</Alert>
          <Checkbox
            checked={wipeDevice}
            onChange={setWipeDevice}
            label="Also wipe this device"
            description="Signs the worker out and removes the downloaded work, drafts, outbox and photos: a clean take from the Morning screen. Downloaded models stay."
          />
        </div>
      </Dialog>
    </Card>
  );
}
