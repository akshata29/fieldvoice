/** Compare extracted field values with ground truth (`expected`), and detect silent-wrong outcomes. */
import type { FieldStatus, FieldValue, Scalar } from '@/api/types';

export type FieldVerdict = 'correct' | 'wrong' | 'unknown';

export interface FieldDiffRow {
  key: string;
  expected: Scalar | undefined;
  hasExpected: boolean;
  actual: Scalar;
  status: FieldStatus;
  confidence: number;
  verdict: FieldVerdict;
  /** Wrong AND shown to the worker as confident + filled: the failure mode that matters most. */
  silentWrong: boolean;
  /** Wrong but flagged (needs_review / conflict / missing) so the worker would catch it. */
  flagged: boolean;
}

export interface DiffSummary {
  total: number;
  correct: number;
  wrong: number;
  silentWrong: number;
  flagged: number;
  unknown: number;
}

const isBlank = (v: Scalar | undefined): boolean => v === null || v === undefined || v === '';

export function valuesEqual(expected: Scalar | undefined, actual: Scalar | undefined): boolean {
  if (isBlank(expected) || isBlank(actual)) return isBlank(expected) && isBlank(actual);
  if (typeof expected === 'boolean' || typeof actual === 'boolean') {
    const toBool = (v: Scalar | undefined) => (typeof v === 'string' ? v.trim().toLowerCase() === 'true' : Boolean(v));
    return toBool(expected) === toBool(actual);
  }
  // Two strings are identifiers/labels: compare literally ("0123" is not "123"). Numbers compare numerically.
  if (typeof expected === 'string' && typeof actual === 'string') {
    return expected.trim().toLowerCase() === actual.trim().toLowerCase();
  }
  const numE = Number(expected);
  const numA = Number(actual);
  if (Number.isFinite(numE) && Number.isFinite(numA)) return Math.abs(numE - numA) < 1e-6;
  return String(expected).trim().toLowerCase() === String(actual).trim().toLowerCase();
}

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

export interface DiffOptions {
  /** Server-computed correctness (LabCompareItem.field_correct / CaseResult.field_correct) wins over the local comparison. */
  fieldCorrect?: Record<string, boolean> | null;
  confidenceThreshold?: number;
  /** Restrict / order the rows (e.g. the form's field order). Defaults to the union of expected and extracted keys. */
  keys?: string[];
}

export function diffFields(
  expected: Record<string, Scalar> | null | undefined,
  fields: Record<string, FieldValue>,
  options: DiffOptions = {},
): FieldDiffRow[] {
  const threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const keys = options.keys ?? Array.from(new Set([...Object.keys(expected ?? {}), ...Object.keys(fields)]));
  return keys.map<FieldDiffRow>((key) => {
    const fv = fields[key];
    const actual: Scalar = fv?.value ?? null;
    const status: FieldStatus = fv?.status ?? 'missing';
    const confidence = fv?.confidence ?? 0;
    const hasExpected = expected != null && Object.prototype.hasOwnProperty.call(expected, key);
    const provided = options.fieldCorrect?.[key];

    let verdict: FieldVerdict = 'unknown';
    if (typeof provided === 'boolean') verdict = provided ? 'correct' : 'wrong';
    else if (hasExpected) verdict = valuesEqual(expected?.[key], actual) ? 'correct' : 'wrong';

    const confident = status === 'filled' && confidence >= threshold && !isBlank(actual);
    return {
      key,
      expected: hasExpected ? expected?.[key] : undefined,
      hasExpected,
      actual,
      status,
      confidence,
      verdict,
      silentWrong: verdict === 'wrong' && confident,
      flagged: verdict === 'wrong' && !confident && (status === 'needs_review' || status === 'conflict' || status === 'missing'),
    };
  });
}

export function summarizeDiff(rows: FieldDiffRow[]): DiffSummary {
  const summary: DiffSummary = { total: rows.length, correct: 0, wrong: 0, silentWrong: 0, flagged: 0, unknown: 0 };
  for (const r of rows) {
    if (r.verdict === 'correct') summary.correct++;
    else if (r.verdict === 'wrong') summary.wrong++;
    else summary.unknown++;
    if (r.silentWrong) summary.silentWrong++;
    if (r.flagged) summary.flagged++;
  }
  return summary;
}
