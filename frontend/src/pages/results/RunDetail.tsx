import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDownTrayIcon, ArrowLeftIcon, ChartBarIcon, CpuChipIcon, LightBulbIcon, TableCellsIcon } from '@heroicons/react/24/outline';
import type { DecisionGates } from '@/api/types';
import { evalApi, isApiError } from '@/api/client';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, KeyValue } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, LoadingBlock, Progress } from '@/components/ui/Feedback';
import { useToast } from '@/components/ui/Toast';
import { DemoTag } from '@/components/domain/DemoTag';
import { RunStatusBadge } from '@/components/domain/StatusBadges';
import { CaseDrilldown } from '@/components/domain/results/CaseDrilldown';
import { DecisionPanel } from '@/components/domain/results/DecisionPanel';
import { MetricsTable } from '@/components/domain/results/MetricsTable';
import { ParetoChart } from '@/components/domain/results/ParetoChart';
import { qk, useEngines } from '@/hooks/queries';
import { useDebounced } from '@/hooks/useDebounced';
import { downloadBlob } from '@/lib/download';
import { DEFAULT_GATES } from '@/lib/gates';
import { fmtDateTime, plural } from '@/lib/format';
import { isLatencyTargetProfile } from '@/lib/hardware';

function HowToRead() {
  return (
    <Card>
      <CardHeader title="How to read this" icon={<LightBulbIcon className="h-6 w-6" aria-hidden="true" />} />
      <CardBody className="space-y-2 text-sm leading-6 text-ink">
        <p>
          <strong>Silent-wrong rate is the number that matters, not JSON validity.</strong> It is the share of <em>confident</em> fields (shown as filled, at or above the confidence threshold) that are wrong. A worker
          trusts a confident field, so a confident wrong pole or unit id is the failure that actually hurts. A configuration can produce perfectly valid JSON and still be silently wrong on ids.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-muted">
          <li>
            <strong className="text-ink">Field / ID-field accuracy</strong> counts every expected field, including "left empty" expectations. ID accuracy looks at entity ids only.
          </li>
          <li>
            <strong className="text-ink">Review rate</strong> is how often the worker is asked to check something; <strong className="text-ink">safe outcome</strong> is correct or flagged, i.e. never silently wrong.
          </li>
          <li>
            <strong className="text-ink">WER</strong> is shown raw and number-normalised. Raw WER punishes "123" against "one two three" even though both mean the same id, so judge speech engines by the normalised figure and the ID accuracy.
          </li>
          <li>
            <strong className="text-ink">Latency</strong> is end of speech to proposed fields. Only a run on the latency-target device (Latitude 7220) predicts field behaviour; other machines rank options.
          </li>
          <li>
            <strong className="text-ink">Pareto-optimal</strong> configurations are the ones where nothing else is both faster and more accurate. The decision gates then pick among them.
          </li>
        </ul>
      </CardBody>
    </Card>
  );
}

