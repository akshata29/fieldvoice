import { describe, expect, it } from 'vitest';
import type { ConfigMetrics, DecisionGates, LatencyStats } from '@/api/types';
import { DEFAULT_GATES, evaluateGates, explainGate, failedGates, paretoOptimalKeys } from '@/lib/gates';

const lat = (p95: number | null): LatencyStats => ({ n: 10, mean: p95 === null ? null : p95 / 2, p50: p95 === null ? null : p95 / 2, p95, max: p95 });

function metrics(key: string, over: Partial<ConfigMetrics> = {}): ConfigMetrics {
  return {
    config_key: key,
    config: { stt_engine_id: 'oracle:stt:transcript', llm_engine_id: 'rules:llm:none', strategy_id: 'rules_only' },
    n_cases: 10,
    n_errors: 0,
    wer: null,
    wer_normalized: null,
    id_exact_match: null,
    rtf: null,
    field_accuracy: 0.9,
    id_field_accuracy: 0.97,
    accuracy_by_type: {},
    accuracy_by_tag: {},
    form_exact_match: 0.7,
    silent_wrong_rate: 0.01,
    hallucination_rate: null,
    review_rate: 0.1,
    safe_outcome_rate: 0.95,
    schema_valid_rate: null,
    latency_total: lat(2000),
    latency_stt: lat(null),
    latency_extract: lat(null),
    latency_llm: lat(null),
    llm_prompt_tokens_mean: null,
    llm_output_tokens_mean: null,
    cold_start_ms: null,
    peak_rss_mb: 900,
    model_size_mb: 500,
    ...over,
  };
}

describe('failedGates', () => {
  it('passes a config that meets every default gate', () => {
    expect(failedGates(metrics('ok'), DEFAULT_GATES)).toEqual([]);
  });

  it('reports each failing gate by code', () => {
    const m = metrics('bad', {
      latency_total: lat(7000),
      id_field_accuracy: 0.9,
      silent_wrong_rate: 0.05,
      field_accuracy: 0.5,
    });
    expect(failedGates(m, { ...DEFAULT_GATES, min_field_accuracy: 0.6 })).toEqual([
      'max_p95_ms',
      'min_id_field_accuracy',
      'max_silent_wrong',
      'min_field_accuracy',
    ]);
  });

  it('treats gate boundaries as inclusive', () => {
    const m = metrics('edge', { latency_total: lat(5000), id_field_accuracy: 0.95, silent_wrong_rate: 0.02 });
    expect(failedGates(m, DEFAULT_GATES)).toEqual([]);
  });

  it('only applies the RAM gate when set, and fails when RAM was not measured', () => {
    const m = metrics('ram', { peak_rss_mb: 3000 });
    expect(failedGates(m, DEFAULT_GATES)).toEqual([]);
    expect(failedGates(m, { ...DEFAULT_GATES, max_peak_rss_mb: 2048 })).toEqual(['max_peak_rss_mb']);
    expect(failedGates(metrics('none', { peak_rss_mb: null }), { ...DEFAULT_GATES, max_peak_rss_mb: 2048 })).toEqual(['max_peak_rss_mb']);
  });

  it('fails latency when p95 is missing but ignores n/a ID accuracy', () => {
    expect(failedGates(metrics('n/a', { latency_total: lat(null), id_field_accuracy: null }), DEFAULT_GATES)).toEqual(['max_p95_ms']);
  });
});

describe('paretoOptimalKeys', () => {
  it('keeps points that no other point beats on both latency and accuracy', () => {
    const optimal = paretoOptimalKeys([
      { config_key: 'fast-ok', p95_ms: 500, field_accuracy: 0.8 },
      { config_key: 'slow-best', p95_ms: 4000, field_accuracy: 0.97 },
      { config_key: 'dominated', p95_ms: 4500, field_accuracy: 0.9 }, // slower and worse than slow-best
      { config_key: 'mid', p95_ms: 1500, field_accuracy: 0.9 },
      { config_key: 'no-latency', p95_ms: null, field_accuracy: 0.99 },
    ]);
    expect(Array.from(optimal).sort()).toEqual(['fast-ok', 'mid', 'slow-best']);
  });

  it('keeps ties (identical points do not dominate each other)', () => {
    const optimal = paretoOptimalKeys([
      { config_key: 'a', p95_ms: 1000, field_accuracy: 0.9 },
      { config_key: 'b', p95_ms: 1000, field_accuracy: 0.9 },
    ]);
    expect(optimal.size).toBe(2);
  });
});

