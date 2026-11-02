import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/cn';

const controlBase =
  'w-full rounded-lg border border-line bg-surface px-3 text-base text-ink placeholder:text-slate-400 ' +
  'focus-visible:border-brand-600 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300 ' +
  'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500 field:border-2 field:border-black';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  return <input ref={ref} className={cn(controlBase, 'min-h-tap', invalid && 'border-red-500 ring-2 ring-red-200', className)} aria-invalid={invalid || undefined} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn(controlBase, 'min-h-tap pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(controlBase, 'min-h-[88px] py-2.5', className)} {...rest} />;
});

export function Label({ htmlFor, children, required, className }: { htmlFor?: string; children: ReactNode; required?: boolean; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn('block text-sm font-semibold text-ink', className)}>
      {children}
      {required ? (
        <span className="ml-1 text-red-600" aria-hidden="true">
          *
        </span>
      ) : null}
    </label>
  );
}

/** Label + control + hint/error wired together with ids. Pass a render prop to receive the generated id. */
export function Field({
  label,
  hint,
  error,
  required,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: (props: { id: string; 'aria-describedby'?: string }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      {children({ id, 'aria-describedby': describedBy })}
      {error ? (
        <p id={`${id}-err`} className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled,
  className,
  title,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      title={title}
      className={cn(
        'flex min-h-tap cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-slate-50',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
        className,
      )}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-5 w-5 shrink-0 rounded border-slate-400 text-brand-600 accent-brand-600 focus-visible:ring-4 focus-visible:ring-brand-300"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {description ? <span className="block text-xs text-muted">{description}</span> : null}
      </span>
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
  tone = 'brand',
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
  tone?: 'brand' | 'green' | 'amber';
}) {
  const on = { brand: 'bg-brand-600', green: 'bg-emerald-600', amber: 'bg-amber-500' }[tone];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300 disabled:opacity-50 field:border-black',
        checked ? on : 'bg-slate-400',
        className,
      )}
    >
      <span
        className={cn('inline-block h-6 w-6 transform rounded-full bg-white shadow transition-transform', checked ? 'translate-x-6' : 'translate-x-0.5')}
        aria-hidden="true"
      />
    </button>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

/** Radio-group semantics, big touch targets. `allowDeselect` lets a second tap clear the value (used for optional fields). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  allowDeselect,
  disabled,
  size = 'md',
  className,
  tones,
}: {
  options: SegmentOption<T>[];
  value: T | null | undefined;
  onChange: (value: T | null) => void;
  ariaLabel: string;
  allowDeselect?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  tones?: Partial<Record<T, string>>;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn('inline-flex max-w-full flex-wrap gap-1 rounded-xl bg-slate-100 p-1 field:border-2 field:border-black field:bg-white', className)}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={o.title}
            disabled={disabled || o.disabled}
            onClick={() => onChange(selected && allowDeselect ? null : o.value)}
            className={cn(
              'rounded-lg px-3.5 font-semibold transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300 disabled:cursor-not-allowed disabled:opacity-40',
              size === 'sm' ? 'min-h-[36px] text-sm field:min-h-[48px]' : 'min-h-tap text-base',
              selected
                ? cn('text-white shadow-sm', tones?.[o.value] ?? 'bg-brand-600', 'field:ring-2 field:ring-black')
                : 'bg-transparent text-ink hover:bg-white',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function CheckChip({
  checked,
  onChange,
  children,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex min-h-[40px] items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300 field:min-h-[48px] field:border-2',
        checked ? 'border-brand-700 bg-brand-600 text-white field:border-black' : 'border-line bg-surface text-ink hover:bg-slate-50',
        disabled && 'cursor-not-allowed opacity-45 hover:bg-surface',
      )}
    >
      <span
        className={cn('flex h-4 w-4 items-center justify-center rounded-sm border text-[10px] leading-none', checked ? 'border-white bg-white text-brand-700' : 'border-slate-400')}
        aria-hidden="true"
      >
        {checked ? '\u2713' : ''}
      </span>
      {children}
    </button>
  );
}
