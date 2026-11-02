import type { ReactNode } from 'react';
import { ArrowPathIcon, ExclamationTriangleIcon, InformationCircleIcon, CheckCircleIcon, XCircleIcon } from '@heroicons/react/24/solid';
import { cn } from '@/lib/cn';
import { clamp01 } from '@/lib/format';
import { Button } from './Button';
import { Spinner } from './Spinner';

export { Spinner };

export function LoadingBlock({ label = 'Loading...', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-3 py-10 text-muted', className)} role="status">
      <Spinner className="h-5 w-5" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-slate-200', className)} aria-hidden="true" />;
}

export type ProgressTone = 'brand' | 'green' | 'amber' | 'red';
const progressTones: Record<ProgressTone, string> = {
  brand: 'bg-brand-600',
  green: 'bg-emerald-600',
  amber: 'bg-amber-500',
  red: 'bg-red-600',
};

export function Progress({
  value,
  label,
  tone = 'brand',
  indeterminate,
  size = 'md',
  showPercent = true,
  className,
}: {
  /** 0..1 */
  value?: number;
  label?: ReactNode;
  tone?: ProgressTone;
  indeterminate?: boolean;
  size?: 'sm' | 'md';
  showPercent?: boolean;
  className?: string;
}) {
  const pct = Math.round(clamp01(value ?? 0) * 100);
  return (
    <div className={cn('w-full', className)}>
      {label || (showPercent && !indeterminate) ? (
        <div className="mb-1 flex items-baseline justify-between gap-2 text-xs text-muted">
          <span className="min-w-0 truncate">{label}</span>
          {showPercent && !indeterminate ? <span className="tabular-nums font-medium text-ink">{pct}%</span> : null}
        </div>
      ) : null}
      <div
        className={cn('overflow-hidden rounded-full bg-slate-200 field:border field:border-black', size === 'sm' ? 'h-1.5' : 'h-2.5')}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : pct}
        aria-label={typeof label === 'string' ? label : 'Progress'}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-300 ease-out',
            progressTones[tone],
            indeterminate && 'w-1/3 animate-indeterminate',
          )}
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export type AlertTone = 'info' | 'warn' | 'error' | 'success';
const alertStyles: Record<AlertTone, { box: string; icon: typeof InformationCircleIcon; iconClass: string }> = {
  info: { box: 'border-sky-300 bg-sky-50 text-sky-950', icon: InformationCircleIcon, iconClass: 'text-sky-600' },
  warn: { box: 'border-amber-400 bg-amber-50 text-amber-950', icon: ExclamationTriangleIcon, iconClass: 'text-amber-600' },
  error: { box: 'border-red-300 bg-red-50 text-red-950', icon: XCircleIcon, iconClass: 'text-red-600' },
  success: { box: 'border-emerald-300 bg-emerald-50 text-emerald-950', icon: CheckCircleIcon, iconClass: 'text-emerald-600' },
};

export function Alert({
  tone = 'info',
  title,
  children,
  actions,
  className,
  live,
}: {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  live?: boolean;
}) {
  const s = alertStyles[tone];
  const Icon = s.icon;
  return (
    <div
      className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm field:border-2 field:border-black field:bg-white field:text-black', s.box, className)}
      role={live ? (tone === 'error' ? 'alert' : 'status') : undefined}
    >
      <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', s.iconClass)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cn(title && 'mt-0.5')}>{children}</div> : null}
        {actions ? <div className="mt-2 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-12 text-center', className)}>
      {icon ? <div className="mb-1 text-slate-400 [&>svg]:h-10 [&>svg]:w-10">{icon}</div> : null}
      <p className="text-base font-semibold text-ink">{title}</p>
      {children ? <p className="max-w-md text-sm text-muted">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title = 'Something went wrong',
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  className?: string;
}) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unexpected error';
  return (
    <div className={cn('rounded-xl border border-red-200 bg-red-50 p-5 text-red-950 field:border-2 field:border-black', className)} role="alert">
      <div className="flex items-start gap-3">
        <XCircleIcon className="mt-0.5 h-6 w-6 shrink-0 text-red-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{title}</p>
          <p className="mt-0.5 break-words text-sm">{message}</p>
          {onRetry ? (
            <Button size="sm" className="mt-3" icon={ArrowPathIcon} onClick={onRetry}>
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
