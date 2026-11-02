/** Mock handlers: engines/catalog, samples, voice extraction, lab compare and the evaluation harness. */
import type {
  Asset,
  CaseResult,
  DatasetGenerateRequest,
  DecisionGates,
  EngineInfo,
  EvalCase,
  ExtractRequest,
  ExtractionResult,
  FormSchema,
  JobStatus,
  LabCompareItem,
  LabCompareRequest,
  LabCompareResult,
  RunConfig,
  RunRequest,
  RunStarted,
  RunSummary,
  SampleInfo,
  Scalar,
} from '@/api/types';
import { NO_LLM_ID, ORACLE_STT_ID } from '@/api/types';
import { encodeWav, parseWavHeader } from '@/lib/audio/wav';
import { configKey, engineName } from '@/lib/engineLabels';
import { valuesEqual } from '@/lib/fieldDiff';
import { DEFAULT_GATES, evaluateGates } from '@/lib/gates';
import { DEFAULT_DATASET_ID, ensureRuns, getDb, type MockDb } from './db';
import { buildDatasetInfo, generateCases } from './dataset';
import { buildRun, MOCK_HARDWARE } from './evalRuns';
import { mockExtract } from './extractor';
import { STRATEGIES } from './fixtures/engines';
import { ASSETS, FORMS, closedWorld } from './fixtures/world';
import { getJob, startJob } from './jobs';
import { badRequest, clone, HttpError, intParam, json, noContent, notFound, route, sleep, unauthenticatedError } from './router';

// ---- engines ----------------------------------------------------------------------------------------------------

route('GET', '/engines', () => {
  const db = getDb();
  return json(clone({ stt: db.engines.filter((e) => e.kind === 'stt'), llm: db.engines.filter((e) => e.kind === 'llm'), strategies: STRATEGIES }));
});

route('GET', '/engines/catalog', () => json(clone(getDb().catalog)));

function findEngine(db: MockDb, id: string): EngineInfo {
  const e = db.engines.find((x) => x.id === id);
  if (!e) throw notFound('Engine');
  return e;
}

route('POST', '/engines/:id/prepare', ({ params }) => {
  const db = getDb();
  const engine = findEngine(db, params.id as string);
  if (engine.availability === 'unavailable') {
    throw new HttpError(409, { code: 'engine_unavailable', message: engine.availability_reason ?? 'This engine is unavailable on this machine.' });
  }
  const size = engine.size_mb ?? 0;
  const alias = engine.alias ?? engine.name;
  if (engine.availability === 'ready') {
    return json(
      startJob<EngineInfo>({
        kind: 'prepare_engine',
        durationMs: 1400,
        message: `Loading ${alias}...`,
        complete: () => {
          engine.loaded = true;
          return clone(engine);
        },
      }),
      202,
    );
  }
  if (engine.availability === 'error') {
    return json(
      startJob<EngineInfo>({
        kind: 'prepare_engine',
        durationMs: 3200,
        message: `Preparing ${alias}...`,
        tick: (job, p) => {
          job.message = p < 0.6 ? `Downloading ${alias}: ${Math.round((p / 0.6) * 100)}%` : `Loading ${alias} and running a self-test...`;
        },
        failAt: { progress: 0.75, error: engine.availability_reason ?? 'The self-test failed.' },
      }),
      202,
    );
  }
  const duration = Math.min(9000, 2200 + size * 4);
  return json(
    startJob<EngineInfo>({
      kind: 'prepare_engine',
      durationMs: duration,
      message: `Downloading ${alias}...`,
      tick: (job, p) => {
        job.message =
          p < 0.8
            ? `Downloading ${alias}: ${Math.round((p / 0.8) * 100)}% (${Math.round((p / 0.8) * size)} / ${Math.round(size)} MB)`
            : `Loading ${alias} and running a self-test...`;
      },
      complete: () => {
        engine.availability = 'ready';
        engine.availability_reason = null;
        engine.loaded = true;
        for (const m of db.catalog) for (const v of m.variants) if (v.id === engine.variant_id) v.cached = true;
        return clone(engine);
      },
    }),
    202,
  );
});

route('POST', '/engines/:id/unload', ({ params }) => {
  const engine = findEngine(getDb(), params.id as string);
  engine.loaded = false;
  return json(clone(engine));
});

// ---- samples ----------------------------------------------------------------------------------------------------

