import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpenIcon, CalendarDaysIcon, MagnifyingGlassIcon, MapPinIcon, WrenchScrewdriverIcon } from '@heroicons/react/24/outline';
import type { Asset, FormSchema, KbHit, WorkOrder } from '@/api/types';
import { kbApi } from '@/api/client';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Controls';
import { Disclosure } from '@/components/ui/Tooltip';
import { EmptyState, Spinner } from '@/components/ui/Feedback';
import { PriorityBadge, WorkOrderStatusBadge } from '@/components/domain/StatusBadges';
import { qk } from '@/hooks/queries';
import { useDebounced } from '@/hooks/useDebounced';
import { fmtDate, plural, titleCase } from '@/lib/format';
import { formatFieldValue } from '@/lib/formLogic';
import { cn } from '@/lib/cn';

export function JobInfoCard({ workOrder, form }: { workOrder: WorkOrder; form: FormSchema }) {
  const prefill = Object.entries(workOrder.prefill);
  return (
    <Card>
      <CardHeader title="Job" subtitle={`${workOrder.id} - version ${workOrder.version}`} icon={<WrenchScrewdriverIcon className="h-6 w-6" aria-hidden="true" />} />
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <PriorityBadge priority={workOrder.priority} />
          <WorkOrderStatusBadge status={workOrder.status} />
        </div>
        <p className="whitespace-pre-line text-sm leading-6 text-ink">{workOrder.description}</p>
        <dl className="space-y-1.5 text-sm">
          <div className="flex items-start gap-2">
            <MapPinIcon className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
            <dd className="text-ink">{workOrder.location}</dd>
          </div>
          <div className="flex items-start gap-2">
            <CalendarDaysIcon className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
            <dd className="text-ink">{fmtDate(workOrder.scheduled_for)}</dd>
          </div>
        </dl>
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm field:border-2 field:border-black field:bg-white">
          <p className="font-semibold text-ink">{form.title}</p>
          {form.description ? <p className="text-muted">{form.description}</p> : null}
          <p className="mt-1 text-xs text-muted">
            Form version {form.version} - {plural(form.fields.length, 'field')}
          </p>
        </div>
        {prefill.length > 0 ? (
          <div className="text-xs text-muted">
            Pre-filled by dispatch:{' '}
            {prefill.map(([k, v]) => {
              const spec = form.fields.find((f) => f.key === k);
              return (
                <Badge key={k} tone="gray" size="sm" className="mr-1">
                  {spec?.label ?? k}: {spec ? formatFieldValue(spec, v) : String(v)}
                </Badge>
              );
            })}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

export function AssetsCard({ assets, jobAssetIds }: { assets: Asset[]; jobAssetIds: string[] }) {
  const groups = useMemo(() => {
    const m = new Map<string, Asset[]>();
    for (const a of assets) m.set(a.kind, [...(m.get(a.kind) ?? []), a]);
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [assets]);
  return (
    <Card>
      <CardHeader
        title="In-scope assets"
        subtitle={`${assets.length} assets: the closed world for this job. Ids outside it are flagged.`}
      />
      <CardBody className="space-y-2">
        {groups.length === 0 ? <p className="text-sm text-muted">No assets in scope.</p> : null}
        {groups.map(([kind, list]) => (
          <Disclosure key={kind} title={titleCase(kind)} summary={plural(list.length, 'item')} defaultOpen={list.some((a) => jobAssetIds.includes(a.id)) && list.length <= 8}>
            <ul className="divide-y divide-line/60">
              {list.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{a.label}</p>
                    {a.location ? <p className="text-xs text-muted">{a.location}</p> : null}
                    {Object.keys(a.attributes).length > 0 ? (
                      <p className="mt-0.5 flex flex-wrap gap-1">
                        {Object.entries(a.attributes).map(([k, v]) => (
                          <span key={k} className="rounded bg-slate-100 px-1.5 py-0.5 text-[0.7rem] text-slate-700">
                            {k}: {v}
                          </span>
                        ))}
                      </p>
                    ) : null}
                  </div>
                  <span className={cn('shrink-0 rounded-md px-2 py-1 font-mono text-sm font-semibold', jobAssetIds.includes(a.id) ? 'bg-brand-50 text-brand-800' : 'bg-slate-100 text-slate-700')}>{a.id}</span>
                </li>
              ))}
            </ul>
          </Disclosure>
        ))}
      </CardBody>
    </Card>
  );
}

export function KbPanel({ workOrderId, initialHits }: { workOrderId: string; initialHits: KbHit[] }) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 350);
  const search = useQuery({
    queryKey: qk.kb(debounced, workOrderId),
    queryFn: () => kbApi.search(debounced, workOrderId, 6),
    enabled: debounced.length > 1,
    staleTime: 30_000,
  });
  const hits = debounced.length > 1 ? (search.data ?? []) : initialHits;
  return (
    <Card>
      <CardHeader title="Procedures and knowledge base" subtitle="Searches the documents downloaded this morning; works offline." icon={<BookOpenIcon className="h-6 w-6" aria-hidden="true" />} />
      <CardBody className="space-y-3">
        <div className="relative">
          <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <Input type="search" aria-label="Search procedures" placeholder="Search, e.g. oil leak, de-energize" className="pl-10" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {search.isFetching && debounced.length > 1 ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="h-4 w-4" /> Searching...
          </p>
        ) : null}
        {hits.length === 0 && !search.isFetching ? (
          <EmptyState className="py-6" title={debounced.length > 1 ? 'Nothing matches that search' : 'No procedures linked to this job'} />
        ) : (
          <ul className="space-y-2" aria-live="polite">
            {hits.map((h, i) => (
              <li key={`${h.doc_id}-${h.heading}-${i}`} className="rounded-lg border border-line bg-surface-2 p-3 field:border-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-ink">{h.title}</p>
                  <Badge tone="gray" size="sm" title={`Revision ${h.revision}`}>
                    Rev {h.revision}
                  </Badge>
                </div>
                <p className="text-xs font-medium uppercase tracking-wide text-brand-700">{h.heading}</p>
                <p className="mt-1 text-sm leading-5 text-ink">{h.snippet}</p>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
