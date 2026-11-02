import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExclamationTriangleIcon, PlayIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/solid';
import type { RunStarted, RunSummary } from '@/api/types';
import { errorMessage, evalApi } from '@/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { CheckChip, Field, Input, Select } from '@/components/ui/Controls';
import { Dialog } from '@/components/ui/Dialog';
import { Alert, EmptyState, ErrorState, LoadingBlock, Progress } from '@/components/ui/Feedback';
import { Table, Td, Th, Tr } from '@/components/ui/Table';
import { useToast } from '@/components/ui/Toast';
import { RunStatusBadge } from '@/components/domain/StatusBadges';
import { ComboBuilder, EMPTY_SELECTION, type ComboSelection } from '@/components/domain/ComboBuilder';
import { qk, useDatasets, useEngines, useJob, useRuns } from '@/hooks/queries';
import { buildPreset, expandCombos } from '@/lib/combos';
import { fmtDateTime, plural, relTime } from '@/lib/format';
import { isLatencyTargetProfile } from '@/lib/hardware';

function RunProgress({ jobId, onDone }: { jobId: string; onDone: (runId: string | null, status: string) => void }) {
  const job = useJob<RunStarted>(jobId, 700);
  const runId = job.data?.result?.run_id ?? null;
  const run = useQuery({
    queryKey: qk.run(runId ?? ''),
    queryFn: () => evalApi.run(runId as string),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 800 : false),
  });
  const status = run.data?.status ?? (job.data?.state === 'succeeded' ? 'succeeded' : job.data?.state === 'failed' ? 'failed' : job.data?.state === 'cancelled' ? 'cancelled' : 'running');
  const done = useRef(false);
  useEffect(() => {
    if (status !== 'running' && !done.current && (run.data || job.data?.state === 'failed' || job.data?.state === 'cancelled')) {
      done.current = true;
      onDone(runId, status);
    }
  }, [status, run.data, job.data?.state, runId, onDone]);
  return (
    <div className="space-y-1" aria-live="polite">
      <Progress value={run.data?.progress ?? job.data?.progress ?? 0} label={job.data?.message || 'Starting the run...'} />
      {runId ? <p className="font-mono text-xs text-muted">{runId}</p> : null}
    </div>
  );
}

