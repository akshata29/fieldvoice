/** Builds simulated evaluation runs: per-case results from the mock pipeline + metrics computed from them. */
import type {
  Asset,
  CaseResult,
  ConfigMetrics,
  EvalCase,
  ExtractionResult,
  FormSchema,
  HardwareInfo,
  RunConfig,
  RunRequest,
  RunSummary,
} from '@/api/types';
import { NO_LLM_ID, ORACLE_STT_ID } from '@/api/types';
import { DEFAULT_CONFIDENCE_THRESHOLD, valuesEqual } from '@/lib/fieldDiff';
import { configKey } from '@/lib/engineLabels';
import { runPipeline } from './extractor';
import { llmProfile, sttProfile } from './fixtures/engines';
import { Rng } from './rng';
import { latencyStats, mean } from './stats';
import { normalizeNumbers, wordErrorRate } from './text';

export const MOCK_HARDWARE: HardwareInfo = {
  cpu_name: 'Demo CPU (mock hardware)',
  physical_cores: 8,
  logical_cores: 16,
  ram_gb: 32,
  os: 'Windows 11 (mock)',
  os_build: '26100',
  python_version: '3.11',
  device_profile: 'dev-box',
  battery_present: false,
  notes: ['Mock hardware: nothing here was measured.', 'Not representative of the Latitude 7220 field device.'],
};

export interface RunBuildInput {
  runId: string;
  label: string | null;
  dataset: { id: string; cases: EvalCase[] };
  request: RunRequest;
  forms: FormSchema[];
  assets: Asset[];
  createdAt: string;
  finishedAt: string;
}

export function filterCases(cases: EvalCase[], request: Pick<RunRequest, 'splits' | 'tags' | 'limit'>): EvalCase[] {
  let out = cases;
  if (request.splits && request.splits.length > 0) out = out.filter((c) => request.splits?.includes(c.split));
  if (request.tags && request.tags.length > 0) out = out.filter((c) => c.tags.some((t) => request.tags?.includes(t)));
  if (request.limit && request.limit > 0) out = out.slice(0, request.limit);
  return out;
}

const ID_IN_TEXT = /\b\d{3,5}\b/g;

interface Latency {
  total: number;
  stt: number;
  llm: number | null;
}

function timingsOf(res: ExtractionResult): Latency {
  return { total: res.total_ms, stt: res.stt_ms ?? 0, llm: res.timings.find((t) => t.stage === 'llm')?.ms ?? null };
}

/** Another timing sample for the same case: content never changes between repeats, only run-to-run noise does. */
function resampleTimings(res: ExtractionResult, rng: Rng): Latency {
  const base = timingsOf(res);
  const stt = Math.round(base.stt * rng.jitter(0.1));
  const llm = base.llm === null ? null : Math.round(base.llm * rng.jitter(0.1));
  const other = base.total - base.stt - (base.llm ?? 0);
  return { total: Math.max(1, Math.round(stt + (llm ?? 0) + other * rng.jitter(0.2))), stt, llm };
}

