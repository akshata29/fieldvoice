import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowPathIcon, CalendarDaysIcon, ChevronRightIcon, ClipboardDocumentListIcon, MagnifyingGlassIcon, MapPinIcon } from '@heroicons/react/24/outline';
import type { Priority, WorkOrderListItem } from '@/api/types';
import { isApiError } from '@/api/client';
import { Button, buttonClasses } from '@/components/ui/Button';
import { CheckChip, Input, SegmentedControl } from '@/components/ui/Controls';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/Feedback';
import { DraftStatusBadge, PriorityBadge, WorkOrderStatusBadge } from '@/components/domain/StatusBadges';
import { useSystemStatus, useWorkOrders } from '@/hooks/queries';
import { cn } from '@/lib/cn';
import { fmtDate } from '@/lib/format';

type StatusFilter = 'todo' | 'done' | 'all';

const PRIORITY_RANK: Record<Priority, number> = { emergency: 0, high: 1, normal: 2, low: 3 };
const ACCENT: Record<Priority, string> = {
  emergency: 'border-l-red-600',
  high: 'border-l-amber-500',
  normal: 'border-l-brand-500',
  low: 'border-l-slate-300',
};

// A job is done for the worker once dispatch closed it or the worker approved it on this device (queued or synced).
// A conflict still needs the worker's attention, so it stays on the to-do list.
export function isDone(item: WorkOrderListItem): boolean {
  return item.work_order.status === 'completed' || item.draft_status === 'approved' || item.draft_status === 'synced';
}

export function sortWorkOrders(items: WorkOrderListItem[]): WorkOrderListItem[] {
  return [...items].sort((a, b) => {
    const doneA = isDone(a) ? 1 : 0;
    const doneB = isDone(b) ? 1 : 0;
    return doneA - doneB || PRIORITY_RANK[a.work_order.priority] - PRIORITY_RANK[b.work_order.priority] || a.work_order.id.localeCompare(b.work_order.id);
  });
}

function JobCard({ item }: { item: WorkOrderListItem }) {
  const wo = item.work_order;
  return (
    <Link
      to={`/jobs/${encodeURIComponent(wo.id)}`}
      className={cn(
        'group relative flex min-h-[8rem] flex-col gap-2 rounded-xl border border-line border-l-[6px] bg-surface p-4 shadow-card transition-shadow hover:shadow-pop',
        'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300 field:border-2 field:border-l-[10px] field:border-black field:shadow-none',
        ACCENT[wo.priority],
        isDone(item) && 'bg-slate-50',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityBadge priority={wo.priority} />
          <WorkOrderStatusBadge status={wo.status} />
        </div>
        <DraftStatusBadge status={item.draft_status} />
      </div>
      <h2 className="text-lg font-semibold leading-snug text-ink">{wo.title}</h2>
      <p className="flex items-start gap-1.5 text-sm text-muted">
        <MapPinIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {wo.location}
      </p>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1">
            <CalendarDaysIcon className="h-4 w-4" aria-hidden="true" /> {fmtDate(wo.scheduled_for)}
          </span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700">{item.form_title}</span>
          <span className="font-mono text-xs">{wo.id}</span>
        </span>
        <ChevronRightIcon className="h-6 w-6 text-slate-400 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
      </div>
    </Link>
  );
}

export default function TodayPage() {
  const status = useSystemStatus();
  const query = useWorkOrders();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('todo');
  const [priorities, setPriorities] = useState<Priority[]>([]);

  const session = status.data?.session ?? null;
  const items = useMemo(() => sortWorkOrders(query.data ?? []), [query.data]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      const wo = i.work_order;
      if (filter === 'todo' && isDone(i)) return false;
      if (filter === 'done' && !isDone(i)) return false;
      if (priorities.length > 0 && !priorities.includes(wo.priority)) return false;
      if (!q) return true;
      return [wo.id, wo.title, wo.location, i.form_title, wo.description].some((s) => s.toLowerCase().includes(q));
    });
  }, [items, search, filter, priorities]);

  const todo = items.filter((i) => !isDone(i)).length;
  const unauthenticated = isApiError(query.error) && query.error.code === 'unauthenticated';

  const header = (
    <PageHeader
      eyebrow={session ? `${session.worker.name} - ${session.worker.crew}` : undefined}
      title="Today's work"
      subtitle={items.length > 0 ? `${todo} to do, ${items.length - todo} done. Tap a job to capture the work by voice.` : 'Your assigned work orders, available offline once downloaded.'}
      actions={
        <Button icon={ArrowPathIcon} loading={query.isFetching && !query.isLoading} onClick={() => void query.refetch()}>
          Refresh
        </Button>
      }
    />
  );

  if (!session || unauthenticated) {
    return (
      <>
        {header}
        <Card>
          <EmptyState
            icon={<ClipboardDocumentListIcon />}
            title="Sign in to see today's work"
            action={
              <Link to="/morning" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
                Start on the Morning screen
              </Link>
            }
          >
            Work orders, forms and procedures are downloaded in the morning while you are online. After that everything works offline.
          </EmptyState>
        </Card>
      </>
    );
  }
  if (query.isLoading) return <LoadingBlock label="Loading work orders..." />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  return (
    <>
      {header}
      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ClipboardDocumentListIcon />}
            title="No work orders on this device yet"
            action={
              <Link to="/morning" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
                Run Morning prep
              </Link>
            }
          >
            Download today's bundle on the Morning screen while you are online.
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative min-w-[14rem] flex-1 sm:max-w-sm">
              <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <Input type="search" aria-label="Search work orders" placeholder="Search title, place or id" className="pl-10" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <SegmentedControl<StatusFilter>
              ariaLabel="Filter by status"
              value={filter}
              onChange={(v) => setFilter(v ?? 'todo')}
              options={[
                { value: 'todo', label: 'To do' },
                { value: 'done', label: 'Done' },
                { value: 'all', label: 'All' },
              ]}
            />
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by priority">
              {(['emergency', 'high', 'normal', 'low'] as Priority[]).map((p) => (
                <CheckChip key={p} checked={priorities.includes(p)} onChange={(on) => setPriorities((cur) => (on ? [...cur, p] : cur.filter((x) => x !== p)))}>
                  {p[0]?.toUpperCase()}
                  {p.slice(1)}
                </CheckChip>
              ))}
            </div>
          </div>

          {visible.length === 0 ? (
            <Card>
              <EmptyState title="Nothing matches those filters">
                <Button
                  onClick={() => {
                    setSearch('');
                    setPriorities([]);
                    setFilter('all');
                  }}
                >
                  Clear filters
                </Button>
              </EmptyState>
            </Card>
          ) : (
            <ul className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {visible.map((item) => (
                <li key={item.work_order.id}>
                  <JobCard item={item} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
