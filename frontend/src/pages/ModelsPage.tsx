import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  CpuChipIcon,
  ExclamationTriangleIcon,
  EyeSlashIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  ServerStackIcon,
  SignalSlashIcon,
} from '@heroicons/react/24/outline';
import type { CatalogModel, EngineInfo } from '@/api/types';
import { enginesApi, systemApi } from '@/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, KeyValue, PageHeader } from '@/components/ui/Card';
import { CheckChip, Input } from '@/components/ui/Controls';
import { Alert, EmptyState, ErrorState, LoadingBlock, Progress } from '@/components/ui/Feedback';
import { Table, Td, Th, Tr } from '@/components/ui/Table';
import { useToast } from '@/components/ui/Toast';
import { AvailabilityBadge } from '@/components/domain/StatusBadges';
import { DemoTag } from '@/components/domain/DemoTag';
import { qk, useEngines, useJob, useOnline, useSystemStatus } from '@/hooks/queries';
import { cn } from '@/lib/cn';
import { fmtMb, plural, titleCase } from '@/lib/format';

const TASK_LABELS: Record<string, string> = {
  'automatic-speech-recognition': 'Speech recognition',
  'chat-completion': 'Chat / text',
  'vision-language-chat': 'Vision + text',
  embeddings: 'Embeddings',
};

