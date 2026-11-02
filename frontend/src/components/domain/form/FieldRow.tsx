import { useId, useRef, useState } from 'react';
import { CheckIcon, QuestionMarkCircleIcon, XMarkIcon } from '@heroicons/react/20/solid';
import type { Asset, FieldSpec, FieldValue, Scalar } from '@/api/types';
import { Button, IconButton } from '@/components/ui/Button';
import { useDismiss } from '@/components/ui/Tooltip';
import { cn } from '@/lib/cn';
import { emptyFieldValue, isBlankField } from '@/lib/fieldMerge';
import { formatFieldValue } from '@/lib/formLogic';
import { FieldSourceBadge, FieldStatusBadge } from '@/components/domain/StatusBadges';
import { BooleanControl, EntityControl, EnumControl, NumberControl, TextControl } from './FieldControls';

const STATUS_BORDER: Record<FieldValue['status'], string> = {
  filled: 'border-l-emerald-500',
  needs_review: 'border-l-amber-500',
  conflict: 'border-l-red-500',
  missing: 'border-l-slate-300',
};

export function ConfidenceBar({ value, className }: { value: number; className?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const tone = value >= 0.8 ? 'bg-emerald-500' : value >= 0.5 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className={cn('flex items-center gap-2', className)} role="meter" aria-label="Confidence" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200 field:border field:border-black">
        <span className={cn('block h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-xs font-semibold tabular-nums text-muted">{pct}%</span>
    </div>
  );
}

function WhyPopover({
  spec,
  fv,
  canShowEvidence,
  disabled,
  onShowEvidence,
  onPick,
  onClose,
}: {
  spec: FieldSpec;
  fv: FieldValue;
  canShowEvidence: boolean;
  disabled: boolean;
  onShowEvidence: () => void;
  onPick: (value: Scalar) => void;
  onClose: () => void;
}) {
  const sourceText: Record<string, string> = {
    rule: 'matched by the deterministic rules against the form lexicon and the job assets',
    embedding: 'matched by semantic similarity',
    llm: 'proposed by the on-device language model',
    user: 'entered or edited by you',
    prefill: 'pre-filled by dispatch',
  };
  return (
    <div role="dialog" aria-label={`Why ${spec.label} has this value`} className="absolute right-0 top-full z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-4 text-sm shadow-pop field:border-2 field:border-black">
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="font-semibold text-ink">Why this value?</p>
        <IconButton icon={XMarkIcon} label="Close" size="sm" onClick={onClose} />
      </div>
      {isBlankField(fv) && fv.candidates.length === 0 ? (
        <p className="text-muted">Nothing was found for this field, so it was left empty on purpose. Fields are never guessed.</p>
      ) : (
        <dl className="space-y-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Value</dt>
            <dd className="font-medium text-ink">{formatFieldValue(spec, fv.value) || 'empty'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Source</dt>
            <dd className="text-ink">{fv.source ? `${fv.source} - ${sourceText[fv.source] ?? ''}` : 'unknown'}</dd>
          </div>
          {fv.source !== 'user' && fv.source !== 'prefill' ? (
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Confidence</dt>
              <dd>
                <ConfidenceBar value={fv.confidence} />
              </dd>
            </div>
          ) : null}
          {fv.evidence ? (
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Evidence in the transcript</dt>
              <dd>
                <blockquote className="rounded-md border-l-4 border-yellow-400 bg-yellow-50 px-2 py-1 text-ink">"{fv.evidence.text}"</blockquote>
                {canShowEvidence ? (
                  <Button size="sm" variant="ghost" className="mt-1" onClick={onShowEvidence}>
                    Highlight in transcript
                  </Button>
                ) : (
                  <p className="mt-1 text-xs text-muted">The transcript this came from is no longer on screen.</p>
                )}
              </dd>
            </div>
          ) : null}
          {fv.note ? (
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Note</dt>
              <dd className="text-ink">{fv.note}</dd>
            </div>
          ) : null}
        </dl>
      )}
      {fv.candidates.length > 0 ? (
        <div className="mt-3 border-t border-line/70 pt-3">
          <p className="mb-1.5 text-xs uppercase tracking-wide text-muted">Other candidates</p>
          <div className="flex flex-wrap gap-1.5">
            {fv.candidates.map((c) => (
              <button
                key={c}
                type="button"
                disabled={disabled}
                onClick={() => onPick(c)}
                className="min-h-[36px] rounded-full border border-line bg-surface px-3 text-sm font-semibold text-ink hover:bg-slate-50 disabled:opacity-50 field:min-h-[44px] field:border-2"
              >
                {spec.type === 'enum' ? (spec.options.find((o) => o.code === c)?.label ?? c) : c}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface FieldRowProps {
  spec: FieldSpec;
  value: FieldValue | undefined;
  assets: Asset[];
  required: boolean;
  disabled: boolean;
  flashSeq: number;
  active: boolean;
  /** The field's evidence is highlightable in the transcript that is on screen. */
  evidenceVisible: boolean;
  onEdit: (value: Scalar) => void;
  onConfirm: () => void;
  onActivate: (key: string | null, via: 'hover' | 'focus') => void;
  onShowEvidence: (key: string) => void;
}

export function FieldRow({ spec, value, assets, required, disabled, flashSeq, active, evidenceVisible, onEdit, onConfirm, onActivate, onShowEvidence }: FieldRowProps) {
  const fv = value ?? emptyFieldValue(spec.key);
  const labelId = useId();
  const [why, setWhy] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  useDismiss(popRef, why, () => setWhy(false));
  const blank = isBlankField(fv);
  const needsAttention = fv.status === 'needs_review' || fv.status === 'conflict';

  const common = { spec, value: fv.value, disabled, onChange: onEdit, labelledBy: labelId };
  const control = (() => {
    switch (spec.type) {
      case 'enum':
        return <EnumControl {...common} />;
      case 'entity_ref':
        return <EntityControl {...common} assets={assets} candidates={fv.status === 'needs_review' || fv.status === 'conflict' ? fv.candidates : []} />;
      case 'number':
        return <NumberControl {...common} />;
      case 'boolean':
        return <BooleanControl {...common} />;
      default:
        return <TextControl {...common} />;
    }
  })();

  return (
    <div
      data-field={spec.key}
      className={cn(
        'relative rounded-xl border border-line border-l-[6px] bg-surface p-3 transition-shadow sm:p-4 field:border-2 field:border-l-[10px] field:border-black',
        STATUS_BORDER[fv.status],
        active && 'shadow-[0_0_0_3px_rgb(250_204_21/0.7)]',
      )}
      onMouseEnter={() => onActivate(spec.key, 'hover')}
      onMouseLeave={() => onActivate(null, 'hover')}
      onFocusCapture={() => onActivate(spec.key, 'focus')}
      onBlurCapture={() => onActivate(null, 'focus')}
    >
      {flashSeq > 0 ? <span key={flashSeq} className="pointer-events-none absolute inset-0 animate-flash rounded-xl" aria-hidden="true" /> : null}

      <div className="mb-2 flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p id={labelId} className="text-base font-semibold leading-6 text-ink">
            {spec.label}
            {required ? (
              <span className="ml-1 text-red-600" title="Required" aria-label="required">
                *
              </span>
            ) : null}
          </p>
          {spec.help ? <p className="text-xs text-muted">{spec.help}</p> : null}
        </div>
        <div className="relative flex shrink-0 items-center gap-1.5" ref={popRef}>
          <FieldStatusBadge status={fv.status} />
          {!blank ? <FieldSourceBadge source={fv.source} /> : null}
          <IconButton
            icon={QuestionMarkCircleIcon}
            label={`Why ${spec.label} has this value`}
            size="sm"
            aria-expanded={why}
            onClick={() => setWhy((v) => !v)}
          />
          {why ? (
            <WhyPopover
              spec={spec}
              fv={fv}
              canShowEvidence={evidenceVisible}
              disabled={disabled}
              onShowEvidence={() => {
                onShowEvidence(spec.key);
                setWhy(false);
              }}
              onPick={(v) => {
                onEdit(v);
                setWhy(false);
              }}
              onClose={() => setWhy(false)}
            />
          ) : null}
        </div>
      </div>

      {control}

      {(!blank && fv.source !== 'user' && fv.source !== 'prefill') || needsAttention || fv.note ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {!blank && fv.source !== 'user' && fv.source !== 'prefill' ? <ConfidenceBar value={fv.confidence} /> : null}
            {fv.note ? <span className="text-xs text-amber-800">{fv.note}</span> : null}
          </div>
          {needsAttention && !blank && !disabled ? (
            <Button size="sm" variant="secondary" icon={CheckIcon} onClick={onConfirm}>
              Confirm value
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
