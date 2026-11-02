import { describe, expect, it } from 'vitest';
import type { FieldValue, FormSchema } from '@/api/types';
import { emptyFieldValue, mergeIntoForm, prefillValues, sameFieldValue, userFieldValue, confirmFieldValue, changedKeys } from '@/lib/fieldMerge';
import { formReducer, initialFormState, selectValues, type FormState } from '@/lib/formState';

const fv = (key: string, value: FieldValue['value'], over: Partial<FieldValue> = {}): FieldValue => ({
  key,
  value,
  source: 'rule',
  confidence: 0.9,
  status: 'filled',
  evidence: null,
  note: null,
  candidates: [],
  ...over,
});

describe('mergeIntoForm', () => {
  it('lets an extraction fill empty fields', () => {
    const merged = mergeIntoForm({}, { pole_id: fv('pole_id', '123') });
    expect(merged.pole_id?.value).toBe('123');
  });

  it('never overwrites a worker edit', () => {
    const base = { pole_id: userFieldValue('pole_id', '999') };
    const merged = mergeIntoForm(base, { pole_id: fv('pole_id', '123') });
    expect(merged.pole_id?.value).toBe('999');
    expect(merged.pole_id?.source).toBe('user');
  });

  it('lets the extraction replace earlier extractions (latest speech wins)', () => {
    const base = { pole_id: fv('pole_id', '123', { source: 'llm' }) };
    expect(mergeIntoForm(base, { pole_id: fv('pole_id', '124') }).pole_id?.value).toBe('124');
  });

  it('does not let an utterance that says nothing blank a value that is already there', () => {
    const base = { pole_id: fv('pole_id', '123') };
    const merged = mergeIntoForm(base, { pole_id: emptyFieldValue('pole_id') });
    expect(merged.pole_id?.value).toBe('123');
  });

  it('shows a needs-review candidate list when the field was empty', () => {
    const incoming = fv('pole_id', null, { status: 'needs_review', candidates: ['123', '128'] });
    expect(mergeIntoForm({}, { pole_id: incoming }).pole_id?.candidates).toEqual(['123', '128']);
  });

  it('lets the worker overwrite their own earlier edit only through an explicit edit', () => {
    const base = { kva: userFieldValue('kva', 25) };
    expect(mergeIntoForm(base, { kva: fv('kva', 50) }).kva?.value).toBe(25);
  });
});

describe('field value helpers', () => {
  it('userFieldValue marks edits as user / filled and clears to an unprotected missing value', () => {
    expect(userFieldValue('a', 'x')).toMatchObject({ source: 'user', status: 'filled', confidence: 1, value: 'x' });
    expect(userFieldValue('a', '')).toMatchObject({ source: null, status: 'missing', value: null });
    expect(userFieldValue('a', false)).toMatchObject({ source: 'user', status: 'filled', value: false });
    expect(userFieldValue('a', 0)).toMatchObject({ source: 'user', status: 'filled', value: 0 });
  });

  it('confirmFieldValue clears needs_review but keeps provenance', () => {
    const confirmed = confirmFieldValue(fv('a', 'x', { status: 'needs_review', source: 'llm' }));
    expect(confirmed).toMatchObject({ status: 'filled', source: 'llm' });
    const filled = fv('a', 'x');
    expect(confirmFieldValue(filled)).toBe(filled);
  });

  it('sameFieldValue / changedKeys detect display-relevant changes', () => {
    expect(sameFieldValue(fv('a', 1), fv('a', 1))).toBe(true);
    expect(sameFieldValue(fv('a', 1), fv('a', 2))).toBe(false);
    expect(sameFieldValue(fv('a', 1), fv('a', 1, { status: 'needs_review' }))).toBe(false);
    expect(changedKeys({ a: fv('a', 1), b: fv('b', 1) }, { a: fv('a', 1), b: fv('b', 2), c: fv('c', 3) }).sort()).toEqual(['b', 'c']);
  });

  it('prefillValues only creates entries for known keys with values', () => {
    const form = { fields: [{ key: 'a' }, { key: 'b' }] } as unknown as FormSchema;
    const values = prefillValues(form, { a: 'x', b: null, zzz: 'ignored' });
    expect(Object.keys(values)).toEqual(['a']);
    expect(values.a).toMatchObject({ source: 'prefill', status: 'filled' });
  });
});

