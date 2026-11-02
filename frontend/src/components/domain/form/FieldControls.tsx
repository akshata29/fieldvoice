/** Typed controls for the five field types (ENUM, ENTITY_REF, NUMBER, BOOLEAN, TEXT). All are touch-sized and keyboard accessible. */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CheckIcon, MagnifyingGlassIcon } from '@heroicons/react/20/solid';
import type { Asset, FieldSpec, Scalar } from '@/api/types';
import { Input, SegmentedControl, Select, Textarea } from '@/components/ui/Controls';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { numberProblem } from '@/lib/formLogic';
import { useDismiss } from '@/components/ui/Tooltip';

export interface ControlProps {
  spec: FieldSpec;
  value: Scalar;
  disabled?: boolean;
  onChange: (value: Scalar) => void;
  labelledBy?: string;
}

// ---- ENUM -------------------------------------------------------------------------------------------------------

export function EnumControl({ spec, value, disabled, onChange, labelledBy }: ControlProps) {
  const known = spec.options.some((o) => o.code === value);
  const unknown = value !== null && value !== '' && !known;
  const warning = unknown ? <p className="text-xs font-medium text-amber-800">Unrecognised value "{String(value)}" - pick one of the options.</p> : null;
  if (spec.options.length <= 4) {
    return (
      <div className="space-y-1.5">
        <SegmentedControl
          ariaLabel={spec.label}
          value={known ? (value as string) : null}
          allowDeselect
          disabled={disabled}
          onChange={(v) => onChange(v)}
          options={spec.options.map((o) => ({ value: o.code, label: o.label }))}
        />
        {warning}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <Select aria-labelledby={labelledBy} value={known ? (value as string) : unknown ? String(value) : ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Select...</option>
        {unknown ? <option value={String(value)}>{`Unrecognised: ${String(value)}`}</option> : null}
        {spec.options.map((o) => (
          <option key={o.code} value={o.code}>
            {o.label}
          </option>
        ))}
      </Select>
      {warning}
    </div>
  );
}

// ---- ENTITY_REF (typeahead over the closed world) ---------------------------------------------------------------

interface EntityOption {
  id: string;
  label: string;
  hint: string | null;
  free?: boolean;
}

export function EntityControl({
  spec,
  value,
  disabled,
  onChange,
  assets,
  candidates,
  labelledBy,
}: ControlProps & { assets: Asset[]; candidates: string[] }) {
  const listId = useId();
  const pool = useMemo(() => assets.filter((a) => !spec.entity_kind || a.kind === spec.entity_kind), [assets, spec.entity_kind]);
  const current = value === null || value === '' ? '' : String(value);
  const [text, setText] = useState(current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setText(current);
  }, [current]);
  useDismiss(wrapRef, open, () => setOpen(false));

  const matched = pool.find((a) => a.id.toLowerCase() === current.toLowerCase());
  const inWorld = current === '' || !!matched;

  const options: EntityOption[] = useMemo(() => {
    const q = text.trim().toLowerCase();
    const shown = pool
      .filter((a) => !q || q === current.toLowerCase() || a.id.toLowerCase().includes(q) || a.label.toLowerCase().includes(q) || (a.location ?? '').toLowerCase().includes(q))
      .slice(0, 8)
      .map<EntityOption>((a) => ({ id: a.id, label: a.label, hint: a.location }));
    const exact = pool.some((a) => a.id.toLowerCase() === q);
    if (q && !exact) shown.push({ id: text.trim(), label: `Use "${text.trim()}"`, hint: "Not in today's assets", free: true });
    return shown;
  }, [pool, text, current]);

  const commit = (id: string) => {
    editing.current = false;
    setText(id);
    setOpen(false);
    onChange(id === '' ? null : id);
  };

  return (
    <div className="space-y-1.5" ref={wrapRef}>
      <div className="relative">
        <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <Input
          role="combobox"
          aria-labelledby={labelledBy}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="done"
          className="pl-10 font-mono"
          placeholder={`Search ${spec.entity_kind ? spec.entity_kind.replace(/_/g, ' ') : 'asset'} id...`}
          disabled={disabled}
          value={text}
          invalid={!inWorld}
          onFocus={() => {
            editing.current = true;
            setOpen(true);
            setActive(0);
          }}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onBlur={() => {
            // option clicks keep focus in the input (see onPointerDown below), so this only runs for real exits
            editing.current = false;
            const typed = text.trim();
            if (typed !== current) commit(typed);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(options.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const chosen = open ? options[active] : undefined;
              commit(chosen ? chosen.id : text.trim());
            } else if (e.key === 'Escape') {
              setOpen(false);
              setText(current);
            }
          }}
        />
        {open && options.length > 0 ? (
          <ul
            id={listId}
            role="listbox"
            aria-label={`${spec.label} suggestions`}
            className="scroll-thin absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-line bg-surface py-1 shadow-pop field:border-2 field:border-black"
          >
            {options.map((o, i) => (
              <li
                key={`${o.id}-${o.free ? 'free' : 'asset'}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={o.id.toLowerCase() === current.toLowerCase()}
                onPointerDown={(e) => {
                  e.preventDefault(); // keep focus in the input so blur does not commit the half-typed text first
                  commit(o.id);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  'flex min-h-[48px] cursor-pointer items-center justify-between gap-3 px-3 py-1.5',
                  i === active ? 'bg-brand-50' : '',
                  o.free ? 'border-t border-line/70 text-amber-900' : 'text-ink',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{o.label}</span>
                  {o.hint ? <span className="block truncate text-xs text-muted">{o.hint}</span> : null}
                </span>
                {o.id.toLowerCase() === current.toLowerCase() && !o.free ? <CheckIcon className="h-5 w-5 shrink-0 text-brand-700" aria-hidden="true" /> : null}
                {!o.free ? <span className="shrink-0 font-mono text-sm text-muted">{o.id}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {matched ? (
        <p className="text-sm text-muted">
          <span className="font-medium text-ink">{matched.label}</span>
          {matched.location ? ` - ${matched.location}` : ''}
        </p>
      ) : null}
      {!inWorld ? (
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-amber-800">
          <Badge tone="amber" size="sm">
            Not in today's assets
          </Badge>
          Check the id before you approve.
        </p>
      ) : null}
      {candidates.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>Did you mean</span>
          {candidates.map((c) => (
            <button
              key={c}
              type="button"
              disabled={disabled}
              onClick={() => commit(c)}
              className="min-h-[36px] rounded-full border border-line bg-surface px-3 font-mono text-sm font-semibold text-ink hover:bg-slate-50 field:min-h-[44px] field:border-2"
              title={pool.find((a) => a.id === c)?.label}
            >
              {c}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---- NUMBER -----------------------------------------------------------------------------------------------------

export function NumberControl({ spec, value, disabled, onChange, labelledBy }: ControlProps) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value === null || value === '' ? '' : String(value));
  }, [value]);
  const problem = numberProblem(spec, text === '' ? null : Number(text));
  return (
    <div className="space-y-1.5">
      <div className="flex items-stretch gap-2">
        <Input
          type="number"
          inputMode="decimal"
          step="any"
          aria-labelledby={labelledBy}
          className="font-mono tabular-nums"
          disabled={disabled}
          value={text}
          invalid={!!problem}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={() => {
            focused.current = false;
          }}
          onChange={(e) => {
            setText(e.target.value);
            const raw = e.target.value.trim();
            if (raw === '') onChange(null);
            else if (Number.isFinite(Number(raw))) onChange(Number(raw));
          }}
        />
        {spec.unit ? (
          <span className="flex min-w-[3.5rem] items-center justify-center rounded-lg border border-line bg-slate-100 px-3 text-sm font-semibold text-ink field:border-2 field:border-black">{spec.unit}</span>
        ) : null}
      </div>
      {problem ? (
        <p className="text-sm font-medium text-red-700">{problem}</p>
      ) : spec.min_value !== null || spec.max_value !== null ? (
        <p className="text-xs text-muted">
          Range {spec.min_value ?? '-'} to {spec.max_value ?? '-'}
          {spec.unit ? ` ${spec.unit}` : ''}
        </p>
      ) : null}
    </div>
  );
}

// ---- BOOLEAN (tri-state) ----------------------------------------------------------------------------------------

type Tri = 'unset' | 'yes' | 'no';

export function BooleanControl({ spec, value, disabled, onChange }: ControlProps) {
  const current: Tri = value === true || value === 'true' ? 'yes' : value === false || value === 'false' ? 'no' : 'unset';
  return (
    <SegmentedControl<Tri>
      ariaLabel={spec.label}
      value={current}
      disabled={disabled}
      onChange={(v) => onChange(v === 'yes' ? true : v === 'no' ? false : null)}
      options={[
        { value: 'unset', label: 'Not set' },
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ]}
      tones={{ yes: 'bg-emerald-600', no: 'bg-slate-700', unset: 'bg-slate-500' }}
    />
  );
}

// ---- TEXT -------------------------------------------------------------------------------------------------------

export function TextControl({ spec, value, disabled, onChange, labelledBy }: ControlProps) {
  const text = value === null ? '' : String(value);
  const max = spec.max_length ?? 400;
  return (
    <div className="space-y-1">
      <Textarea aria-labelledby={labelledBy} rows={3} maxLength={max} disabled={disabled} value={text} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} />
      <p className={cn('text-right text-xs tabular-nums', text.length >= max ? 'font-semibold text-red-700' : 'text-muted')}>
        {text.length} / {max}
      </p>
    </div>
  );
}