describe('evaluateGates', () => {
  const configs = [
    metrics('a', { field_accuracy: 0.97, latency_total: lat(4000) }),
    metrics('b', { field_accuracy: 0.92, latency_total: lat(800) }),
    metrics('c', { silent_wrong_rate: 0.2, field_accuracy: 0.99, latency_total: lat(4900) }),
    metrics('d', { latency_total: lat(9000), field_accuracy: 0.95 }),
  ];

  it('ranks only the passing configs, best score first', () => {
    const report = evaluateGates('run-1', configs, DEFAULT_GATES);
    expect(report.run_id).toBe('run-1');
    const byKey = Object.fromEntries(report.rows.map((r) => [r.config_key, r]));
    expect(byKey.a?.passes).toBe(true);
    expect(byKey.b?.passes).toBe(true);
    expect(byKey.c).toMatchObject({ passes: false, failed_gates: ['max_silent_wrong'], rank: null });
    expect(byKey.d).toMatchObject({ passes: false, failed_gates: ['max_p95_ms'], rank: null });
    expect(byKey.a?.rank).toBe(1);
    expect(byKey.b?.rank).toBe(2);
  });

  it('re-evaluates when gates change', () => {
    const strict: DecisionGates = { ...DEFAULT_GATES, max_p95_ms: 1000 };
    const report = evaluateGates('run-1', configs, strict);
    expect(report.rows.filter((r) => r.passes).map((r) => r.config_key)).toEqual(['b']);
    expect(report.gates).toEqual(strict);
  });

  it('flags Pareto-optimal points regardless of the gates', () => {
    const report = evaluateGates('run-1', configs, DEFAULT_GATES);
    const optimal = report.pareto.filter((p) => p.pareto_optimal).map((p) => p.config_key).sort();
    expect(optimal).toEqual(['a', 'b', 'c']); // d (9000 ms, 0.95) is dominated by a (4000 ms, 0.97)
  });
});

describe('explainGate', () => {
  it('describes known gates using the metrics and echoes unknown codes', () => {
    const m = metrics('x', { latency_total: lat(7100), silent_wrong_rate: 0.05 });
    expect(explainGate('max_p95_ms', m, DEFAULT_GATES)).toMatch(/7\.10 s.*5\.00 s/);
    expect(explainGate('max_silent_wrong', m, DEFAULT_GATES)).toMatch(/5\.0%.*2\.0%/);
    expect(explainGate('something_else', m, DEFAULT_GATES)).toBe('something_else');
    expect(explainGate('max_p95_ms', undefined, DEFAULT_GATES)).toBe('max_p95_ms');
  });

  it('explains no_successful_cases (unavailable engine) with or without metrics', () => {
    expect(explainGate('no_successful_cases', undefined, DEFAULT_GATES)).toMatch(/engine unavailable/);
    expect(explainGate('no_successful_cases', metrics('x'), DEFAULT_GATES)).toMatch(/no case ran successfully/);
  });
});

describe('failedGates for engines that never ran', () => {
  it('returns only no_successful_cases when every case errored or there were no cases', () => {
    expect(failedGates(metrics('dead', { n_cases: 3, n_errors: 3, latency_total: lat(null) }), DEFAULT_GATES)).toEqual(['no_successful_cases']);
    expect(failedGates(metrics('empty', { n_cases: 0, n_errors: 0 }), DEFAULT_GATES)).toEqual(['no_successful_cases']);
  });

  it('still judges configs where only some cases errored', () => {
    expect(failedGates(metrics('flaky', { n_cases: 10, n_errors: 4 }), DEFAULT_GATES)).toEqual([]);
  });
});