export default function RunDetail() {
  const { runId = '' } = useParams();
  const toast = useToast();
  const engines = useEngines();
  const [gates, setGates] = useState<DecisionGates>(DEFAULT_GATES);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const debounced = useDebounced(gates, 400);

  const runQ = useQuery({
    queryKey: qk.run(runId),
    queryFn: () => evalApi.run(runId),
    enabled: !!runId,
    retry: false,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false),
  });
  const run = runQ.data;
  const done = run?.status === 'succeeded';
  const decisionQ = useQuery({
    queryKey: qk.decision(runId, debounced),
    queryFn: () => evalApi.decision(runId, debounced),
    enabled: !!runId && done,
    placeholderData: keepPreviousData,
  });

  const exporter = useMutation({
    mutationFn: (format: 'csv' | 'json') => evalApi.exportRun(runId, format),
    onSuccess: ({ blob, filename }) => {
      downloadBlob(blob, filename);
      toast.success('Export ready', filename);
    },
  });

  const configs = useMemo(() => run?.configs ?? [], [run]);
  const decisionRows = useMemo(() => new Map((decisionQ.data?.rows ?? []).map((r) => [r.config_key, r])), [decisionQ.data]);
  const pareto = useMemo(() => new Set((decisionQ.data?.pareto ?? []).filter((p) => p.pareto_optimal).map((p) => p.config_key)), [decisionQ.data]);
  const allEngines = useMemo(() => [...(engines.data?.stt ?? []), ...(engines.data?.llm ?? [])], [engines.data]);

  if (runQ.isLoading) return <LoadingBlock label="Loading the run..." />;
  if (runQ.isError) {
    if (isApiError(runQ.error) && runQ.error.code === 'not_found') {
      return (
        <EmptyState
          title="That run does not exist"
          action={
            <Link to="/results/runs" className={buttonClasses({ variant: 'primary' })}>
              Back to runs
            </Link>
          }
        />
      );
    }
    return <ErrorState error={runQ.error} onRetry={() => void runQ.refetch()} />;
  }
  if (!run) return null;

  const hw = run.hardware;
  const representative = isLatencyTargetProfile(hw.device_profile);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/results/runs" className="mb-1 inline-flex min-h-[36px] items-center gap-1 text-sm font-semibold text-brand-700 hover:underline field:min-h-[48px] field:text-base">
            <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" /> All runs
          </Link>
          <h2 className="flex flex-wrap items-center gap-3 text-xl font-bold text-ink">
            {run.label ?? run.run_id} <RunStatusBadge status={run.status} />
          </h2>
          <p className="text-sm text-muted">
            <span className="font-mono">{run.run_id}</span> - dataset {run.dataset_id} - started {fmtDateTime(run.created_at)}
            {run.finished_at ? `, finished ${fmtDateTime(run.finished_at)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button icon={ArrowDownTrayIcon} loading={exporter.isPending && exporter.variables === 'csv'} disabled={run.status === 'running'} onClick={() => exporter.mutate('csv')}>
            Export CSV
          </Button>
          <Button icon={ArrowDownTrayIcon} loading={exporter.isPending && exporter.variables === 'json'} disabled={run.status === 'running'} onClick={() => exporter.mutate('json')}>
            Export JSON
          </Button>
        </div>
      </div>

      {!representative ? (
        <Alert tone="warn" title="Results from this machine rank options only - they are not representative of the Latitude 7220" live>
          This run was measured on the "{hw.device_profile}" profile. Use it to compare speech engines, models and strategies against each other; do not read its latencies or memory figures as what the field device will do.
          Repeat the run on the target device before sizing anything.
        </Alert>
      ) : null}

      {run.status === 'running' ? (
        <Card>
          <CardBody>
            <Progress value={run.progress} label="Run in progress... results appear when it finishes" />
          </CardBody>
        </Card>
      ) : null}
      {run.status === 'failed' || run.status === 'cancelled' ? (
        <Alert tone="error" title={`The run ${run.status}`} live>
          {run.notes.join(' ') || 'No further detail was recorded.'}
        </Alert>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Hardware" icon={<CpuChipIcon className="h-6 w-6" aria-hidden="true" />} />
          <CardBody className="space-y-3">
            <KeyValue
              items={[
                ['Profile', hw.device_profile],
                ['CPU', hw.cpu_name],
                ['Cores', `${hw.physical_cores ?? '?'} physical / ${hw.logical_cores ?? '?'} logical`],
                ['Memory', hw.ram_gb !== null ? `${hw.ram_gb} GB` : '-'],
                ['OS', `${hw.os}${hw.os_build ? ` (build ${hw.os_build})` : ''}`],
                ['Battery', hw.battery_present === null ? '-' : hw.battery_present ? 'present' : 'none'],
              ]}
            />
            {hw.notes.length > 0 ? (
              <ul className="list-disc pl-5 text-xs text-muted">
                {hw.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Run settings" icon={<TableCellsIcon className="h-6 w-6" aria-hidden="true" />} />
          <CardBody className="space-y-3">
            <KeyValue
              items={[
                ['Configurations', plural(run.request.configs.length, 'configuration')],
                ['Case limit', run.request.limit ?? 'all'],
                ['Splits', run.request.splits?.join(', ') ?? 'all'],
                ['Tags', run.request.tags?.join(', ') ?? 'all'],
                ['Repeats / warm-up', `${run.request.repeats} / ${run.request.warmup}`],
                ['Confidence threshold', run.request.confidence_threshold],
              ]}
            />
            {run.notes.length > 0 ? (
              <ul className="list-disc pl-5 text-xs text-muted">
                {run.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
          </CardBody>
        </Card>
      </div>

      {configs.length > 0 ? (
        <>
          <Card>
            <CardHeader
              title="Metrics per configuration"
              subtitle="Click a column to sort and a row to inspect it."
              icon={<TableCellsIcon className="h-6 w-6" aria-hidden="true" />}
              actions={<DemoTag />}
            />
            <CardBody className="!px-0 !py-0">
              <MetricsTable configs={configs} decision={decisionRows} pareto={pareto} selectedKey={selectedKey} onSelect={setSelectedKey} engines={allEngines} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Latency vs accuracy" subtitle="Top-left is best: fast and accurate. Click a point to inspect it." icon={<ChartBarIcon className="h-6 w-6" aria-hidden="true" />} actions={<DemoTag />} />
            <CardBody>
              <ParetoChart configs={configs} report={decisionQ.data} gates={decisionQ.data?.gates ?? debounced} selectedKey={selectedKey} onSelect={setSelectedKey} engines={allEngines} />
            </CardBody>
          </Card>

          <DecisionPanel
            gates={gates}
            onGatesChange={setGates}
            report={decisionQ.data}
            loading={decisionQ.isFetching}
            error={decisionQ.isError ? decisionQ.error : null}
            onRetry={() => void decisionQ.refetch()}
            configs={configs}
            engines={allEngines}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
          />

          <CaseDrilldown runId={run.run_id} configs={configs} selectedKey={selectedKey} onSelect={setSelectedKey} threshold={run.request.confidence_threshold} engines={allEngines} />
        </>
      ) : run.status === 'succeeded' ? (
        <EmptyState title="This run has no configurations" />
      ) : null}

      <HowToRead />
    </div>
  );
}
