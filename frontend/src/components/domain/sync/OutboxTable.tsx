import { Link } from 'react-router-dom';
import { CameraIcon, DocumentCheckIcon } from '@heroicons/react/24/outline';
import type { OutboxItem } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Table, Td, Th, Tr } from '@/components/ui/Table';
import { OutboxStateBadge } from '@/components/domain/StatusBadges';
import { relTime } from '@/lib/format';

export function OutboxTable({ items, knownWorkOrders, onResolve }: { items: OutboxItem[]; knownWorkOrders: ReadonlySet<string>; onResolve: (item: OutboxItem) => void }) {
  return (
    <Table aria-label="Sync outbox">
      <thead>
        <tr>
          <Th>Work order</Th>
          <Th>Item</Th>
          <Th>State</Th>
          <Th align="right">Attempts</Th>
          <Th>Versions</Th>
          <Th>Last error</Th>
          <Th>Updated</Th>
          <Th>
            <span className="sr-only">Actions</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <Tr key={item.id} className={item.state === 'conflict' ? 'bg-amber-50/70' : undefined}>
            <Td className="whitespace-nowrap font-mono text-sm">
              {knownWorkOrders.has(item.work_order_id) ? (
                <Link to={`/jobs/${encodeURIComponent(item.work_order_id)}`} className="font-semibold text-brand-700 hover:underline">
                  {item.work_order_id}
                </Link>
              ) : (
                item.work_order_id
              )}
            </Td>
            <Td>
              <span className="flex items-center gap-2">
                {item.kind === 'photo' ? <CameraIcon className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" /> : <DocumentCheckIcon className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />}
                <span className="min-w-0">
                  <span className="block font-medium text-ink">{item.kind === 'photo' ? 'Photo' : 'Completion'}</span>
                  <span className="block truncate font-mono text-xs text-muted" title={item.id}>
                    {item.kind === 'photo' && typeof item.detail.filename === 'string' ? item.detail.filename : item.id}
                  </span>
                </span>
              </span>
            </Td>
            <Td>
              <OutboxStateBadge state={item.state} />
            </Td>
            <Td align="right">{item.attempts}</Td>
            <Td className="whitespace-nowrap font-mono text-xs text-muted">
              base v{item.base_version}
              {item.server_version !== null ? <span className="text-ink"> / server v{item.server_version}</span> : null}
            </Td>
            <Td className="max-w-[18rem] text-xs text-muted">
              <span className="line-clamp-2" title={item.last_error ?? undefined}>
                {item.last_error ?? '-'}
              </span>
            </Td>
            <Td className="whitespace-nowrap text-xs text-muted">{relTime(item.updated_at)}</Td>
            <Td align="right">
              {item.state === 'conflict' ? (
                <Button size="sm" variant="primary" onClick={() => onResolve(item)}>
                  Resolve
                </Button>
              ) : null}
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
