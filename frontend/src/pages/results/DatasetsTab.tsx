import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleStackIcon, SparklesIcon } from '@heroicons/react/24/outline';
import type { EvalCase, EvalDatasetInfo, DatasetGenerateRequest, DatasetBuildJob } from '@/api/types';
import { evalApi } from '@/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Checkbox, Field, Input, Select } from '@/components/ui/Controls';
import { Alert, EmptyState, ErrorState, LoadingBlock, Progress } from '@/components/ui/Feedback';
import { Table, Td, Th, Tr } from '@/components/ui/Table';
import { useToast } from '@/components/ui/Toast';
import { qk, useDatasets, useJob } from '@/hooks/queries';
import { cn } from '@/lib/cn';
import { fmtDateTime, plural, titleCase } from '@/lib/format';

const PAGE = 15;

function GenerateCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<Required<Pick<DatasetGenerateRequest, 'name' | 'n_cases' | 'seed' | 'with_audio' | 'augment'>> & { audio_limit: number }>({
    name: 'synth-v2',
    n_cases: 120,
    seed: 11,
    with_audio: true,
    audio_limit: 60,
    augment: true,
  });
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob<DatasetBuildJob['result']>(jobId, 600);

  const start = useMutation({
    mutationFn: () =>
      evalApi.generateDataset({
        name: form.name.trim() || 'synth-v1',
        n_cases: form.n_cases,
        seed: form.seed,
        with_audio: form.with_audio,
        audio_limit: form.with_audio ? form.audio_limit : null,
        augment: form.augment,
      }),
    onSuccess: (j) => setJobId(j.id),
  });

  const state = job.data?.state;
  useEffect(() => {
    if (state === 'succeeded') {
      void qc.invalidateQueries({ queryKey: qk.datasets });
      toast.success('Dataset generated', (job.data?.result as EvalDatasetInfo | null)?.id);
      setJobId(null);
    } else if (state === 'failed') {
      toast.error('Dataset generation failed', job.data?.error ?? undefined);
      setJobId(null);
    }
  }, [state, qc, toast, job.data]);

  const running = start.isPending || state === 'queued' || state === 'running';
  const num = (key: 'n_cases' | 'seed' | 'audio_limit') => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: Math.max(0, Math.floor(Number(e.target.value) || 0)) }));

  return (
    <Card>
      <CardHeader title="Generate a synthetic dataset" subtitle="Templated utterances with ground truth; audio comes from text-to-speech and can be noise-augmented." icon={<SparklesIcon className="h-6 w-6" aria-hidden="true" />} />
      <CardBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Name">{(p) => <Input {...p} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />}</Field>
          <Field label="Cases">{(p) => <Input {...p} type="number" inputMode="numeric" min={3} max={400} value={form.n_cases} onChange={num('n_cases')} />}</Field>
          <Field label="Seed">{(p) => <Input {...p} type="number" inputMode="numeric" value={form.seed} onChange={num('seed')} />}</Field>
          <Field label="Audio for at most" hint="Text-to-speech is the slow part.">
            {(p) => <Input {...p} type="number" inputMode="numeric" min={0} disabled={!form.with_audio} value={form.audio_limit} onChange={num('audio_limit')} />}
          </Field>
        </div>
        <div className="flex flex-wrap gap-x-6">
          <Checkbox checked={form.with_audio} onChange={(v) => setForm((f) => ({ ...f, with_audio: v }))} label="Synthesize audio" />
          <Checkbox checked={form.augment} disabled={!form.with_audio} onChange={(v) => setForm((f) => ({ ...f, augment: v }))} label="Add noise / muffling variants" description="Wind, engine, radio, crackle and muffled audio." />
        </div>
        <Button variant="primary" icon={SparklesIcon} loading={running} disabled={form.n_cases < 3} onClick={() => start.mutate()}>
          Generate dataset
        </Button>
        {running && job.data ? <Progress value={job.data.progress} label={job.data.message} /> : null}
      </CardBody>
    </Card>
  );
}

