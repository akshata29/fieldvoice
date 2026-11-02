import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BeakerIcon, PlayIcon } from '@heroicons/react/24/solid';
import type { LabCompareItem, LabCompareRequest, LabCompareResult, SampleInfo } from '@/api/types';
import { ORACLE_STT_ID } from '@/api/types';
import { errorMessage, labApi, samplesApi, voiceApi, workOrdersApi } from '@/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, PageHeader } from '@/components/ui/Card';
import { Field, SegmentedControl, Select, Textarea } from '@/components/ui/Controls';
import { Alert, EmptyState, LoadingBlock, Progress } from '@/components/ui/Feedback';
import { AudioSource, type AudioClip } from '@/components/domain/AudioSource';
import { ComboBuilder, EMPTY_SELECTION, type ComboSelection } from '@/components/domain/ComboBuilder';
import { DemoBanner } from '@/components/domain/DemoTag';
import { LabResultGrid, scoreItems, type LabSort } from '@/components/domain/LabResults';
import { qk, useDatasets, useEngines, useJob, useWorkOrders } from '@/hooks/queries';
import { buildPreset, expandCombos } from '@/lib/combos';
import { formatFieldValue } from '@/lib/formLogic';
import { plural, titleCase } from '@/lib/format';

type Source = 'sample' | 'text' | 'audio';

interface Target {
  key: string;
  label: string;
  formId: string;
  workOrderId: string | null;
}