function buildConfig(
  config: RunConfig,
  cases: EvalCase[],
  forms: FormSchema[],
  assets: Asset[],
  request: RunRequest,
  seed: string,
): { metrics: ConfigMetrics; results: CaseResult[] } {
  const key = configKey(config);
  const stt = sttProfile(config.stt_engine_id);
  const llm = llmProfile(config.llm_engine_id);
  const rng = new Rng(`${seed}|${key}|rss`);
  const threshold = request.confidence_threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const repeats = Math.max(1, request.repeats || 1);

  const results: CaseResult[] = [];
  const totals: number[] = [];
  const sttMs: number[] = [];
  const extractMs: number[] = [];
  const llmMs: number[] = [];
  const promptTokens: number[] = [];
  const outputTokens: number[] = [];
  const werRaw: number[] = [];
  const werNorm: number[] = [];
  const audioMs: number[] = [];
  const idHits: number[] = [];
  let schemaTotal = 0;
  let schemaValid = 0;

  let fields = 0;
  let correct = 0;
  let idFields = 0;
  let idCorrect = 0;
  let confident = 0;
  let silentWrong = 0;
  let flagged = 0;
  let emptyExpected = 0;
  let hallucinated = 0;
  let exact = 0;
  const byType: Record<string, [number, number]> = {};
  const byTag: Record<string, [number, number]> = {};
  const bump = (m: Record<string, [number, number]>, k: string, ok: boolean) => {
    const cur = m[k] ?? [0, 0];
    cur[1] += 1;
    if (ok) cur[0] += 1;
    m[k] = cur;
  };

  for (const c of cases) {
    const form = forms.find((f) => f.id === c.form_id);
    if (!form) continue;
    const run = runPipeline({
      form,
      assets,
      written: c.written_text,
      spoken: c.spoken_text,
      expected: c.expected,
      config,
      seed: `${seed}|${c.id}|0`,
      audioMs: undefined,
    });
    const res = run.result;
    // Repeats only exist to smooth latency, so they resample the timings instead of re-running the whole pipeline.
    for (let r = 0; r < repeats; r++) {
      const t = r === 0 ? timingsOf(res) : resampleTimings(res, new Rng(`${seed}|${c.id}|${key}|${r}`));
      totals.push(t.total);
      sttMs.push(t.stt);
      extractMs.push(t.total - t.stt);
      if (t.llm !== null) llmMs.push(t.llm);
    }
    if (res.llm_prompt_tokens !== null) promptTokens.push(res.llm_prompt_tokens);
    if (res.llm_output_tokens !== null) outputTokens.push(res.llm_output_tokens);
    if (config.llm_engine_id !== NO_LLM_ID && config.strategy_id !== 'rules_only') {
      schemaTotal++;
      if (!res.warnings.some((w) => /not valid JSON/i.test(w))) schemaValid++;
    }

    const fieldCorrect: Record<string, boolean> = {};
    let allCorrect = true;
    for (const [k, expectedValue] of Object.entries(c.expected)) {
      const fvv = res.fields[k];
      const actual = fvv?.value ?? null;
      const ok = valuesEqual(expectedValue, actual);
      fieldCorrect[k] = ok;
      fields++;
      if (ok) correct++;
      else allCorrect = false;
      const spec = form.fields.find((f) => f.key === k);
      const type = spec?.type ?? 'text';
      bump(byType, type, ok);
      for (const tag of c.tags) bump(byTag, tag, ok);
      if (type === 'entity_ref') {
        idFields++;
        if (ok) idCorrect++;
      }
      const isConfident = fvv?.status === 'filled' && (fvv?.confidence ?? 0) >= threshold && actual !== null;
      if (isConfident) {
        confident++;
        if (!ok) silentWrong++;
      }
      if (fvv && (fvv.status === 'needs_review' || fvv.status === 'conflict')) flagged++;
      if (expectedValue === null) {
        emptyExpected++;
        if (actual !== null) hallucinated++;
      }
    }
    if (allCorrect) exact++;

    if (config.stt_engine_id !== ORACLE_STT_ID) {
      werRaw.push(wordErrorRate(c.spoken_text, res.transcript_raw));
      werNorm.push(wordErrorRate(normalizeNumbers(c.spoken_text), res.transcript_normalized));
      const refIds = c.written_text.match(ID_IN_TEXT) ?? [];
      if (refIds.length > 0) idHits.push(refIds.filter((id) => res.transcript_normalized.includes(id)).length / refIds.length);
      if (res.audio_ms) audioMs.push(res.audio_ms);
    }

    results.push({
      case_id: c.id,
      config_key: key,
      ok: true,
      error: null,
      tags: c.tags,
      transcript_hyp: res.transcript_raw,
      wer: config.stt_engine_id === ORACLE_STT_ID ? null : wordErrorRate(c.spoken_text, res.transcript_raw),
      expected: c.expected,
      field_correct: fieldCorrect,
      extraction: res,
    });
  }

  const ratio = (a: number, b: number): number => (b === 0 ? 0 : a / b);
  const map = (m: Record<string, [number, number]>): Record<string, number> =>
    Object.fromEntries(Object.entries(m).map(([k, [ok, n]]) => [k, Math.round(ratio(ok, n) * 1000) / 1000]));
  const round3 = (v: number | null): number | null => (v === null ? null : Math.round(v * 1000) / 1000);

  const metrics: ConfigMetrics = {
    config_key: key,
    config,
    n_cases: cases.length,
    n_errors: 0,
    wer: config.stt_engine_id === ORACLE_STT_ID ? null : round3(mean(werRaw)),
    wer_normalized: config.stt_engine_id === ORACLE_STT_ID ? null : round3(mean(werNorm)),
    id_exact_match: config.stt_engine_id === ORACLE_STT_ID ? null : round3(mean(idHits)),
    rtf: config.stt_engine_id === ORACLE_STT_ID ? null : round3(ratio(mean(sttMs) ?? 0, mean(audioMs) ?? 1)),
    field_accuracy: round3(ratio(correct, fields)) ?? 0,
    id_field_accuracy: idFields === 0 ? null : round3(ratio(idCorrect, idFields)),
    accuracy_by_type: map(byType),
    accuracy_by_tag: map(byTag),
    form_exact_match: round3(ratio(exact, cases.length)) ?? 0,
    silent_wrong_rate: round3(ratio(silentWrong, confident)) ?? 0,
    hallucination_rate: emptyExpected === 0 ? null : round3(ratio(hallucinated, emptyExpected)),
    review_rate: round3(ratio(flagged, fields)) ?? 0,
    safe_outcome_rate: round3(1 - ratio(silentWrong, fields)) ?? 0,
    schema_valid_rate: schemaTotal === 0 ? null : round3(ratio(schemaValid, schemaTotal)),
    latency_total: latencyStats(totals),
    latency_stt: latencyStats(config.stt_engine_id === ORACLE_STT_ID ? [] : sttMs),
    latency_extract: latencyStats(extractMs),
    latency_llm: latencyStats(llmMs),
    llm_prompt_tokens_mean: promptTokens.length ? Math.round(mean(promptTokens) ?? 0) : null,
    llm_output_tokens_mean: outputTokens.length ? Math.round(mean(outputTokens) ?? 0) : null,
    cold_start_ms: stt.coldStartMs + llm.coldStartMs || null,
    peak_rss_mb: stt.rssMb + llm.rssMb === 0 ? null : Math.round((380 + stt.rssMb + llm.rssMb) * rng.jitter(0.04)),
    model_size_mb: stt.sizeMb + llm.sizeMb || null,
  };
  return { metrics, results };
}

export function buildRun(input: RunBuildInput): { summary: RunSummary; results: Map<string, CaseResult[]> } {
  const cases = filterCases(input.dataset.cases, input.request);
  const results = new Map<string, CaseResult[]>();
  const configs: ConfigMetrics[] = [];
  for (const config of input.request.configs) {
    const built = buildConfig(config, cases, input.forms, input.assets, input.request, `${input.runId}`);
    configs.push(built.metrics);
    results.set(built.metrics.config_key, built.results);
  }
  const summary: RunSummary = {
    run_id: input.runId,
    label: input.label,
    created_at: input.createdAt,
    finished_at: input.finishedAt,
    dataset_id: input.dataset.id,
    status: 'succeeded',
    progress: 1,
    hardware: MOCK_HARDWARE,
    request: input.request,
    configs,
    notes: [
      'Mock run: every metric is simulated from fabricated engine profiles and is not a measurement.',
      `${cases.length} cases x ${input.request.configs.length} configurations${(input.request.repeats ?? 1) > 1 ? `, ${input.request.repeats} repeats for latency` : ''}.`,
    ],
  };
  return { summary, results };
}
