/**
 * Decision gating for evaluation runs: which configurations pass the customer's gates, and which are Pareto-optimal
 * on (p95 latency, field accuracy). The real backend computes `GET /eval/runs/{id}/decision`; this helper backs the
 * mock and the unit tests, and defines the gate vocabulary the UI renders.
 */
import type { ConfigMetrics, DecisionGates, DecisionReport, DecisionRow, ParetoPoint } from '@/api/types';
import { fmtMb, fmtMs, fmtPct } from '@/lib/format';

export const DEFAULT_GATES: DecisionGates = {
  max_p95_ms: 5000,
  min_id_field_accuracy: 0.95,
  max_silent_wrong: 0.02,
  max_peak_rss_mb: null,
  min_field_accuracy: 0,
};

export type GateCode =
  | 'max_p95_ms'
  | 'min_id_field_accuracy'
  | 'max_silent_wrong'
  | 'max_peak_rss_mb'
  | 'min_field_accuracy'
  | 'no_successful_cases';

export const GATE_LABELS: Record<GateCode, string> = {
  max_p95_ms: 'p95 latency',
  min_id_field_accuracy: 'ID-field accuracy',
  max_silent_wrong: 'Silent-wrong rate',
  max_peak_rss_mb: 'Peak RAM',
  min_field_accuracy: 'Field accuracy',
  no_successful_cases: 'No successful cases',
};

export const isGateCode = (code: string): code is GateCode => code in GATE_LABELS;

const NO_CASES_TEXT = 'no case ran successfully (engine unavailable or failed to load)';

/** The gate verdicts for one configuration. Missing measurements fail the gates that need them (except n/a ID accuracy). */
export function failedGates(m: ConfigMetrics, gates: DecisionGates): GateCode[] {
  if (m.n_cases === 0 || m.n_errors >= m.n_cases) return ['no_successful_cases'];
  const failed: GateCode[] = [];
  const p95 = m.latency_total.p95;
  if (p95 === null || p95 > gates.max_p95_ms) failed.push('max_p95_ms');
  if (m.id_field_accuracy !== null && m.id_field_accuracy < gates.min_id_field_accuracy) failed.push('min_id_field_accuracy');
  if (m.silent_wrong_rate > gates.max_silent_wrong) failed.push('max_silent_wrong');
  if (gates.max_peak_rss_mb !== null && (m.peak_rss_mb === null || m.peak_rss_mb > gates.max_peak_rss_mb)) failed.push('max_peak_rss_mb');
  if (m.field_accuracy < gates.min_field_accuracy) failed.push('min_field_accuracy');
  return failed;
}

/** One-line explanation of why a gate failed, using the metrics when the code is one we know. */
export function explainGate(code: string, m: ConfigMetrics | undefined, gates: DecisionGates): string {
  if (code === 'no_successful_cases') return NO_CASES_TEXT;
  if (!isGateCode(code) || !m) return code;
  switch (code) {
    case 'no_successful_cases':
      return NO_CASES_TEXT;
    case 'max_p95_ms':
      return m.latency_total.p95 === null
        ? 'p95 latency not measured'
        : `p95 ${fmtMs(m.latency_total.p95)} is above ${fmtMs(gates.max_p95_ms)}`;
    case 'min_id_field_accuracy':
      return `ID-field accuracy ${fmtPct(m.id_field_accuracy)} is below ${fmtPct(gates.min_id_field_accuracy)}`;
    case 'max_silent_wrong':
      return `silent-wrong ${fmtPct(m.silent_wrong_rate)} is above ${fmtPct(gates.max_silent_wrong)}`;
    case 'max_peak_rss_mb':
      return m.peak_rss_mb === null
        ? 'peak RAM not measured'
        : `peak RAM ${fmtMb(m.peak_rss_mb)} is above ${fmtMb(gates.max_peak_rss_mb)}`;
    case 'min_field_accuracy':
      return `field accuracy ${fmtPct(m.field_accuracy)} is below ${fmtPct(gates.min_field_accuracy)}`;
  }
}

/** Keys of points not dominated by any other point (lower p95 is better, higher accuracy is better). */
export function paretoOptimalKeys(points: Array<{ config_key: string; p95_ms: number | null; field_accuracy: number }>): Set<string> {
  const usable = points.filter((p): p is { config_key: string; p95_ms: number; field_accuracy: number } => p.p95_ms !== null);
  const optimal = new Set<string>();
  for (const p of usable) {
    const dominated = usable.some(
      (q) =>
        q !== p &&
        q.p95_ms <= p.p95_ms &&
        q.field_accuracy >= p.field_accuracy &&
        (q.p95_ms < p.p95_ms || q.field_accuracy > p.field_accuracy),
    );
    if (!dominated) optimal.add(p.config_key);
  }
  return optimal;
}

/** Ranking score among passing configs: accuracy first, penalise silent errors and slowness. Higher is better. */
export function decisionScore(m: ConfigMetrics, gates: DecisionGates): number {
  const p95 = m.latency_total.p95 ?? gates.max_p95_ms;
  const speed = 1 - Math.min(1, p95 / Math.max(1, gates.max_p95_ms));
  return m.field_accuracy - 2 * m.silent_wrong_rate + 0.05 * speed;
}

export function evaluateGates(runId: string, configs: ConfigMetrics[], gates: DecisionGates): DecisionReport {
  const rows: DecisionRow[] = configs.map((m) => {
    const failed = failedGates(m, gates);
    return {
      config_key: m.config_key,
      passes: failed.length === 0,
      failed_gates: failed,
      score: decisionScore(m, gates),
      rank: null,
    };
  });
  rows
    .filter((r) => r.passes)
    .sort((a, b) => b.score - a.score)
    .forEach((r, i) => {
      r.rank = i + 1;
    });

  const base = configs.map((m) => ({ config_key: m.config_key, p95_ms: m.latency_total.p95, field_accuracy: m.field_accuracy }));
  const optimal = paretoOptimalKeys(base);
  const pareto: ParetoPoint[] = configs.map((m) => ({
    config_key: m.config_key,
    p95_ms: m.latency_total.p95,
    field_accuracy: m.field_accuracy,
    silent_wrong_rate: m.silent_wrong_rate,
    pareto_optimal: optimal.has(m.config_key),
  }));
  return { run_id: runId, gates, rows, pareto };
}
