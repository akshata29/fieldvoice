import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUturnLeftIcon, CheckIcon } from '@heroicons/react/24/solid';
import type { OutboxItem } from '@/api/types';
import { syncApi } from '@/api/client';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import { invalidateLocalState, qk } from '@/hooks/queries';

export function ConflictDialog({ item, onClose }: { item: OutboxItem | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState<'keep_mine' | 'take_theirs' | null>(null);

  const resolve = useMutation({
    mutationFn: (action: 'keep_mine' | 'take_theirs') => syncApi.resolve({ item_id: (item as OutboxItem).id, action }),
    onMutate: (action) => setPending(action),
    onSettled: () => setPending(null),
    onSuccess: (updated, action) => {
      invalidateLocalState(qc);
      void qc.invalidateQueries({ queryKey: qk.outbox });
      void qc.invalidateQueries({ queryKey: qk.sor });
      toast.success(
        action === 'keep_mine' ? 'Keeping your version' : 'Using the dispatcher version',
        action === 'keep_mine' ? 'Your completion will be re-sent on top of the new job version.' : `The conflicting completion for ${updated.work_order_id} was discarded.`,
      );
      onClose();
    },
  });

  return (
    <Dialog
      open={item !== null}
      onClose={onClose}
      title="Dispatch changed this job"
      description={item ? `${item.work_order_id}: your completion was based on version ${item.base_version}, dispatch is now at version ${item.server_version ?? '?'}.` : undefined}
      footer={<Button onClick={onClose}>Decide later</Button>}
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-line p-4 field:border-2">
          <p className="font-semibold text-ink">Keep mine</p>
          <p className="mt-1 text-sm text-muted">Re-send my completion on top of the new job version. Choose this when the dispatcher change does not affect the work you did.</p>
          <Button className="mt-3" variant="primary" icon={CheckIcon} loading={pending === 'keep_mine'} disabled={resolve.isPending} onClick={() => resolve.mutate('keep_mine')}>
            Keep mine
          </Button>
        </div>
        <div className="rounded-xl border border-line p-4 field:border-2">
          <p className="font-semibold text-ink">Take theirs</p>
          <p className="mt-1 text-sm text-muted">Discard my completion (and its photos) and use dispatch's version of the job. You may need to redo the form.</p>
          <Button className="mt-3" icon={ArrowUturnLeftIcon} loading={pending === 'take_theirs'} disabled={resolve.isPending} onClick={() => resolve.mutate('take_theirs')}>
            Take theirs
          </Button>
        </div>
        {item?.last_error ? <p className="text-xs text-muted">Server said: {item.last_error}</p> : null}
      </div>
    </Dialog>
  );
}