export default function LabPage() {
  const engines = useEngines();
  const workOrders = useWorkOrders();
  const datasets = useDatasets();

  const [source, setSource] = useState<Source>('sample');
  const [targetKey, setTargetKey] = useState('');
  const [tag, setTag] = useState('');
  const [split, setSplit] = useState('');
  const [sampleId, setSampleId] = useState('');
  const [text, setText] = useState('');
  const [clip, setClip] = useState<AudioClip | null>(null);
  const [selection, setSelection] = useState<ComboSelection>(EMPTY_SELECTION);
  const [sort, setSort] = useState<LabSort>('accuracy');
  const [jobId, setJobId] = useState<string | null>(null);
  const [audioRun, setAudioRun] = useState<{ running: boolean; done: number; total: number; result: LabCompareResult | null }>({ running: false, done: 0, total: 0, result: null });

  // ---- what to run it against -------------------------------------------------------------------------------------
  const targets = useMemo<Target[]>(() => {
    const list: Target[] = [];
    for (const w of workOrders.data ?? []) list.push({ key: `wo:${w.work_order.id}`, label: `${w.work_order.id} - ${w.form_title}`, formId: w.work_order.form_id, workOrderId: w.work_order.id });
    const formIds = new Set((datasets.data ?? []).flatMap((d) => d.form_ids));
    for (const f of formIds) list.push({ key: `form:${f}`, label: `${titleCase(f)} (form, all known assets)`, formId: f, workOrderId: null });
    return list;
  }, [workOrders.data, datasets.data]);
  useEffect(() => {
    if (!targets.some((t) => t.key === targetKey) && targets[0]) setTargetKey(targets[0].key);
  }, [targets, targetKey]);
  const target = targets.find((t) => t.key === targetKey) ?? null;

  const labelWoId = target?.workOrderId ?? workOrders.data?.find((w) => w.work_order.form_id === target?.formId)?.work_order.id ?? null;
  const detail = useQuery({ queryKey: qk.workOrder(labelWoId ?? ''), queryFn: () => workOrdersApi.get(labelWoId as string), enabled: !!labelWoId, staleTime: 30_000 });
  const form = detail.data?.form ?? null;

  const samplesQ = useQuery({
    queryKey: qk.samples(target?.formId ?? null, tag || null),
    queryFn: () => samplesApi.list({ form_id: target?.formId, tag: tag || undefined, limit: 100 }),
    enabled: !!target,
    staleTime: 30_000,
  });
  const samples: SampleInfo[] = useMemo(() => (samplesQ.data ?? []).filter((s) => !split || s.split === split), [samplesQ.data, split]);
  useEffect(() => {
    if (!samples.some((s) => s.id === sampleId)) setSampleId(samples[0]?.id ?? '');
  }, [samples, sampleId]);
  const sample = samples.find((s) => s.id === sampleId) ?? null;
  const allTags = useMemo(() => Array.from(new Set((samplesQ.data ?? []).flatMap((s) => s.tags))).sort(), [samplesQ.data]);

  // ---- combo matrix -----------------------------------------------------------------------------------------------
  const engineList = engines.data;
  const seeded = useRef(false);
  useEffect(() => {
    if (!engineList || seeded.current) return;
    seeded.current = true;
    const p = buildPreset('baseline_vs_hybrid', engineList);
    setSelection({ stt: p.stt, llm: p.llm, strategies: p.strategies });
  }, [engineList]);
  const { combos } = useMemo(() => expandCombos(selection.stt, selection.llm, selection.strategies), [selection]);

  // when the source changes the valid speech engines change too
  useEffect(() => {
    setSelection((s) => {
      if (source === 'text') return s.stt.length === 1 && s.stt[0] === ORACLE_STT_ID ? s : { ...s, stt: [ORACLE_STT_ID] };
      if (source === 'audio') return s.stt.includes(ORACLE_STT_ID) ? { ...s, stt: s.stt.filter((x) => x !== ORACLE_STT_ID) } : s;
      return s;
    });
  }, [source]);

  // ---- running ----------------------------------------------------------------------------------------------------
  const compare = useMutation({
    mutationFn: (body: LabCompareRequest) => labApi.compare(body),
    onSuccess: (job) => setJobId(job.id),
  });
  const job = useJob<LabCompareResult>(jobId, 600);
  const running = compare.isPending || job.data?.state === 'queued' || job.data?.state === 'running' || audioRun.running;

  const baseRequest = (): Pick<LabCompareRequest, 'work_order_id' | 'form_id'> => (target?.workOrderId ? { work_order_id: target.workOrderId } : { form_id: target?.formId });

  const runAudio = async () => {
    if (!clip) return;
    setJobId(null);
    setAudioRun({ running: true, done: 0, total: combos.length, result: null });
    const items: LabCompareItem[] = [];
    for (const [i, config] of combos.entries()) {
      try {
        const extraction = await voiceApi.extractAudio(clip.blob, { ...baseRequest(), ...config }, clip.name);
        items.push({ config, extraction, field_correct: null, error: null });
      } catch (e) {
        items.push({ config, extraction: null, field_correct: null, error: errorMessage(e) });
      }
      setAudioRun((a) => ({ ...a, done: i + 1 }));
    }
    setAudioRun({ running: false, done: combos.length, total: combos.length, result: { expected: null, items } });
  };

  const canRun =
    !!target && combos.length > 0 && !running && ((source === 'sample' && !!sample) || (source === 'text' && text.trim().length > 0) || (source === 'audio' && !!clip));

  const run = () => {
    if (!canRun) return;
    if (source === 'audio') {
      void runAudio();
      return;
    }
    setAudioRun({ running: false, done: 0, total: 0, result: null });
    setJobId(null);
    compare.mutate({ ...baseRequest(), ...(source === 'sample' ? { sample_id: sampleId } : { transcript: text }), combos });
  };

  const result: LabCompareResult | null = source === 'audio' ? audioRun.result : job.data?.state === 'succeeded' ? job.data.result : null;
  const cards = useMemo(() => (result ? scoreItems(result.items, result.expected) : []), [result]);
  const jobFailed = job.data?.state === 'failed' || job.data?.state === 'cancelled';

  const expectedChips = sample
    ? Object.entries(sample.expected).map(([k, v]) => {
        const spec = form?.fields.find((f) => f.key === k);
        return (
          <Badge key={k} tone={v === null ? 'gray' : 'brand'} size="sm">
            {spec?.label ?? titleCase(k)}: {v === null ? '(empty)' : spec ? formatFieldValue(spec, v) : String(v)}
          </Badge>
        );
      })
    : [];

  return (
    <>
      <PageHeader
        eyebrow="Compare"
        title="Lab"
        subtitle="Run the same utterance through several speech engines, language models and extraction strategies side by side. Where the sample has ground truth, every field is marked correct or wrong."
      />
      <DemoBanner />

      {engines.isLoading ? <LoadingBlock label="Loading engines..." /> : null}
      {engines.isError ? <Alert tone="error">Could not load the engine list. {errorMessage(engines.error)}</Alert> : null}

      {engineList ? (
        <div className="space-y-5">
          <Card>
            <CardHeader title="1. Choose the input" icon={<BeakerIcon className="h-6 w-6" aria-hidden="true" />} />
            <CardBody className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Form / work order" hint="Work orders use that job's closed world of assets; forms use every known asset.">
                  {(props) => (
                    <Select {...props} value={targetKey} onChange={(e) => setTargetKey(e.target.value)} disabled={targets.length === 0}>
                      {targets.length === 0 ? <option value="">No forms available (download a bundle or generate a dataset)</option> : null}
                      {targets.some((t) => t.workOrderId) ? (
                        <optgroup label="Today's work orders">
                          {targets
                            .filter((t) => t.workOrderId)
                            .map((t) => (
                              <option key={t.key} value={t.key}>
                                {t.label}
                              </option>
                            ))}
                        </optgroup>
                      ) : null}
                      <optgroup label="Forms from the datasets">
                        {targets
                          .filter((t) => !t.workOrderId)
                          .map((t) => (
                            <option key={t.key} value={t.key}>
                              {t.label}
                            </option>
                          ))}
                      </optgroup>
                    </Select>
                  )}
                </Field>
                <div className="space-y-1.5">
                  <p className="text-sm font-semibold text-ink">Source</p>
                  <SegmentedControl<Source>
                    ariaLabel="Input source"
                    value={source}
                    onChange={(v) => setSource(v ?? 'sample')}
                    options={[
                      { value: 'sample', label: 'Dataset sample' },
                      { value: 'text', label: 'Typed transcript' },
                      { value: 'audio', label: 'Audio' },
                    ]}
                  />
                </div>
              </div>

              {source === 'sample' ? (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Tag">
                      {(props) => (
                        <Select {...props} value={tag} onChange={(e) => setTag(e.target.value)}>
                          <option value="">All tags</option>
                          {allTags.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label="Split">
                      {(props) => (
                        <Select {...props} value={split} onChange={(e) => setSplit(e.target.value)}>
                          <option value="">Dev and held-out</option>
                          <option value="dev">Dev</option>
                          <option value="heldout">Held-out (phrasing not tuned on)</option>
                        </Select>
                      )}
                    </Field>
                    <Field label={`Sample (${plural(samples.length, 'match', 'matches')})`}>
                      {(props) => (
                        <Select {...props} value={sampleId} onChange={(e) => setSampleId(e.target.value)} disabled={samples.length === 0}>
                          {samples.length === 0 ? <option value="">{samplesQ.isLoading ? 'Loading...' : 'No samples match'}</option> : null}
                          {samples.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.id} - {s.written_text.length > 50 ? `${s.written_text.slice(0, 50)}...` : s.written_text}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  </div>
                  {sample ? (
                    <div className="space-y-2 rounded-xl bg-surface-2 p-3 text-sm field:border-2 field:border-black">
                      <p className="text-muted">
                        Spoken: <span className="italic text-ink">"{sample.spoken_text}"</span>
                      </p>
                      <p className="text-muted">
                        Written: <span className="text-ink">"{sample.written_text}"</span>
                      </p>
                      <div className="flex flex-wrap gap-1">{expectedChips}</div>
                      <div className="flex flex-wrap gap-1">
                        {sample.tags.map((t) => (
                          <Badge key={t} tone="gray" size="sm">
                            {t}
                          </Badge>
                        ))}
                        <Badge tone={sample.split === 'heldout' ? 'violet' : 'gray'} size="sm">
                          {sample.split}
                        </Badge>
                        {sample.noise && sample.noise.kind !== 'none' ? (
                          <Badge tone="amber" size="sm">
                            noise: {sample.noise.kind}
                            {sample.noise.snr_db ? ` ${sample.noise.snr_db} dB` : ''}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {source === 'text' ? (
                <Field label="Transcript" hint="Typed text skips speech recognition, so only the extraction side of each combination is compared.">
                  {(props) => <Textarea {...props} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="I replaced the transformer at pole 123. The old unit was leaking oil and I installed unit 456." />}
                </Field>
              ) : null}

              {source === 'audio' ? (
                <div className="space-y-2">
                  <AudioSource clip={clip} onChange={setClip} />
                  <p className="text-xs text-muted">The audio is sent once per combination (there is no ground truth, so results show what each engine produced).</p>
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="2. Build the combination matrix" subtitle="Every speech engine x every language model x every strategy you tick." />
            <CardBody>
              <ComboBuilder engines={engineList} value={selection} onChange={setSelection} includeOracle={source !== 'audio'} oracleOnly={source === 'text'} />
            </CardBody>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" size="lg" icon={PlayIcon} loading={running} disabled={!canRun} onClick={run}>
              Compare {plural(combos.length, 'combination')}
            </Button>
            {!canRun && !running ? (
              <span className="text-sm text-muted">
                {!target ? 'Pick a form first.' : combos.length === 0 ? 'Tick at least one engine and strategy.' : source === 'sample' ? 'Pick a sample.' : source === 'text' ? 'Type a transcript.' : 'Record or upload audio.'}
              </span>
            ) : null}
          </div>

          {running ? (
            <Card>
              <CardBody>
                <Progress
                  value={source === 'audio' ? (audioRun.total ? audioRun.done / audioRun.total : 0) : (job.data?.progress ?? 0)}
                  label={source === 'audio' ? `Running ${Math.min(audioRun.done + 1, audioRun.total)} of ${audioRun.total}...` : job.data?.message || 'Starting...'}
                />
              </CardBody>
            </Card>
          ) : null}
          {jobFailed ? (
            <Alert tone="error" title="The comparison failed" live>
              {job.data?.error ?? 'The job was cancelled.'}
            </Alert>
          ) : null}
          {compare.isError ? <Alert tone="error">{compare.error.message}</Alert> : null}

          {result ? (
            <section aria-label="Comparison results" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-xl font-bold text-ink">Results</h2>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-ink">Sort by</span>
                  <SegmentedControl<LabSort>
                    ariaLabel="Sort results"
                    value={sort}
                    onChange={(v) => setSort(v ?? 'accuracy')}
                    size="sm"
                    options={[
                      { value: 'accuracy', label: 'Accuracy' },
                      { value: 'silent', label: 'Silent-wrong' },
                      { value: 'latency', label: 'Latency' },
                    ]}
                  />
                </div>
              </div>
              {result.items.length === 0 ? (
                <EmptyState title="No results">The comparison returned nothing.</EmptyState>
              ) : (
                <LabResultGrid cards={cards} expected={result.expected} form={form} engines={[...engineList.stt, ...engineList.llm]} sort={sort} />
              )}
            </section>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