function toSample(c: EvalCase): SampleInfo {
  return {
    id: c.id,
    form_id: c.form_id,
    tags: c.tags,
    split: c.split,
    has_audio: c.audio_path !== null,
    spoken_text: c.spoken_text,
    written_text: c.written_text,
    expected: c.expected,
    noise: c.noise,
    voice: c.voice,
    audio_url: c.audio_path !== null ? `/api/v1/samples/${encodeURIComponent(c.id)}/audio` : null,
  };
}

export function findSample(db: MockDb, id: string): EvalCase | undefined {
  return db.datasets.get(DEFAULT_DATASET_ID)?.cases.find((c) => c.id === id);
}

route('GET', '/samples', ({ query }) => {
  const db = getDb();
  const cases = db.datasets.get(DEFAULT_DATASET_ID)?.cases ?? [];
  let out = cases;
  if (query.form_id) out = out.filter((c) => c.form_id === query.form_id);
  if (query.tag) out = out.filter((c) => c.tags.includes(query.tag as string));
  const limit = intParam(query.limit, 50);
  return json(out.slice(0, limit).map(toSample));
});

route('GET', '/samples/:id/audio', ({ params }) => {
  const sample = findSample(getDb(), params.id as string);
  if (!sample) throw notFound('Sample');
  // A short tone: the mock has no TTS audio.
  const rate = 16000;
  const pcm = new Int16Array(rate);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000 * Math.min(1, i / 800, (pcm.length - i) / 800));
  return { status: 200, data: new Blob([encodeWav(pcm, rate)], { type: 'audio/wav' }), headers: { 'content-type': 'audio/wav' } };
});

// ---- voice / extraction -----------------------------------------------------------------------------------------

export interface ExtractContext {
  form: FormSchema;
  assets: Asset[];
}

export function resolveContext(db: MockDb, workOrderId?: string | null, formId?: string | null): ExtractContext {
  if (workOrderId) {
    if (!db.session) throw unauthenticatedError();
    const wo = db.bundle?.work_orders.find((w) => w.id === workOrderId);
    if (!wo) throw notFound('Work order');
    const form = db.bundle?.forms.find((f) => f.id === wo.form_id) ?? FORMS.find((f) => f.id === wo.form_id);
    if (!form) throw notFound('Form');
    return { form, assets: closedWorld(wo) };
  }
  if (formId) {
    const form = FORMS.find((f) => f.id === formId);
    if (!form) throw notFound('Form');
    return { form, assets: ASSETS };
  }
  throw badRequest('work_order_id or form_id is required');
}

export function assertEngineReady(db: MockDb, id: string): void {
  if (id === ORACLE_STT_ID || id === NO_LLM_ID) return;
  const e = db.engines.find((x) => x.id === id);
  if (e && e.availability !== 'ready') {
    throw new HttpError(409, { code: 'engine_not_ready', message: `${e.name} is not ready (${e.availability.replace('_', ' ')}). ${e.availability_reason ?? ''}`.trim() });
  }
}

route('POST', '/voice/extract', async ({ body }) => {
  const db = getDb();
  const b = (body ?? {}) as ExtractRequest;
  const ctx = resolveContext(db, b.work_order_id, b.form_id);
  const config: RunConfig = {
    stt_engine_id: b.stt_engine_id ?? ORACLE_STT_ID,
    llm_engine_id: b.llm_engine_id ?? NO_LLM_ID,
    strategy_id: b.strategy_id ?? 'hybrid',
  };
  assertEngineReady(db, config.llm_engine_id);
  let written: string;
  let spoken: string | null = null;
  let expected: Record<string, Scalar> | null = null;
  if (b.sample_id) {
    const sample = findSample(db, b.sample_id);
    if (!sample) throw notFound('Sample');
    written = sample.written_text;
    spoken = sample.spoken_text;
    expected = sample.expected;
    assertEngineReady(db, config.stt_engine_id);
  } else if (b.transcript && b.transcript.trim()) {
    written = b.transcript;
    config.stt_engine_id = ORACLE_STT_ID; // typed text skips speech recognition
  } else {
    throw badRequest('Provide either transcript or sample_id');
  }
  const result = mockExtract({ form: ctx.form, assets: ctx.assets, written, spoken, expected, config, seed: `extract|${b.sample_id ?? written}` });
  await sleep(Math.min(1200, result.total_ms * 0.5 + 150));
  return json(result);
});

