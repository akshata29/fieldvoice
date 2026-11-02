import {
  ArrowPathIcon,
  CheckCircleIcon,
  ClockIcon,
  CloudArrowDownIcon,
  ExclamationTriangleIcon,
  MinusCircleIcon,
  NoSymbolIcon,
  PaperAirplaneIcon,
  XCircleIcon,
  BoltIcon,
  PencilSquareIcon,
  QuestionMarkCircleIcon,
} from '@heroicons/react/20/solid';
import type {
  AvailabilityState,
  DraftStatus,
  FieldSource,
  FieldStatus,
  JobState,
  OutboxState,
  Priority,
  ReadinessStatus,
  RunStatus,
  WorkOrderStatus,
} from '@/api/types';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Spinner } from '@/components/ui/Spinner';
import { Tooltip } from '@/components/ui/Tooltip';
import { titleCase } from '@/lib/format';

export function PriorityBadge({ priority }: { priority: Priority }) {
  const tone: Record<Priority, BadgeTone> = { emergency: 'red', high: 'amber', normal: 'blue', low: 'gray' };
  return (
    <Badge tone={tone[priority]} icon={priority === 'emergency' ? BoltIcon : undefined}>
      {titleCase(priority)}
    </Badge>
  );
}

export function WorkOrderStatusBadge({ status }: { status: WorkOrderStatus }) {
  const map: Record<WorkOrderStatus, { tone: BadgeTone; label: string }> = {
    assigned: { tone: 'gray', label: 'Assigned' },
    in_progress: { tone: 'brand', label: 'In progress' },
    completed: { tone: 'green', label: 'Completed' },
  };
  return <Badge tone={map[status].tone}>{map[status].label}</Badge>;
}

export function DraftStatusBadge({ status }: { status: DraftStatus }) {
  const map: Record<DraftStatus, { tone: BadgeTone; label: string; icon?: typeof ClockIcon }> = {
    none: { tone: 'gray', label: 'No draft', icon: MinusCircleIcon },
    draft: { tone: 'amber', label: 'Draft saved', icon: PencilSquareIcon },
    approved: { tone: 'blue', label: 'Queued to sync', icon: PaperAirplaneIcon },
    synced: { tone: 'green', label: 'Synced', icon: CheckCircleIcon },
    conflict: { tone: 'red', label: 'Conflict', icon: ExclamationTriangleIcon },
  };
  const m = map[status];
  return (
    <Badge tone={m.tone} icon={m.icon}>
      {m.label}
    </Badge>
  );
}

export function OutboxStateBadge({ state }: { state: OutboxState }) {
  const map: Record<OutboxState, { tone: BadgeTone; icon: typeof ClockIcon }> = {
    pending: { tone: 'blue', icon: ClockIcon },
    sending: { tone: 'violet', icon: ArrowPathIcon },
    synced: { tone: 'green', icon: CheckCircleIcon },
    failed: { tone: 'red', icon: XCircleIcon },
    conflict: { tone: 'amber', icon: ExclamationTriangleIcon },
  };
  return (
    <Badge tone={map[state].tone} icon={map[state].icon}>
      {titleCase(state)}
    </Badge>
  );
}

export function AvailabilityBadge({ state, reason }: { state: AvailabilityState; reason?: string | null }) {
  const map: Record<AvailabilityState, { tone: BadgeTone; label: string; icon: typeof ClockIcon }> = {
    ready: { tone: 'green', label: 'Ready', icon: CheckCircleIcon },
    needs_download: { tone: 'blue', label: 'Needs download', icon: CloudArrowDownIcon },
    unavailable: { tone: 'gray', label: 'Unavailable', icon: NoSymbolIcon },
    error: { tone: 'red', label: 'Error', icon: XCircleIcon },
  };
  const m = map[state];
  const badge = (
    <Badge tone={m.tone} icon={m.icon}>
      {m.label}
    </Badge>
  );
  if (!reason) return badge;
  return (
    <Tooltip content={reason}>
      <span tabIndex={0} className="inline-flex cursor-help rounded-full">
        {badge}
      </span>
    </Tooltip>
  );
}

export function ReadinessStatusBadge({ status }: { status: ReadinessStatus }) {
  if (status === 'running') {
    return (
      <Badge tone="blue" icon={undefined}>
        <span className="inline-flex items-center gap-1">
          <Spinner className="h-3.5 w-3.5" /> Running
        </span>
      </Badge>
    );
  }
  const map: Record<Exclude<ReadinessStatus, 'running'>, { tone: BadgeTone; label: string; icon: typeof ClockIcon }> = {
    pass: { tone: 'green', label: 'Pass', icon: CheckCircleIcon },
    warn: { tone: 'amber', label: 'Warning', icon: ExclamationTriangleIcon },
    fail: { tone: 'red', label: 'Fail', icon: XCircleIcon },
    pending: { tone: 'gray', label: 'Pending', icon: ClockIcon },
  };
  const m = map[status];
  return (
    <Badge tone={m.tone} icon={m.icon}>
      {m.label}
    </Badge>
  );
}

export function JobStateBadge({ state }: { state: JobState }) {
  const map: Record<JobState, BadgeTone> = { queued: 'gray', running: 'blue', succeeded: 'green', failed: 'red', cancelled: 'gray' };
  return <Badge tone={map[state]}>{titleCase(state)}</Badge>;
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const map: Record<RunStatus, BadgeTone> = { running: 'blue', succeeded: 'green', failed: 'red', cancelled: 'gray' };
  return <Badge tone={map[status]}>{titleCase(status)}</Badge>;
}

export function FieldStatusBadge({ status }: { status: FieldStatus }) {
  const map: Record<FieldStatus, { tone: BadgeTone; label: string; icon: typeof ClockIcon }> = {
    filled: { tone: 'green', label: 'Filled', icon: CheckCircleIcon },
    needs_review: { tone: 'amber', label: 'Needs review', icon: ExclamationTriangleIcon },
    missing: { tone: 'gray', label: 'Missing', icon: MinusCircleIcon },
    conflict: { tone: 'red', label: 'Conflict', icon: XCircleIcon },
  };
  const m = map[status];
  return (
    <Badge tone={m.tone} icon={m.icon} size="sm">
      {m.label}
    </Badge>
  );
}

const SOURCE_LABEL: Record<FieldSource, { label: string; tone: BadgeTone; hint: string }> = {
  rule: { label: 'Rule', tone: 'brand', hint: 'Matched deterministically against the form lexicon and the job assets' },
  embedding: { label: 'Embedding', tone: 'blue', hint: 'Matched by semantic similarity' },
  llm: { label: 'LLM', tone: 'violet', hint: 'Proposed by the on-device language model' },
  user: { label: 'You', tone: 'dark', hint: 'Entered or edited by the worker' },
  prefill: { label: 'Prefill', tone: 'gray', hint: 'Pre-filled by dispatch' },
};

export function FieldSourceBadge({ source }: { source: FieldSource | null }) {
  if (!source) {
    return (
      <Badge tone="gray" icon={QuestionMarkCircleIcon} size="sm">
        No source
      </Badge>
    );
  }
  const m = SOURCE_LABEL[source];
  return (
    <Tooltip content={m.hint}>
      <span tabIndex={0} className="inline-flex rounded-full">
        <Badge tone={m.tone} size="sm">
          {m.label}
        </Badge>
      </span>
    </Tooltip>
  );
}
