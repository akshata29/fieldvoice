/** Form-level logic: conditional requirements, completeness summary, value formatting, draft assembly. */
import type { FieldSpec, FieldValue, FormDraft, FormSchema, PhotoRef, Scalar, StageTiming, WorkOrder } from '@/api/types';
import { isBlankField, isBlankValue, type FieldValues } from '@/lib/fieldMerge';

/** `required` or `required_when` (every listed field currently holds the listed value). */
export function isRequired(spec: FieldSpec, values: FieldValues): boolean {
  if (spec.required) return true;
  if (!spec.required_when) return false;
  return Object.entries(spec.required_when).every(([key, expected]) => {
    const current = values[key]?.value;
    return !isBlankValue(current) && String(current) === expected;
  });
}

export interface FormSummary {
  total: number;
  filled: number;
  requiredMissing: FieldSpec[];
  needsReview: FieldSpec[];
  conflicts: FieldSpec[];
  outOfRange: FieldSpec[];
}

export function numberProblem(spec: FieldSpec, value: Scalar): string | null {
  if (spec.type !== 'number' || isBlankValue(value)) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 'Enter a number';
  if (spec.min_value !== null && n < spec.min_value) return `Must be at least ${spec.min_value}${spec.unit ? ` ${spec.unit}` : ''}`;
  if (spec.max_value !== null && n > spec.max_value) return `Must be at most ${spec.max_value}${spec.unit ? ` ${spec.unit}` : ''}`;
  return null;
}

export function summarizeForm(form: FormSchema, values: FieldValues): FormSummary {
  const summary: FormSummary = {
    total: form.fields.length,
    filled: 0,
    requiredMissing: [],
    needsReview: [],
    conflicts: [],
    outOfRange: [],
  };
  for (const spec of form.fields) {
    const fv = values[spec.key];
    const blank = isBlankField(fv);
    if (!blank) summary.filled++;
    if (blank && isRequired(spec, values)) summary.requiredMissing.push(spec);
    if (fv && fv.status === 'needs_review' && !blank) summary.needsReview.push(spec);
    if (fv && fv.status === 'conflict') summary.conflicts.push(spec);
    if (fv && numberProblem(spec, fv.value)) summary.outOfRange.push(spec);
  }
  return summary;
}

export function optionLabel(spec: FieldSpec, value: Scalar): string {
  const option = spec.options.find((o) => o.code === value);
  return option ? option.label : String(value ?? '');
}

/** Display text for a value (enum label, Yes/No, number + unit). */
export function formatFieldValue(spec: FieldSpec, value: Scalar): string {
  if (isBlankValue(value)) return '';
  switch (spec.type) {
    case 'enum':
      return optionLabel(spec, value);
    case 'boolean':
      return value === true || value === 'true' ? 'Yes' : 'No';
    case 'number':
      return `${value}${spec.unit ? ` ${spec.unit}` : ''}`;
    default:
      return String(value);
  }
}

export interface BuildDraftInput {
  workOrder: WorkOrder;
  form: FormSchema;
  values: FieldValues;
  transcript: string | null;
  sttEngineId: string | null;
  llmEngineId: string | null;
  strategyId: string | null;
  timings: StageTiming[];
  photos: PhotoRef[];
  now?: Date;
}

/** Drops the never-filled placeholders so drafts stay small; everything the worker or pipeline touched is kept. */
export function buildDraft(input: BuildDraftInput): FormDraft {
  const values: Record<string, FieldValue> = {};
  for (const spec of input.form.fields) {
    const fv = input.values[spec.key];
    if (fv && (fv.status !== 'missing' || !isBlankValue(fv.value) || fv.candidates.length > 0)) values[spec.key] = fv;
  }
  return {
    work_order_id: input.workOrder.id,
    form_id: input.form.id,
    form_version: input.form.version,
    base_version: input.workOrder.version,
    values,
    transcript: input.transcript,
    stt_engine_id: input.sttEngineId,
    llm_engine_id: input.llmEngineId,
    strategy_id: input.strategyId,
    timings: input.timings,
    photos: input.photos,
    status: 'draft',
    operation_id: null,
    updated_at: (input.now ?? new Date()).toISOString(),
    approved_at: null,
  };
}
