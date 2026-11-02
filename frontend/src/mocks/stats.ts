import type { LatencyStats } from '@/api/types';

/** Linear-interpolated percentile of an unsorted sample (p in 0..100). */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] as number;
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac;
}

export const mean = (values: number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

export function latencyStats(values: number[]): LatencyStats {
  const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  return {
    n: values.length,
    mean: round(mean(values)),
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    max: round(values.length ? Math.max(...values) : null),
  };
}
