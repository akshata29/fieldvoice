import { useEffect, useId, type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/cn';

/** Hover/focus tooltip (CSS only). The trigger should be focusable so touch users can tap it to reveal the text. Hidden bubbles are display:none so they never widen the page. */
export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom';
  align?: 'center' | 'start' | 'end';
  className?: string;
}) {
  const id = useId();
  if (!content) return <>{children}</>;
  return (
    <span className={cn('group relative inline-flex max-w-full', className)} aria-describedby={id}>
      {children}
      <span
        id={id}
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-40 hidden w-max max-w-xs rounded-lg bg-slate-900 px-3 py-2 text-left text-xs font-normal leading-snug text-white shadow-pop',
          'group-hover:block group-focus-within:block',
          align === 'center' ? 'left-1/2 -translate-x-1/2' : align === 'end' ? 'right-0' : 'left-0',
          side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
        )}
      >
        {content}
      </span>
    </span>
  );
}

/** Closes on outside pointer-down and on Escape while `open`. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, open, onClose]);
}

/** A native <details> disclosure with a big touch target. */
export function Disclosure({
  title,
  summary,
  children,
  defaultOpen,
  className,
}: {
  title: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details open={defaultOpen} className={cn('group rounded-xl border border-line bg-surface field:border-2', className)}>
      <summary className="flex min-h-tap cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 text-sm font-semibold text-ink marker:hidden [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 truncate">{title}</span>
        <span className="flex items-center gap-2 text-xs font-normal text-muted">
          {summary}
          <svg className="h-4 w-4 transition-transform group-open:rotate-180" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
          </svg>
        </span>
      </summary>
      <div className="border-t border-line/70 px-4 py-3">{children}</div>
    </details>
  );
}