describe('formReducer (progressive fill)', () => {
  const resolve = { pole_id: fv('pole_id', '123'), new_unit_id: fv('new_unit_id', '456') };
  const validate = {
    pole_id: fv('pole_id', '123'),
    new_unit_id: fv('new_unit_id', '456', { status: 'needs_review', confidence: 0.4 }),
    condition: fv('condition', 'leaking_oil', { source: 'llm' }),
  };

  it('fills fields as stage events arrive and later stages replace earlier ones by key', () => {
    let s: FormState = initialFormState();
    s = formReducer(s, { type: 'session_start' });
    s = formReducer(s, { type: 'session_fields', fields: resolve });
    expect(selectValues(s).new_unit_id?.status).toBe('filled');
    expect(s.dirty).toBe(true);
    s = formReducer(s, { type: 'session_fields', fields: validate });
    const values = selectValues(s);
    expect(values.new_unit_id?.status).toBe('needs_review'); // validate downgraded what resolve proposed
    expect(values.condition?.value).toBe('leaking_oil');
    expect(Object.keys(values).sort()).toEqual(['condition', 'new_unit_id', 'pole_id']);
  });

  it('bumps the flash sequence only for keys that changed', () => {
    let s = initialFormState();
    s = formReducer(s, { type: 'session_fields', fields: resolve });
    expect(s.flashSeq).toEqual({ pole_id: 1, new_unit_id: 1 });
    s = formReducer(s, { type: 'session_fields', fields: { pole_id: fv('pole_id', '123') } }); // identical -> no flash
    expect(s.flashSeq).toEqual({ pole_id: 1, new_unit_id: 1 });
    s = formReducer(s, { type: 'session_fields', fields: { new_unit_id: fv('new_unit_id', '789') } });
    expect(s.flashSeq).toEqual({ pole_id: 1, new_unit_id: 2 });
  });

  it('commit folds the session into the base so the next utterance starts from it', () => {
    let s = initialFormState();
    s = formReducer(s, { type: 'session_fields', fields: resolve });
    s = formReducer(s, { type: 'session_commit', fields: validate });
    expect(s.session).toEqual({});
    expect(s.base.condition?.value).toBe('leaking_oil');
    expect(s.sessionKeys.sort()).toEqual(['condition', 'new_unit_id', 'pole_id']);
    s = formReducer(s, { type: 'session_start' });
    expect(selectValues(s).condition?.value).toBe('leaking_oil');
    expect(s.sessionKeys).toEqual([]);
  });

  it('protects worker edits made mid-session and drops them from the session snapshot', () => {
    let s = initialFormState();
    s = formReducer(s, { type: 'session_fields', fields: resolve });
    s = formReducer(s, { type: 'edit', key: 'pole_id', value: '124' });
    s = formReducer(s, { type: 'session_fields', fields: validate });
    expect(selectValues(s).pole_id).toMatchObject({ value: '124', source: 'user' });
    expect(s.sessionKeys).not.toContain('pole_id');
  });

  it('a second utterance never blanks earlier values and does not claim evidence for kept ones', () => {
    let s = initialFormState();
    s = formReducer(s, { type: 'session_commit', fields: validate });
    s = formReducer(s, { type: 'session_start' });
    s = formReducer(s, { type: 'session_commit', fields: { pole_id: emptyFieldValue('pole_id'), kva: fv('kva', 25) } });
    const values = selectValues(s);
    expect(values.pole_id?.value).toBe('123');
    expect(values.kva?.value).toBe(25);
    expect(s.sessionKeys).toEqual(['kva']);
  });

  it('confirm turns needs_review into filled; saved clears dirty; load resets', () => {
    let s = initialFormState();
    s = formReducer(s, { type: 'session_commit', fields: validate });
    s = formReducer(s, { type: 'confirm', key: 'new_unit_id' });
    expect(selectValues(s).new_unit_id?.status).toBe('filled');
    expect(s.dirty).toBe(true);
    s = formReducer(s, { type: 'saved' });
    expect(s.dirty).toBe(false);
    s = formReducer(s, { type: 'load', values: { a: fv('a', 1) } });
    expect(Object.keys(selectValues(s))).toEqual(['a']);
    expect(s.dirty).toBe(false);
  });
});