route('POST', '/voice/extract-audio', async ({ form }) => {
  const db = getDb();
  const audio = form?.get('audio');
  if (!(audio instanceof Blob)) throw badRequest('audio: field required');
  const config: RunConfig = {
    stt_engine_id: String(form?.get('stt_engine_id') ?? ORACLE_STT_ID),
    llm_engine_id: String(form?.get('llm_engine_id') ?? NO_LLM_ID),
    strategy_id: String(form?.get('strategy_id') ?? 'hybrid'),
  };
  const ctx = resolveContext(db, (form?.get('work_order_id') as string | null) ?? null, (form?.get('form_id') as string | null) ?? null);
  assertEngineReady(db, config.stt_engine_id);
  assertEngineReady(db, config.llm_engine_id);
  let audioMs: number | null = null;
  try {
    audioMs = parseWavHeader(await audio.arrayBuffer()).durationMs;
  } catch (error) {
    throw badRequest(`audio: ${error instanceof Error ? error.message : 'not a WAV file'}`);
  }
  const sample = db.datasets.get(DEFAULT_DATASET_ID)?.cases.find((c) => c.form_id === ctx.form.id);
  if (!sample) throw badRequest('No sample transcript exists for this form in mock mode.');
  const result: ExtractionResult = mockExtract({
    form: ctx.form,
    assets: ctx.assets,
    written: sample.written_text,
    spoken: sample.spoken_text,
    expected: sample.expected,
    config,
    seed: `audio|${audio.size}`,
    audioMs,
  });
  result.warnings = [...result.warnings, 'Mock mode: the audio was not transcribed. A canned sample transcript for this form was used instead.'];
  await sleep(Math.min(1500, result.total_ms * 0.5 + 300));
  return json(result);
});

// ---- lab --------------------------------------------------------------------------------------------------------

route('POST', '/lab/compare', ({ body }) => {
  const db = getDb();
  const b = (body ?? {}) as LabCompareRequest;
  if (!b.combos || b.combos.length === 0) throw badRequest('combos: at least one configuration is required');
  const ctx = resolveContext(db, b.work_order_id, b.form_id);
  let written: string;
  let spoken: string | null = null;
  let expected: Record<string, Scalar> | null = null;
  let sourceKey: string;
  if (b.sample_id) {
    const sample = findSample(db, b.sample_id);
    if (!sample) throw notFound('Sample');
    written = sample.written_text;
    spoken = sample.spoken_text;
    expected = sample.expected;
    sourceKey = sample.id;
  } else if (b.transcript && b.transcript.trim()) {
    written = b.transcript;
    sourceKey = `typed:${written}`;
  } else {
    throw badRequest('Provide either transcript or sample_id');
  }
  const combos = b.combos;
  const job: JobStatus<LabCompareResult> = startJob<LabCompareResult>({
    kind: 'lab_compare',
    durationMs: 700 + 520 * combos.length,
    message: `Comparing ${combos.length} configuration${combos.length === 1 ? '' : 's'}...`,
    tick: (j, p) => {
      j.message = `Running configuration ${Math.min(combos.length, Math.floor(p * combos.length) + 1)} of ${combos.length}...`;
    },
    complete: () => {
      const items = combos.map<LabCompareItem>((config) => {
        const problems: string[] = [];
        for (const id of [config.stt_engine_id, config.llm_engine_id]) {
          if (id === ORACLE_STT_ID || id === NO_LLM_ID) continue;
          const e = db.engines.find((x) => x.id === id);
          if (e && e.availability !== 'ready') problems.push(`${engineName(id, db.engines)} is not ready (${e.availability.replace('_', ' ')})`);
        }
        if (problems.length > 0) return { config, extraction: null, field_correct: null, error: problems.join('; ') };
        const extraction = mockExtract({
          form: ctx.form,
          assets: ctx.assets,
          written,
          spoken,
          expected,
          config: b.sample_id ? config : { ...config, stt_engine_id: ORACLE_STT_ID },
          seed: `lab|${sourceKey}`,
        });
        const fieldCorrect = expected
          ? Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, valuesEqual(v, extraction.fields[k]?.value ?? null)]))
          : null;
        return { config, extraction, field_correct: fieldCorrect, error: null };
      });
      return { expected, items };
    },
  });
  return json(job, 202);
});

// ---- evaluation: datasets ---------------------------------------------------------------------------------------

route('GET', '/eval/datasets', () => json(clone(Array.from(getDb().datasets.values()).map((d) => d.info))));

route('GET', '/eval/datasets/:id/cases', ({ params, query }) => {
  const ds = getDb().datasets.get(params.id as string);
  if (!ds) throw notFound('Dataset');
  let cases = ds.cases;
  if (query.tag) cases = cases.filter((c) => c.tags.includes(query.tag as string));
  if (query.split) cases = cases.filter((c) => c.split === query.split);
  const offset = Math.max(0, intParam(query.offset, 0));
  const limit = Math.max(1, intParam(query.limit, 50));
  return json(clone(cases.slice(offset, offset + limit)));
});

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'dataset';