function EngineRows({ engine, online, colSpan }: { engine: EngineInfo; online: boolean; colSpan: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId, 500);
  const handled = useRef<string | null>(null);

  const prepare = useMutation({ mutationFn: () => enginesApi.prepare(engine.id), onSuccess: (j) => { handled.current = null; setJobId(j.id); } });
  const unload = useMutation({
    mutationFn: () => enginesApi.unload(engine.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.engines }),
  });

  const state = job.data?.state;
  useEffect(() => {
    if (!jobId || !state || handled.current === jobId) return;
    if (state === 'succeeded' || state === 'failed' || state === 'cancelled') {
      handled.current = jobId;
      void qc.invalidateQueries({ queryKey: qk.engines });
      void qc.invalidateQueries({ queryKey: qk.catalog });
      if (state === 'succeeded') toast.success(`${engine.name} is ready`, 'Downloaded, loaded and self-tested.');
      else toast.error(`${engine.name} could not be prepared`, job.data?.error ?? undefined);
      setJobId(null);
    }
  }, [jobId, state, engine.name, job.data?.error, qc, toast]);

  const busy = prepare.isPending || state === 'queued' || state === 'running';
  const needsNetwork = engine.availability === 'needs_download';
  const action = (() => {
    if (engine.availability === 'unavailable') {
      return (
        <Button size="sm" disabled title={engine.availability_reason ?? undefined}>
          Unavailable
        </Button>
      );
    }
    if (engine.availability === 'ready' && engine.loaded) {
      return (
        <Button size="sm" icon={EyeSlashIcon} loading={unload.isPending} disabled={busy} onClick={() => unload.mutate()}>
          Unload
        </Button>
      );
    }
    const label = engine.availability === 'needs_download' ? 'Download & load' : engine.availability === 'error' ? 'Retry' : 'Load';
    return (
      <Button
        size="sm"
        variant={engine.availability === 'needs_download' ? 'primary' : 'secondary'}
        icon={engine.availability === 'needs_download' ? ArrowDownTrayIcon : engine.availability === 'error' ? ArrowPathIcon : PlayIcon}
        loading={busy}
        disabled={needsNetwork && !online}
        title={needsNetwork && !online ? 'Downloading needs a connection' : undefined}
        onClick={() => prepare.mutate()}
      >
        {label}
      </Button>
    );
  })();

  return (
    <>
      <Tr>
        <Td className="min-w-[14rem]">
          <p className="font-semibold text-ink">{engine.name}</p>
          <p className="break-all font-mono text-[0.7rem] text-muted">{engine.id}</p>
          {engine.availability_reason && engine.availability !== 'ready' ? <p className="mt-1 max-w-sm text-xs text-muted">{engine.availability_reason}</p> : null}
        </Td>
        <Td>
          <Badge tone={engine.offline ? 'gray' : 'amber'} size="sm" icon={engine.offline ? undefined : SignalSlashIcon}>
            {engine.provider}
          </Badge>
          {!engine.offline ? <p className="mt-1 text-[0.7rem] font-semibold text-amber-800">needs network</p> : null}
        </Td>
        <Td>
          <AvailabilityBadge state={engine.availability} reason={engine.availability_reason} />
        </Td>
        <Td>
          <div className="flex flex-wrap gap-1">
            {engine.device ? (
              <Badge tone={engine.device === 'cpu' ? 'gray' : 'amber'} size="sm">
                {engine.device}
              </Badge>
            ) : null}
            {engine.execution_provider ? (
              <Badge tone="gray" size="sm" title={engine.execution_provider}>
                {engine.execution_provider.replace('ExecutionProvider', '')}
              </Badge>
            ) : null}
            {engine.supports_streaming ? (
              <Badge tone="blue" size="sm">
                streaming
              </Badge>
            ) : null}
            {engine.tags.map((t) => (
              <Badge key={t} tone="violet" size="sm">
                {t}
              </Badge>
            ))}
          </div>
        </Td>
        <Td align="right" className="whitespace-nowrap">
          {fmtMb(engine.size_mb)}
        </Td>
        <Td>
          {engine.loaded ? (
            <Badge tone="green" size="sm" icon={CheckCircleIcon}>
              loaded
            </Badge>
          ) : (
            <span className="text-xs text-muted">not loaded</span>
          )}
        </Td>
        <Td align="right">{action}</Td>
      </Tr>
      {busy && job.data ? (
        <tr>
          <td colSpan={colSpan} className="border-b border-line/60 bg-brand-50 px-4 py-3">
            <Progress value={job.data.progress} label={job.data.message || `Preparing ${engine.name}...`} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function EnginesTable({ title, engines, online }: { title: string; engines: EngineInfo[]; online: boolean }) {
  const ready = engines.filter((e) => e.availability === 'ready').length;
  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={`${ready} of ${engines.length} ready on this machine`}
        icon={<ServerStackIcon className="h-6 w-6" aria-hidden="true" />}
        actions={<DemoTag label="demo engines" />}
      />
      <CardBody className="!px-0 !py-0">
        <Table aria-label={title}>
          <thead>
            <tr>
              <Th>Engine</Th>
              <Th>Provider</Th>
              <Th>Availability</Th>
              <Th>Device / EP</Th>
              <Th align="right">Size</Th>
              <Th>Loaded</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {engines.map((e) => (
              <EngineRows key={e.id} engine={e} online={online} colSpan={7} />
            ))}
          </tbody>
        </Table>
      </CardBody>
    </Card>
  );
}

function CatalogBrowser() {
  const catalog = useQuery({ queryKey: qk.catalog, queryFn: enginesApi.catalog, staleTime: 30_000 });
  const [q, setQ] = useState('');
  const [tasks, setTasks] = useState<string[]>([]);
  const all = catalog.data ?? [];
  const taskList = useMemo(() => Array.from(new Set(all.map((m) => m.task))), [all]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((m) => (tasks.length === 0 || tasks.includes(m.task)) && (!needle || `${m.alias} ${m.publisher ?? ''} ${m.task}`.toLowerCase().includes(needle)));
  }, [all, q, tasks]);

  return (
    <Card>
      <CardHeader
        title="Foundry model catalog"
        subtitle={`${plural(all.length, 'model')} in the catalog. Each model exposes CPU, GPU and NPU variants.`}
        icon={<CpuChipIcon className="h-6 w-6" aria-hidden="true" />}
        actions={<DemoTag label="demo catalog" />}
      />
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[14rem] flex-1 sm:max-w-sm">
            <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <Input type="search" aria-label="Search the catalog" placeholder="Search alias or publisher" className="pl-10" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by task">
            {taskList.map((t) => (
              <CheckChip key={t} checked={tasks.includes(t)} onChange={(on) => setTasks((cur) => (on ? [...cur, t] : cur.filter((x) => x !== t)))}>
                {TASK_LABELS[t] ?? titleCase(t)}
              </CheckChip>
            ))}
          </div>
        </div>
        {catalog.isLoading ? <LoadingBlock /> : null}
        {catalog.isError ? <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} /> : null}
        {!catalog.isLoading && !catalog.isError && shown.length === 0 ? <EmptyState title="No models match" /> : null}
        <ul className="grid gap-3 lg:grid-cols-2">
          {shown.map((m) => (
            <CatalogCard key={m.alias} model={m} />
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function CatalogCard({ model: m }: { model: CatalogModel }) {
  return (
    <li className="rounded-xl border border-line bg-surface p-4 field:border-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-ink">{m.alias}</p>
          <p className="text-xs text-muted">
            {m.publisher ?? 'unknown publisher'}
            {m.license ? ` - ${m.license}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge tone="blue" size="sm">
            {TASK_LABELS[m.task] ?? titleCase(m.task)}
          </Badge>
          {m.input_modalities.map((x) => (
            <Badge key={x} tone="gray" size="sm">
              {x}
            </Badge>
          ))}
          {m.supports_tool_calling ? (
            <Badge tone="violet" size="sm">
              tool calling
            </Badge>
          ) : null}
        </div>
      </div>
      <ul className="mt-3 divide-y divide-line/60 text-sm">
        {m.variants.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge tone={v.device === 'cpu' ? 'gray' : 'amber'} size="sm">
                {v.device}
              </Badge>
              <span className="text-xs text-muted">{v.execution_provider.replace('ExecutionProvider', '')}</span>
            </span>
            <span className="flex items-center gap-2 text-xs">
              <span className="tabular-nums text-muted">{fmtMb(v.size_mb)}</span>
              {v.cached ? (
                <Badge tone="green" size="sm" icon={CheckCircleIcon}>
                  cached
                </Badge>
              ) : (
                <span className="text-muted">not cached</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

export default function ModelsPage() {
  const online = useOnline();
  const engines = useEngines(true);
  const { data: status } = useSystemStatus();
  const hardware = useQuery({ queryKey: qk.hardware, queryFn: systemApi.hardware, staleTime: 60_000 });
  const hw = hardware.data ?? status?.hardware;
  const foundry = status?.foundry;

  return (
    <>
      <PageHeader
        eyebrow="Local AI"
        title="Models"
        subtitle="What this machine can run, what still has to be downloaded, and why some engines are unavailable. Variants are pinned and self-tested before use."
      />

      <div className="space-y-5">
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Hardware" icon={<CpuChipIcon className="h-6 w-6" aria-hidden="true" />} actions={<DemoTag label="demo hardware" />} />
            <CardBody className="space-y-2">
              {hw ? (
                <KeyValue
                  items={[
                    ['Device profile', hw.device_profile],
                    ['CPU', hw.cpu_name],
                    ['Cores', `${hw.physical_cores ?? '?'} physical / ${hw.logical_cores ?? '?'} logical`],
                    ['Memory', hw.ram_gb !== null ? `${hw.ram_gb} GB` : '-'],
                    ['OS', `${hw.os}${hw.os_build ? ` (build ${hw.os_build})` : ''}`],
                    ['Battery', hw.battery_present === null ? '-' : hw.battery_present ? 'present' : 'none'],
                  ]}
                />
              ) : (
                <LoadingBlock />
              )}
              {hw?.notes.map((n) => (
                <p key={n} className="text-xs text-muted">
                  {n}
                </p>
              ))}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Foundry Local" icon={<ServerStackIcon className="h-6 w-6" aria-hidden="true" />} />
            <CardBody className="space-y-2">
              {foundry ? (
                <>
                  <KeyValue
                    items={[
                      ['Status', <Badge key="s" tone={foundry.available ? 'green' : 'red'}>{foundry.available ? 'Available' : 'Not available'}</Badge>],
                      ['SDK version', foundry.sdk_version ?? '-'],
                      ['Catalog models', foundry.catalog_count ?? '-'],
                      ['Accelerator providers', foundry.eps_registered ? 'registered (variants can be pinned)' : 'not registered: CPU variants only'],
                      ['Model cache', <code key="c" className="break-all text-xs">{foundry.model_cache_dir ?? '-'}</code>],
                    ]}
                  />
                  {foundry.error ? <Alert tone="error">{foundry.error}</Alert> : null}
                </>
              ) : (
                <LoadingBlock />
              )}
            </CardBody>
          </Card>
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          <Alert tone="warn" title="Azure embedded speech">
            Limited access: registration is required at{' '}
            <a href="https://aka.ms/csgate-embedded-speech" target="_blank" rel="noreferrer" className="font-semibold underline">
              aka.ms/csgate-embedded-speech
            </a>
            . Windows 11+ only; there is no iOS SDK.
          </Alert>
          <Alert tone="info" title="Azure cloud engine">
            Reference only, not offline. It needs the network at inference time, so it is a ceiling to compare against, never a field option.
          </Alert>
          <Alert tone="warn" title="Accelerator (GPU / NPU) variants">
            Pin and self-test before use. Automatic selection once picked an NPU variant that then failed to load; CPU is the safe default.
          </Alert>
        </div>

        {engines.isLoading ? <LoadingBlock label="Loading engines..." /> : null}
        {engines.isError ? <ErrorState error={engines.error} onRetry={() => void engines.refetch()} /> : null}
        {engines.data ? (
          <>
            <EnginesTable title="Speech-to-text engines" engines={engines.data.stt} online={online} />
            <EnginesTable title="Language models" engines={engines.data.llm} online={online} />
            <Card>
              <CardHeader title="Extraction strategies" subtitle="The ablation ladder from today's baseline to the proposed hybrid." icon={<ExclamationTriangleIcon className="h-6 w-6" aria-hidden="true" />} />
              <CardBody>
                <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {engines.data.strategies.map((s) => (
                    <li key={s.id} className={cn('rounded-xl border border-line p-3 field:border-2', s.id === 'hybrid' && 'border-brand-400 bg-brand-50')}>
                      <p className="font-semibold text-ink">{s.name}</p>
                      <p className="mt-1 text-sm text-muted">{s.description}</p>
                      <p className="mt-2 flex flex-wrap gap-1">
                        <Badge tone={s.uses_llm ? 'violet' : 'gray'} size="sm">
                          {s.uses_llm ? 'uses an LLM' : 'no LLM'}
                        </Badge>
                        {s.deterministic_stages ? (
                          <Badge tone="green" size="sm">
                            deterministic stages
                          </Badge>
                        ) : null}
                        {s.constrained ? (
                          <Badge tone="blue" size="sm">
                            constrained decoding
                          </Badge>
                        ) : null}
                      </p>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          </>
        ) : null}

        <CatalogBrowser />
      </div>
    </>
  );
}
