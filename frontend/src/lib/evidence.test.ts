import { describe, expect, it } from 'vitest';
import type { FieldValue } from '@/api/types';
import { buildSegments, locateEvidence, spansFromFields } from '@/lib/evidence';

const text = 'i replaced the transformer at pole 123. the old unit was leaking oil and i installed unit 456.';

describe('locateEvidence', () => {
  it('accepts offsets that match the evidence text', () => {
    const start = text.indexOf('123');
    expect(locateEvidence(text, { start, end: start + 3, text: '123' })).toEqual({ start, end: start + 3 });
  });

  it('falls back to a literal search when the offsets are stale', () => {
    expect(locateEvidence(text, { start: 0, end: 3, text: 'pole 123' })).toEqual({ start: text.indexOf('pole 123'), end: text.indexOf('pole 123') + 8 });
  });

  it('returns null when the evidence is not in the transcript or is malformed', () => {
    expect(locateEvidence(text, { start: 0, end: 5, text: 'zzzz' })).toBeNull();
    expect(locateEvidence(text, { start: 5, end: 5, text: '' })).toBeNull();
    expect(locateEvidence('', { start: 0, end: 1, text: 'a' })).toBeNull();
  });
});

describe('buildSegments', () => {
  const pole = { key: 'pole_id', start: text.indexOf('pole 123'), end: text.indexOf('pole 123') + 8 };
  const unit = { key: 'new_unit_id', start: text.indexOf('unit 456'), end: text.indexOf('unit 456') + 8 };

  it('splits the transcript around spans and marks the focused one', () => {
    const segments = buildSegments(text, [pole, unit], 'pole_id');
    expect(segments.map((s) => s.text).join('')).toBe(text);
    const focused = segments.filter((s) => s.focused);
    expect(focused).toHaveLength(1);
    expect(focused[0]?.text).toBe('pole 123');
    expect(segments.filter((s) => s.keys.includes('new_unit_id'))[0]?.text).toBe('unit 456');
  });

  it('handles overlapping spans by splitting at every boundary', () => {
    const segments = buildSegments('abcdef', [
      { key: 'x', start: 0, end: 4 },
      { key: 'y', start: 2, end: 6 },
    ]);
    expect(segments.map((s) => [s.text, s.keys])).toEqual([
      ['ab', ['x']],
      ['cd', ['x', 'y']],
      ['ef', ['y']],
    ]);
  });

  it('returns one plain segment without spans, nothing for an empty transcript, and ignores invalid spans', () => {
    expect(buildSegments('hello', [])).toEqual([{ text: 'hello', keys: [], focused: false }]);
    expect(buildSegments('', [{ key: 'x', start: 0, end: 1 }])).toEqual([]);
    expect(buildSegments('hello', [{ key: 'x', start: 4, end: 2 }, { key: 'y', start: 99, end: 120 }])).toHaveLength(1);
  });

  it('clamps spans that run past the end', () => {
    const segments = buildSegments('hello', [{ key: 'x', start: 3, end: 50 }], 'x');
    expect(segments.map((s) => s.text)).toEqual(['hel', 'lo']);
    expect(segments[1]?.focused).toBe(true);
  });
});

describe('spansFromFields', () => {
  const field = (key: string, evidence: FieldValue['evidence']): FieldValue => ({
    key,
    value: 'x',
    source: 'rule',
    confidence: 1,
    status: 'filled',
    evidence,
    note: null,
    candidates: [],
  });

  it('collects located spans and can restrict to the keys of the latest extraction', () => {
    const fields = {
      pole_id: field('pole_id', { start: text.indexOf('123'), end: text.indexOf('123') + 3, text: '123' }),
      stale: field('stale', { start: 0, end: 4, text: 'not in transcript' }),
      none: field('none', null),
    };
    expect(spansFromFields(text, fields).map((s) => s.key)).toEqual(['pole_id']);
    expect(spansFromFields(text, fields, ['stale'])).toEqual([]);
  });
});
