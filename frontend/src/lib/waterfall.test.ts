import { describe, expect, it } from 'vitest';
import type { StageTiming } from '@/api/types';
import { buildWaterfall, stageBg, stageLabel } from '@/lib/waterfall';

const t = (stage: string, ms: number): StageTiming => ({ stage, ms, detail: {} });

describe('buildWaterfall', () => {
  it('lays stages end to end and computes percentages of the total', () => {
    const w = buildWaterfall([t('stt', 300), t('normalize', 10), t('resolve', 40), t('llm', 600), t('validate', 50)], 1000);
    expect(w.sumMs).toBe(1000);
    expect(w.totalMs).toBe(1000);
    expect(w.otherMs).toBe(0);
    expect(w.segments.map((s) => s.startMs)).toEqual([0, 300, 310, 350, 950]);
    expect(w.segments.map((s) => s.widthPct)).toEqual([30, 1, 4, 60, 5]);
    expect(w.segments.map((s) => s.startPct)).toEqual([0, 30, 31, 35, 95]);
  });

  it('adds an "other" gap when total_ms exceeds the sum of the stages', () => {
    const w = buildWaterfall([t('stt', 200), t('llm', 300)], 1000);
    expect(w.totalMs).toBe(1000);
    expect(w.otherMs).toBe(500);
    expect(w.otherPct).toBe(50);
    expect(w.segments[1]?.widthPct).toBe(30);
  });

  it('never lets segments exceed 100% when total_ms is smaller than the sum', () => {
    const w = buildWaterfall([t('stt', 600), t('llm', 600)], 500);
    expect(w.totalMs).toBe(1200);
    expect(w.otherMs).toBe(0);
    expect(w.segments.reduce((acc, s) => acc + s.widthPct, 0)).toBeCloseTo(100, 6);
  });

  it('falls back to the sum when no total is given', () => {
    const w = buildWaterfall([t('stt', 100), t('resolve', 100)]);
    expect(w.totalMs).toBe(200);
    expect(w.segments[0]?.widthPct).toBe(50);
  });

  it('handles empty, zero and invalid timings without NaN', () => {
    expect(buildWaterfall([], 0)).toMatchObject({ segments: [], totalMs: 0, otherMs: 0, otherPct: 0 });
    const zero = buildWaterfall([t('stt', 0)], 0);
    expect(zero.segments[0]?.widthPct).toBe(0);
    const bad = buildWaterfall([t('stt', Number.NaN), t('llm', -5), t('resolve', 10)], 10);
    expect(bad.segments).toHaveLength(1);
    expect(bad.segments[0]?.stage).toBe('resolve');
  });

  it('keeps stage detail for tooltips', () => {
    const w = buildWaterfall([{ stage: 'llm', ms: 5, detail: { tokens: 12 } }], 5);
    expect(w.segments[0]?.detail).toEqual({ tokens: 12 });
  });
});

describe('stage presentation', () => {
  it('has labels and colours for known stages and a fallback for unknown ones', () => {
    expect(stageLabel('stt')).toBe('Speech to text');
    expect(stageLabel('custom_stage')).toBe('custom_stage');
    expect(stageBg('llm')).toBe('bg-violet-500');
    expect(stageBg('custom_stage')).toBe('bg-slate-500');
  });
});
