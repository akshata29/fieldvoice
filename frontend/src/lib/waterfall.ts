/**
 * Timing waterfall math. The pipeline stages run one after another, so each bar starts where the previous one ended.
 * `total_ms` can exceed the sum of the stages (queueing, model switching, ...): the gap is shown as "other".
 */
import type { StageTiming } from '@/api/types';

export interface WaterfallSegment {
  stage: string;
  ms: number;
  startMs: number;
  startPct: number;
  widthPct: number;
  detail: Record<string, unknown>;
}

export interface Waterfall {
  segments: WaterfallSegment[];
  sumMs: number;
  totalMs: number;
  otherMs: number;
  otherPct: number;
}

export const STAGE_LABELS: Record<string, string> = {
  stt: 'Speech to text',
  normalize: 'Normalize',
  resolve: 'Resolve ids',
  llm: 'LLM',
  validate: 'Validate',
  other: 'Other',
};

/** Tailwind background classes per stage (kept as full literals so Tailwind can see them). */
export const STAGE_BG: Record<string, string> = {
  stt: 'bg-sky-500',
  normalize: 'bg-teal-500',
  resolve: 'bg-emerald-500',
  llm: 'bg-violet-500',
  validate: 'bg-amber-500',
  other: 'bg-slate-300',
};

export function stageBg(stage: string): string {
  return STAGE_BG[stage] ?? 'bg-slate-500';
}

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

export function buildWaterfall(timings: StageTiming[], totalMs?: number | null): Waterfall {
  const clean = timings.filter((t) => Number.isFinite(t.ms) && t.ms >= 0);
  const sumMs = clean.reduce((acc, t) => acc + t.ms, 0);
  const declared = typeof totalMs === 'number' && Number.isFinite(totalMs) && totalMs > 0 ? totalMs : 0;
  const total = Math.max(declared, sumMs);
  const otherMs = declared > sumMs ? declared - sumMs : 0;

  let cursor = 0;
  const segments = clean.map<WaterfallSegment>((t) => {
    const seg: WaterfallSegment = {
      stage: t.stage,
      ms: t.ms,
      startMs: cursor,
      startPct: total > 0 ? (cursor / total) * 100 : 0,
      widthPct: total > 0 ? (t.ms / total) * 100 : 0,
      detail: t.detail,
    };
    cursor += t.ms;
    return seg;
  });

  return { segments, sumMs, totalMs: total, otherMs, otherPct: total > 0 ? (otherMs / total) * 100 : 0 };
}
