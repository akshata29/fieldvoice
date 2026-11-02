import { useRef } from 'react';
import { BackspaceIcon } from '@heroicons/react/24/outline';
import { cn } from '@/lib/cn';

const MAX_PIN = 8;

/** Big-button PIN keypad. Digits also work from a hardware keyboard while the pad has focus. */
export function PinPad({
  value,
  onChange,
  onSubmit,
  disabled,
  invalid,
}: {
  value: string;
  onChange: (pin: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const add = (d: string) => value.length < MAX_PIN && onChange(value + d);
  const key =
    'flex min-h-[4rem] items-center justify-center rounded-2xl border border-line bg-surface text-2xl font-semibold text-ink shadow-sm transition-colors ' +
    'hover:bg-slate-50 active:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300 field:min-h-[4.5rem] field:border-2 field:border-black';
  return (
    <div
      ref={ref}
      className="mx-auto w-full max-w-xs"
      onKeyDown={(e) => {
        if (disabled) return;
        if (/^\d$/.test(e.key)) {
          e.preventDefault();
          add(e.key);
        } else if (e.key === 'Backspace') {
          e.preventDefault();
          onChange(value.slice(0, -1));
        } else if (e.key === 'Enter' && value.length > 0) {
          e.preventDefault();
          onSubmit();
        }
      }}
    >
      <div
        className={cn('mb-4 flex h-12 items-center justify-center gap-2 rounded-xl bg-slate-100 field:border-2 field:border-black field:bg-white', invalid && 'bg-red-50 ring-2 ring-red-400')}
        role="status"
        aria-label={`PIN entered: ${value.length} digit${value.length === 1 ? '' : 's'}`}
      >
        {value.length === 0 ? <span className="text-sm text-muted">Enter your PIN</span> : null}
        {Array.from({ length: value.length }, (_, i) => (
          <span key={i} className="h-3.5 w-3.5 rounded-full bg-ink" aria-hidden="true" />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} type="button" className={key} disabled={disabled} onClick={() => add(d)} aria-label={d}>
            {d}
          </button>
        ))}
        <button type="button" className={cn(key, 'text-base')} disabled={disabled || value.length === 0} onClick={() => onChange('')}>
          Clear
        </button>
        <button type="button" className={key} disabled={disabled} onClick={() => add('0')} aria-label="0">
          0
        </button>
        <button type="button" className={key} disabled={disabled || value.length === 0} onClick={() => onChange(value.slice(0, -1))} aria-label="Backspace">
          <BackspaceIcon className="h-7 w-7" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
