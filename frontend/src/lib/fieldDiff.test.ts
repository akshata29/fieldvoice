import { describe, expect, it } from 'vitest';
import type { FieldValue } from '@/api/types';
import { diffFields, summarizeDiff, valuesEqual } from '@/lib/fieldDiff';

const fv = (key: string, value: FieldValue['value'], over: Partial<FieldValue> = {}): FieldValue => ({
  key,
  value,
  source: 'rule',
  confidence: 0.95,
  status: value === null ? 'missing' : 'filled',
  evidence: null,
  note: null,
  candidates: [],
  ...over,
});

describe('valuesEqual', () => {
  it('treats null / undefined / empty string as "left empty"', () => {
    expect(valuesEqual(null, null)).toBe(true);
    expect(valuesEqual(null, undefined)).toBe(true);
    expect(valuesEqual('', null)).toBe(true);
    expect(valuesEqual(null, 'x')).toBe(false);
    expect(valuesEqual('x', null)).toBe(false);
  });

  it('compares identifiers literally (case-insensitive) but numbers numerically', () => {
    expect(valuesEqual('123', '123')).toBe(true);
    expect(valuesEqual('T4471', 't4471 ')).toBe(true);
    expect(valuesEqual('0123', '123')).toBe(false);
    expect(valuesEqual(25, '25')).toBe(true);
    expect(valuesEqual(25, 25.0000001)).toBe(true);
    expect(valuesEqual(25, 26)).toBe(false);
  });

  it('compares booleans, including string booleans', () => {
    expect(valuesEqual(true, true)).toBe(true);
    expect(valuesEqual(true, 'true')).toBe(true);
    expect(valuesEqual(false, 'false')).toBe(true);
    expect(valuesEqual(true, false)).toBe(false);
  });
});

describe('diffFields', () => {
  const expected = { pole_id: '123', new_unit_id: '456', condition: 'leaking_oil', customer_notified: null, kva: 25 };
  const fields = {
    pole_id: fv('pole_id', '123'),
    new_unit_id: fv('new_unit_id', '465'), // wrong and confident -> silent wrong
    condition: fv('condition', 'corroded', { status: 'needs_review', confidence: 0.5 }), // wrong but flagged
    customer_notified: fv('customer_notified', null), // expected empty, left empty -> correct
    extra: fv('extra', 'hello'), // no ground truth
  };

  it('classifies each field against the ground truth', () => {
    const rows = Object.fromEntries(diffFields(expected, fields).map((r) => [r.key, r]));
    expect(rows.pole_id?.verdict).toBe('correct');
    expect(rows.new_unit_id).toMatchObject({ verdict: 'wrong', silentWrong: true, flagged: false });
    expect(rows.condition).toMatchObject({ verdict: 'wrong', silentWrong: false, flagged: true });
    expect(rows.customer_notified?.verdict).toBe('correct');
    expect(rows.extra).toMatchObject({ verdict: 'unknown', hasExpected: false });
    expect(rows.kva).toMatchObject({ verdict: 'wrong', actual: null, silentWrong: false, flagged: true }); // expected 25, field absent
  });

  it('counts a confidently filled value where nothing was expected as silent wrong (hallucination)', () => {
    const [row] = diffFields({ notes: null }, { notes: fv('notes', 'made up') });
    expect(row).toMatchObject({ verdict: 'wrong', silentWrong: true });
  });

  it('respects the confidence threshold', () => {
    const low = fv('pole_id', '999', { confidence: 0.6 });
    expect(diffFields({ pole_id: '123' }, { pole_id: low })[0]?.silentWrong).toBe(false);
    expect(diffFields({ pole_id: '123' }, { pole_id: low }, { confidenceThreshold: 0.5 })[0]?.silentWrong).toBe(true);
  });

  it('prefers server-provided correctness over the local comparison', () => {
    const rows = diffFields({ pole_id: '123' }, { pole_id: fv('pole_id', '123') }, { fieldCorrect: { pole_id: false } });
    expect(rows[0]?.verdict).toBe('wrong');
  });

  it('returns unknown for everything without ground truth and honours key order', () => {
    const rows = diffFields(null, fields, { keys: ['extra', 'pole_id'] });
    expect(rows.map((r) => r.key)).toEqual(['extra', 'pole_id']);
    expect(rows.every((r) => r.verdict === 'unknown')).toBe(true);
  });

  it('summarises counts', () => {
    const summary = summarizeDiff(diffFields(expected, fields));
    expect(summary).toEqual({ total: 6, correct: 2, wrong: 3, silentWrong: 1, flagged: 2, unknown: 1 });
  });
});