function NewRunCard({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const engines = useEngines();
  const datasets = useDatasets();
  const [datasetId, setDatasetId] = useState('');
  const [label, setLabel] = useState('');
  const [selection, setSelection] = useState<ComboSelection>(EMPTY_SELECTION);
  const [limit, setLimit] = useState('');
  const [repeats, setRepeats] = useState(1);
  const [warmup, setWarmup] = useState(1);
  const [splits, setSplits] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [threshold, setThreshold] = useState(0.8);
  const [jobId, setJobId] = useState<string | null>(null);

  const list = datasets.data ?? [];
  useEffect(() => {
    if (!list.some((d) => d.id === datasetId) && list[0]) setDatasetId(list[0].id);
  }, [list, datasetId]);
  const dataset = list.find((d) => d.id === datasetId);

  const seeded = useRef(false);
  useEffect(() => {
    if (!engines.data || seeded.current) return;
    seeded.current = true;
    const p = buildPreset('baseline_vs_hybrid', engines.data);
    setSelection({ stt: p.stt, llm: p.llm, strategies: p.strategies });
  }, [engines.data]);
  const { combos } = useMemo(() => expandCombos(selection.stt, selection.llm, selection.strategies), [selection]);

  const start = useMutation({
    mutationFn: () =>
      evalApi.createRun({
        dataset_id: datasetId,
        configs: combos,
        limit: limit.trim() ? Math.max(1, Math.floor(Number(limit))) : null,
        splits: splits.length > 0 ? splits : null,
        tags: tags.length > 0 ? tags : null,
        repeats,
        warmup,
        confidence_threshold: threshold,
        label: label.trim() || null,
      }),
    onSuccess: (job) => setJobId(job.id),
  });

  const onDone = useMemo(
    () => (runId: string | null, status: string) => {
      setJobId(null);
      void qc.invalidateQueries({ queryKey: qk.runs });
      if (status === 'succeeded' && runId) {
        toast.success('Run finished', 'Opening the results.');
        onClose();
        navigate(`/results/runs/${encodeURIComponent(runId)}`);
      } else toast.error('The run did not finish', `Status: ${status}`);
    },
    [qc, toast, navigate, onClose],
  );

  const running = start.isPending || jobId !== null;
  const tagNames = Object.keys(dataset?.tag_counts ?? {}).sort();

  return (
    <Card>
      <CardHeader
        title="New evaluation run"
        subtitle="Every configuration is run over the selected cases; latency is measured on this machine."
        icon={<PlayIcon className="h-6 w-6" aria-hidden="true" />}
        actions={
          <Button variant="ghost" onClick={onClose} disabled={running}>
            Close
          </Button>
        }
      />
      <CardBody className="space-y-5">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Dataset">
            {(p) => (
              <Select {...p} value={datasetId} onChange={(e) => setDatasetId(e.target.value)} disabled={list.length === 0}>
                {list.length === 0 ? <option value="">No datasets: generate one first</option> : null}
                {list.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.n_cases} cases, {d.n_with_audio} with audio)
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Label (optional)">{(p) => <Input {...p} value={label} placeholder="e.g. Strategy ladder, 0.5B-3.8B" onChange={(e) => setLabel(e.target.value)} />}</Field>
        </div>

        {engines.data ? <ComboBuilder engines={engines.data} value={selection} onChange={setSelection} /> : <LoadingBlock label="Loading engines..." />}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Case limit" hint="First N cases after filters; empty = all.">
            {(p) => <Input {...p} type="number" inputMode="numeric" min={1} value={limit} placeholder="all" onChange={(e) => setLimit(e.target.value)} />}
          </Field>
          <Field label="Repeats" hint="Repeat the case set to steady the latency percentiles.">
            {(p) => <Input {...p} type="number" inputMode="numeric" min={1} max={10} value={repeats} onChange={(e) => setRepeats(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />}
          </Field>
          <Field label="Warm-up cases" hint="Untimed, per configuration.">
            {(p) => <Input {...p} type="number" inputMode="numeric" min={0} value={warmup} onChange={(e) => setWarmup(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />}
          </Field>
          <Field label={`Confidence threshold: ${threshold.toFixed(2)}`} hint='Fields at or above it (and "filled") count as confident.'>
            {(p) => <input {...p} type="range" min={0.5} max={0.99} step={0.01} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="h-tap w-full accent-brand-600" />}
          </Field>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <fieldset>
            <legend className="mb-1.5 text-sm font-semibold text-ink">Splits (none ticked = all)</legend>
            <div className="flex flex-wrap gap-2">
              {['dev', 'heldout'].map((s) => (
                <CheckChip key={s} checked={splits.includes(s)} onChange={(on) => setSplits((cur) => (on ? [...cur, s] : cur.filter((x) => x !== s)))}>
                  {s === 'heldout' ? 'Held-out' : 'Dev'}
                </CheckChip>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-1.5 text-sm font-semibold text-ink">Only cases tagged (any of; none = all)</legend>
            <div className="flex flex-wrap gap-2">
              {tagNames.map((t) => (
                <CheckChip key={t} checked={tags.includes(t)} onChange={(on) => setTags((cur) => (on ? [...cur, t] : cur.filter((x) => x !== t)))}>
                  {t}
                </CheckChip>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" icon={PlayIcon} loading={running} disabled={!datasetId || combos.length === 0} onClick={() => start.mutate()}>
            Start run ({plural(combos.length, 'configuration')})
          </Button>
          {start.isError ? <span className="text-sm font-medium text-red-700">{errorMessage(start.error)}</span> : null}
        </div>
        {jobId ? <RunProgress jobId={jobId} onDone={onDone} /> : null}
      </CardBody>
    </Card>
  );
}

function RunRow({ run, onDelete }: { run: RunSummary; onDelete: (run: RunSummary) => void }) {
  const navigate = useNavigate();
  const representative = isLatencyTargetProfile(run.hardware.device_profile);
  const open = () => navigate(`/results/runs/${encodeURIComponent(run.run_id)}`);
  return (
    <Tr onClick={open} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open()}>
      <Td>
        <p className="font-semibold text-ink">{run.label ?? run.run_id}</p>
        <p className="font-mono text-xs text-muted">{run.run_id}</p>
      </Td>
      <Td className="whitespace-nowrap">{run.dataset_id}</Td>
      <Td className="whitespace-nowrap text-muted" title={fmtDateTime(run.created_at)}>
        {relTime(run.created_at)}
      </Td>
      <Td className="min-w-[9rem]">
        <RunStatusBadge status={run.status} />
        {run.status === 'running' ? <Progress className="mt-1.5" size="sm" value={run.progress} /> : null}
      </Td>
      <Td align="right">{run.status === 'running' ? '-' : run.configs.length}</Td>
      <Td>
        <Badge tone={representative ? 'green' : 'amber'} icon={representative ? undefined : ExclamationTriangleIcon} size="sm" title={representative ? 'Latency-target device' : 'Not the latency-target device: rank options only'}>
          {run.hardware.device_profile}
        </Badge>
      </Td>
      <Td align="right">
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Link to={`/results/runs/${encodeURIComponent(run.run_id)}`} className={buttonClasses({ size: 'sm', variant: 'secondary' })}>
            Open
          </Link>
          <Button size="sm" variant="ghost" icon={TrashIcon} aria-label={`Delete ${run.label ?? run.run_id}`} onClick={() => onDelete(run)} />
        </div>
      </Td>
    </Tr>
  );
}

export default function RunsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const runs = useRuns();
  const [showNew, setShowNew] = useState(false);
  const [deleting, setDeleting] = useState<RunSummary | null>(null);
  const list = runs.data ?? [];

  const remove = useMutation({
    mutationFn: (id: string) => evalApi.deleteRun(id),
    onSuccess: () => {
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: qk.runs });
      toast.success('Run deleted');
    },
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{plural(list.length, 'run')} on this machine.</p>
        {!showNew ? (
          <Button variant="primary" icon={PlusIcon} onClick={() => setShowNew(true)}>
            New run
          </Button>
        ) : null}
      </div>
      {showNew ? <NewRunCard onClose={() => setShowNew(false)} /> : null}
      <Card>
        <CardBody className="!px-0 !py-0">
          {runs.isLoading ? <LoadingBlock /> : null}
          {runs.isError ? <div className="p-4"><ErrorState error={runs.error} onRetry={() => void runs.refetch()} /></div> : null}
          {!runs.isLoading && !runs.isError && list.length === 0 ? <EmptyState title="No runs yet">Start a new run to compare speech engines, models and strategies.</EmptyState> : null}
          {list.length > 0 ? (
            <Table aria-label="Evaluation runs">
              <thead>
                <tr>
                  <Th>Run</Th>
                  <Th>Dataset</Th>
                  <Th>Started</Th>
                  <Th>Status</Th>
                  <Th align="right">Configs</Th>
                  <Th>Hardware profile</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <RunRow key={r.run_id} run={r} onDelete={setDeleting} />
                ))}
              </tbody>
            </Table>
          ) : null}
        </CardBody>
      </Card>

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this run?"
        size="sm"
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => deleting && remove.mutate(deleting.run_id)}>
              Delete
            </Button>
          </>
        }
      >
        <Alert tone="warn">
          {deleting?.label ?? deleting?.run_id} and its per-case results will be removed from this machine.
        </Alert>
      </Dialog>
    </div>
  );
}