route('POST', '/eval/datasets/generate', ({ body }) => {
  const db = getDb();
  const b = (body ?? {}) as DatasetGenerateRequest;
  const name = b.name?.trim() || 'synth-v1';
  const n = Math.max(3, Math.min(400, Math.floor(b.n_cases ?? 240)));
  const withAudio = b.with_audio ?? true;
  const audioLimit = withAudio ? (b.audio_limit === undefined ? 120 : b.audio_limit) : 0;
  let id = slug(name);
  for (let i = 2; db.datasets.has(id); i++) id = `${slug(name)}-${i}`;
  const opts = { id, name, n, seed: b.seed ?? 11, audioLimit, augment: b.augment ?? true };
  const audioCount = audioLimit === null ? n : Math.min(n, audioLimit);
  return json(
    startJob({
      kind: 'dataset_build',
      durationMs: Math.min(9000, 1800 + n * 12 + audioCount * 25),
      message: 'Generating utterances...',
      tick: (job, p) => {
        job.message =
          p < 0.3 ? `Generating ${n} utterances from templates...` : p < 0.9 && audioCount > 0 ? `Synthesizing audio (TTS): ${Math.round(((p - 0.3) / 0.6) * audioCount)} / ${audioCount}` : 'Writing manifest...';
      },
      complete: () => {
        const cases = generateCases(opts);
        const info = buildDatasetInfo(opts, cases);
        db.datasets.set(id, { info, cases });
        return info;
      },
    }),
    202,
  );
});

// ---- evaluation: runs -------------------------------------------------------------------------------------------

const runJobs = new Map<string, string>();

function refreshRun(db: MockDb, runId: string): RunSummary | undefined {
  const run = db.runs.get(runId);
  if (!run) return undefined;
  if (run.summary.status === 'running') {
    const job = runJobs.get(runId) ? getJob(runJobs.get(runId) as string) : undefined;
    if (job?.state === 'cancelled') run.summary = { ...run.summary, status: 'cancelled' };
    else if (job?.state === 'failed') run.summary = { ...run.summary, status: 'failed', notes: [...run.summary.notes, job.error ?? 'failed'] };
  }
  return run.summary;
}

route('GET', '/eval/runs', () => {
  const db = getDb();
  ensureRuns(db);
  const list = Array.from(db.runs.keys())
    .map((id) => refreshRun(db, id) as RunSummary)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return json(clone(list));
});

route('GET', '/eval/runs/:id', ({ params }) => {
  const db = getDb();
  ensureRuns(db);
  const summary = refreshRun(db, params.id as string);
  if (!summary) throw notFound('Run');
  return json(clone(summary));
});

route('POST', '/eval/runs', ({ body }) => {
  const db = getDb();
  ensureRuns(db);
  const b = (body ?? {}) as Partial<RunRequest>;
  const ds = b.dataset_id ? db.datasets.get(b.dataset_id) : undefined;
  if (!ds) throw notFound('Dataset');
  if (!b.configs || b.configs.length === 0) throw badRequest('configs: at least one configuration is required');
  for (const c of b.configs) {
    assertEngineReady(db, c.stt_engine_id);
    assertEngineReady(db, c.llm_engine_id);
  }
  const request: RunRequest = {
    dataset_id: ds.info.id,
    configs: b.configs,
    limit: b.limit ?? null,
    splits: b.splits ?? null,
    tags: b.tags ?? null,
    repeats: b.repeats ?? 1,
    warmup: b.warmup ?? 1,
    confidence_threshold: b.confidence_threshold ?? 0.8,
    label: b.label ?? null,
  };
  db.counters.run += 1;
  const runId = `run-${String(db.counters.run).padStart(4, '0')}`;
  const createdAt = new Date().toISOString();
  db.runs.set(runId, {
    summary: {
      run_id: runId,
      label: request.label,
      created_at: createdAt,
      finished_at: null,
      dataset_id: ds.info.id,
      status: 'running',
      progress: 0,
      hardware: MOCK_HARDWARE,
      request,
      configs: [],
      notes: [],
    },
    results: new Map(),
  });
  const n = request.configs.length;
  const job = startJob<RunStarted>({
    kind: 'eval_run',
    durationMs: 2500 + 900 * n,
    message: 'Starting run...',
    initialResult: { run_id: runId },
    tick: (j, p) => {
      const run = db.runs.get(runId);
      if (run) run.summary.progress = Math.round(p * 0.98 * 1000) / 1000;
      j.message = `Evaluating configuration ${Math.min(n, Math.floor(p * n) + 1)} of ${n}...`;
    },
    complete: () => {
      const built = buildRun({
        runId,
        label: request.label,
        dataset: { id: ds.info.id, cases: ds.cases },
        request,
        forms: FORMS,
        assets: ASSETS,
        createdAt,
        finishedAt: new Date().toISOString(),
      });
      db.runs.set(runId, built);
      return { run_id: runId };
    },
  });
  runJobs.set(runId, job.id);
  return json(job, 202);
});