function CaseTable({ cases }: { cases: EvalCase[] }) {
  return (
    <Table aria-label="Dataset cases">
      <thead>
        <tr>
          <Th>Case</Th>
          <Th>Spoken (what is said) vs written (oracle transcript)</Th>
          <Th>Expected fields</Th>
          <Th>Tags</Th>
        </tr>
      </thead>
      <tbody>
        {cases.map((c) => (
          <Tr key={c.id}>
            <Td className="whitespace-nowrap align-top">
              <p className="font-mono text-sm font-semibold text-ink">{c.id}</p>
              <p className="text-xs text-muted">{titleCase(c.form_id)}</p>
              <Badge tone={c.split === 'heldout' ? 'violet' : 'gray'} size="sm" className="mt-1">
                {c.split}
              </Badge>
            </Td>
            <Td className="min-w-[18rem] max-w-[28rem] align-top">
              <p className="text-sm italic text-ink">"{c.spoken_text}"</p>
              <p className="mt-1 text-sm text-muted">"{c.written_text}"</p>
              {c.noise && c.noise.kind !== 'none' ? (
                <Badge tone="amber" size="sm" className="mt-1">
                  noise: {c.noise.kind}
                  {c.noise.snr_db ? ` ${c.noise.snr_db} dB` : ''}
                </Badge>
              ) : null}
              {c.audio_path ? <Badge tone="blue" size="sm" className="ml-1 mt-1">audio{c.voice ? ` - ${c.voice}` : ''}</Badge> : null}
            </Td>
            <Td className="align-top">
              <div className="flex flex-wrap gap-1">
                {Object.entries(c.expected).map(([k, v]) => (
                  <Badge key={k} tone={v === null ? 'gray' : 'brand'} size="sm" title={k}>
                    {titleCase(k)}: {v === null ? '(empty)' : String(v)}
                  </Badge>
                ))}
              </div>
            </Td>
            <Td className="align-top">
              <div className="flex flex-wrap gap-1">
                {c.tags.map((t) => (
                  <Badge key={t} tone="gray" size="sm">
                    {t}
                  </Badge>
                ))}
              </div>
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

function Browser({ dataset }: { dataset: EvalDatasetInfo }) {
  const [tag, setTag] = useState('');
  const [split, setSplit] = useState('');
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [dataset.id, tag, split]);
  const q = useQuery({
    queryKey: qk.datasetCases(dataset.id, tag || null, split || null, offset),
    queryFn: () => evalApi.datasetCases(dataset.id, { tag: tag || undefined, split: split || undefined, offset, limit: PAGE }),
    placeholderData: (prev) => prev,
  });
  const tags = useMemo(() => Object.keys(dataset.tag_counts).sort(), [dataset.tag_counts]);
  const list = q.data ?? [];
  return (
    <Card>
      <CardHeader
        title={`Cases in ${dataset.name}`}
        subtitle="Browse what each utterance says, how a good ASR would write it, and the ground truth."
        icon={<CircleStackIcon className="h-6 w-6" aria-hidden="true" />}
        actions={
          <>
            <Select aria-label="Filter by tag" value={tag} onChange={(e) => setTag(e.target.value)} className="!w-auto">
              <option value="">All tags</option>
              {tags.map((t) => (
                <option key={t} value={t}>
                  {t} ({dataset.tag_counts[t]})
                </option>
              ))}
            </Select>
            <Select aria-label="Filter by split" value={split} onChange={(e) => setSplit(e.target.value)} className="!w-auto">
              <option value="">Dev + held-out</option>
              <option value="dev">Dev</option>
              <option value="heldout">Held-out</option>
            </Select>
          </>
        }
      />
      <CardBody className="!px-0 !py-0">
        {q.isLoading ? <LoadingBlock /> : q.isError ? <div className="p-4"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div> : list.length === 0 ? <EmptyState title="No cases match those filters" /> : <CaseTable cases={list} />}
        <div className="flex items-center justify-between gap-3 border-t border-line/70 px-4 py-3">
          <span className="text-sm text-muted">
            Showing {list.length === 0 ? 0 : offset + 1}-{offset + list.length}
          </span>
          <div className="flex gap-2">
            <Button size="sm" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>
              Previous
            </Button>
            <Button size="sm" disabled={list.length < PAGE} onClick={() => setOffset((o) => o + PAGE)}>
              Next
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

export default function DatasetsTab() {
  const datasets = useDatasets();
  const [selected, setSelected] = useState<string | null>(null);
  const list = datasets.data ?? [];
  useEffect(() => {
    if (!selected || !list.some((d) => d.id === selected)) setSelected(list[0]?.id ?? null);
  }, [list, selected]);
  const dataset = list.find((d) => d.id === selected) ?? null;

  return (
    <div className="space-y-5">
      <GenerateCard />
      <Card>
        <CardHeader title="Datasets" subtitle={`${plural(list.length, 'dataset')} on this machine. Select one to browse its cases.`} />
        <CardBody className="!px-0 !py-0">
          {datasets.isLoading ? <LoadingBlock /> : null}
          {datasets.isError ? <div className="p-4"><ErrorState error={datasets.error} onRetry={() => void datasets.refetch()} /></div> : null}
          {!datasets.isLoading && !datasets.isError && list.length === 0 ? <EmptyState title="No datasets yet">Generate one above to start evaluating.</EmptyState> : null}
          {list.length > 0 ? (
            <Table aria-label="Datasets">
              <thead>
                <tr>
                  <Th>Dataset</Th>
                  <Th>Created</Th>
                  <Th align="right">Cases</Th>
                  <Th align="right">With audio</Th>
                  <Th>Splits</Th>
                  <Th>Forms</Th>
                  <Th>Top tags</Th>
                </tr>
              </thead>
              <tbody>
                {list.map((d) => (
                  <Tr key={d.id} selected={d.id === selected} onClick={() => setSelected(d.id)} tabIndex={0} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setSelected(d.id)}>
                    <Td>
                      <p className="font-semibold text-ink">{d.name}</p>
                      <p className="font-mono text-xs text-muted">
                        {d.id} - seed {d.seed}
                        {d.synthetic ? ' - synthetic' : ''}
                      </p>
                    </Td>
                    <Td className="whitespace-nowrap text-muted">{fmtDateTime(d.created_at)}</Td>
                    <Td align="right">{d.n_cases}</Td>
                    <Td align="right">{d.n_with_audio}</Td>
                    <Td>
                      <div className="flex gap-1">
                        {Object.entries(d.splits).map(([s, n]) => (
                          <Badge key={s} tone={s === 'heldout' ? 'violet' : 'gray'} size="sm">
                            {s} {n}
                          </Badge>
                        ))}
                      </div>
                    </Td>
                    <Td className="text-xs text-muted">{d.form_ids.map(titleCase).join(', ')}</Td>
                    <Td>
                      <div className="flex max-w-xs flex-wrap gap-1">
                        {Object.entries(d.tag_counts)
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 5)
                          .map(([t, n]) => (
                            <span key={t} className={cn('rounded bg-slate-100 px-1.5 py-0.5 text-[0.7rem] text-slate-700')}>
                              {t} {n}
                            </span>
                          ))}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : null}
        </CardBody>
      </Card>
      {dataset ? <Browser dataset={dataset} /> : null}
      {dataset && !dataset.synthetic ? <Alert tone="info">This dataset contains recorded (non-synthetic) data.</Alert> : null}
    </div>
  );
}
