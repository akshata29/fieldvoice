/** Pure helpers for combining extraction output with what the worker already has on the form. */
import type { FormSchema, FieldValue, Scalar } from '@/api/types';

export type FieldValues = Record<string, FieldValue>;

export function emptyFieldValue(key: string): FieldValue {
  return { key, value: null, source: null, confidence: 0, status: 'missing', evidence: null, note: null, candidates: [] };
}

export function isBlankValue(v: Scalar | undefined): boolean {
  return v === null || v === undefined || v === '';
}

export function isBlankField(fv: FieldValue | undefined): boolean {
  return !fv || isBlankValue(fv.value);
}

/** A worker edit: source `user`, status `filled`, full confidence. Clearing a field leaves it missing and unprotected. */
export function userFieldValue(key: string, value: Scalar): FieldValue {
  if (isBlankValue(value)) return emptyFieldValue(key);
  return { key, value, source: 'user', confidence: 1, status: 'filled', evidence: null, note: null, candidates: [] };
}

/** The worker confirms a proposed value without changing it: it stops needing review but keeps its provenance. */
export function confirmFieldValue(fv: FieldValue): FieldValue {
  if (fv.status !== 'needs_review' && fv.status !== 'conflict') return fv;
  return { ...fv, status: 'filled', note: fv.note ?? 'Confirmed by worker' };
}

export function prefillValues(form: FormSchema, prefill: Record<string, Scalar>): FieldValues {
  const out: FieldValues = {};
  for (const spec of form.fields) {
    const v = prefill[spec.key];
    if (v !== undefined && !isBlankValue(v)) {
      out[spec.key] = { key: spec.key, value: v, source: 'prefill', confidence: 1, status: 'filled', evidence: null, note: null, candidates: [] };
    }
  }
  return out;
}

export function sameFieldValue(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.value === b.value &&
    a.status === b.status &&
    a.source === b.source &&
    a.confidence === b.confidence &&
    a.evidence?.start === b.evidence?.start &&
    a.evidence?.end === b.evidence?.end
  );
}

/** Keys whose displayed value/status/provenance differs between two snapshots. */
export function changedKeys(before: FieldValues, after: FieldValues): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Array.from(keys).filter((k) => !sameFieldValue(before[k], after[k]));
}

/**
 * Overlay one extraction session on the form values the worker already has.
 * - worker edits are never overwritten;
 * - an utterance that says nothing about a field never blanks a value that is already there;
 * - everything else: the extraction wins (latest speech beats earlier extractions).
 */
export function mergeIntoForm(base: FieldValues, session: FieldValues): FieldValues {
  const out: FieldValues = { ...base };
  for (const [key, incoming] of Object.entries(session)) {
    const current = base[key];
    if (current && current.source === 'user' && !isBlankField(current)) continue;
    if (isBlankField(incoming) && !isBlankField(current)) continue;
    out[key] = incoming;
  }
  return out;
}