route('GET', '/eval/runs/:id/cases', ({ params, query }) => {
  const db = getDb();
  ensureRuns(db);
  const run = db.runs.get(params.id as string);
  if (!run) throw notFound('Run');
  let results: CaseResult[] = query.config_key ? (run.results.get(query.config_key) ?? []) : Array.from(run.results.values()).flat();
  if (query.only_failures === 'true') results = results.filter((r) => Object.values(r.field_correct).some((ok) => !ok));
  const offset = Math.max(0, intParam(query.offset, 0));
  const limit = Math.max(1, intParam(query.limit, 25));
  return json(clone(results.slice(offset, offset + limit)));
});

route('GET', '/eval/runs/:id/decision', ({ params, query }) => {
  const db = getDb();
  ensureRuns(db);
  const run = db.runs.get(params.id as string);
  if (!run) throw notFound('Run');
  const num = (v: string | undefined, d: number): number => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  const gates: DecisionGates = {
    max_p95_ms: num(query.max_p95_ms, DEFAULT_GATES.max_p95_ms),
    min_id_field_accuracy: num(query.min_id_field_accuracy, DEFAULT_GATES.min_id_field_accuracy),
    max_silent_wrong: num(query.max_silent_wrong, DEFAULT_GATES.max_silent_wrong),
    max_peak_rss_mb: query.max_peak_rss_mb === undefined || query.max_peak_rss_mb === '' ? null : num(query.max_peak_rss_mb, 0),
    min_field_accuracy: num(query.min_field_accuracy, DEFAULT_GATES.min_field_accuracy),
  };
  return json(evaluateGates(run.summary.run_id, run.summary.configs, gates));
});

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function runToCsv(summary: RunSummary): string {
  const header = [
    'config_key', 'stt_engine', 'llm_engine', 'strategy', 'n_cases', 'field_accuracy', 'id_field_accuracy', 'silent_wrong_rate', 'review_rate',
    'safe_outcome_rate', 'wer', 'wer_normalized', 'p50_total_ms', 'p95_total_ms', 'p50_stt_ms', 'p95_stt_ms', 'p50_llm_ms', 'p95_llm_ms',
    'prompt_tokens_mean', 'output_tokens_mean', 'peak_rss_mb', 'model_size_mb',
  ];
  const rows = summary.configs.map((m) =>
    [
      configKey(m.config), m.config.stt_engine_id, m.config.llm_engine_id, m.config.strategy_id, m.n_cases, m.field_accuracy, m.id_field_accuracy,
      m.silent_wrong_rate, m.review_rate, m.safe_outcome_rate, m.wer, m.wer_normalized, m.latency_total.p50, m.latency_total.p95, m.latency_stt.p50,
      m.latency_stt.p95, m.latency_llm.p50, m.latency_llm.p95, m.llm_prompt_tokens_mean, m.llm_output_tokens_mean, m.peak_rss_mb, m.model_size_mb,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n');
}

route('GET', '/eval/runs/:id/export', ({ params, query }) => {
  const db = getDb();
  ensureRuns(db);
  const run = db.runs.get(params.id as string);
  if (!run) throw notFound('Run');
  const format = query.format === 'csv' ? 'csv' : 'json';
  const text = format === 'csv' ? runToCsv(run.summary) : JSON.stringify(run.summary, null, 2);
  const type = format === 'csv' ? 'text/csv' : 'application/json';
  return {
    status: 200,
    data: new Blob([text], { type }),
    headers: { 'content-type': type, 'content-disposition': `attachment; filename="${run.summary.run_id}.${format}"` },
  };
});

route('DELETE', '/eval/runs/:id', ({ params }) => {
  const db = getDb();
  ensureRuns(db);
  if (!db.runs.delete(params.id as string)) throw notFound('Run');
  return noContent();
});
