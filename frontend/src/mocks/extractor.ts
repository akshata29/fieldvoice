/**
 * Mock extraction pipeline. It is a miniature of the real hybrid design (normalize -> deterministic resolve ->
 * LLM only for what is left -> validate) so the UI can show progressive fields, evidence and engine-dependent
 * mistakes without a backend. Errors are injected from seeded profiles; nothing here is a measurement.
 */
import type {
  Asset,
  ExtractionResult,
  FieldSpec,
  FieldValue,
  FormSchema,
  RunConfig,
  Scalar,
  StageTiming,
} from '@/api/types';
import { NO_LLM_ID, ORACLE_STT_ID } from '@/api/types';
import { configKey } from '@/lib/engineLabels';
import { llmProfile, sttProfile } from './fixtures/engines';
import { Rng } from './rng';
import { digitsToSpokenText, normalizeNumbers, spaceDigits } from './text';

export interface PipelineInput {
  form: FormSchema;
  /** Closed world: job assets + stock inventory. */
  assets: Asset[];
  /** How a good ASR would write the utterance (digits, punctuation). Also the oracle transcript. */
  written: string;
  /** Exactly what was said (numbers as words), when known. */
  spoken?: string | null;
  /** Ground truth; lets the mock LLM "know" the answer and then get it wrong at its profile's error rate. */
  expected?: Record<string, Scalar> | null;
  config: RunConfig;
  seed: string;
  audioMs?: number | null;
}

export interface PipelineRun {
  result: ExtractionResult;
  stages: {
    resolve: Record<string, FieldValue>;
    llm: Record<string, FieldValue> | null;
    validate: Record<string, FieldValue>;
  };
  stageMs: { normalize: number; resolve: number | null; llm: number | null; validate: number };
}

const CONFIDENT = 0.8;

const blank = (key: string): FieldValue => ({ key, value: null, source: null, confidence: 0, status: 'missing', evidence: null, note: null, candidates: [] });

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRe = (phrase: string, flags = 'gi'): RegExp => new RegExp(`\\b${escapeRe(phrase.trim()).replace(/\s+/g, '\\s+')}\\b`, flags);

interface Hit {
  start: number;
  end: number;
  text: string;
}

function findPhrase(haystack: string, phrase: string): Hit[] {
  const out: Hit[] = [];
  const re = phraseRe(phrase);
  for (let m = re.exec(haystack); m; m = re.exec(haystack)) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  return out;
}

function fv(spec: FieldSpec, value: Scalar, source: FieldValue['source'], confidence: number, hit: Hit | null, extra: Partial<FieldValue> = {}): FieldValue {
  return {
    key: spec.key,
    value,
    source,
    confidence: Math.round(confidence * 100) / 100,
    status: confidence >= CONFIDENT ? 'filled' : 'needs_review',
    evidence: hit ? { start: hit.start, end: hit.end, text: hit.text } : null,
    note: null,
    candidates: [],
    ...extra,
  };
}

// ---- deterministic stage ----------------------------------------------------------------------------------------

function resolveEnum(spec: FieldSpec, text: string): FieldValue | null {
  const matches: Array<Hit & { code: string }> = [];
  for (const o of spec.options) {
    for (const phrase of [o.label, ...o.synonyms]) {
      for (const hit of findPhrase(text, phrase)) matches.push({ ...hit, code: o.code });
    }
  }
  if (matches.length === 0) return null;
  const codes = Array.from(new Set(matches.map((m) => m.code)));
  const best = [...matches].sort((a, b) => b.end - b.start - (a.end - a.start))[0] as Hit & { code: string };
  if (codes.length === 1) return fv(spec, best.code, 'rule', 0.94, best);
  const first = [...matches].sort((a, b) => a.start - b.start)[0] as Hit & { code: string };
  return fv(spec, first.code, 'rule', 0.4, first, { status: 'conflict', candidates: codes, note: 'More than one option was mentioned' });
}

function nearbyIds(id: string, pool: Asset[], limit = 3): string[] {
  const dist = (a: string, b: string) => {
    if (a.length !== b.length) return 99;
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d;
  };
  return pool
    .filter((a) => a.id !== id)
    .map((a) => ({ id: a.id, d: dist(a.id, id) }))
    .filter((x) => x.d <= 2)
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.id);
}

function resolveEntity(spec: FieldSpec, text: string, assets: Asset[]): FieldValue | null {
  const pool = assets.filter((a) => !spec.entity_kind || a.kind === spec.entity_kind);
  const byId = new Map(pool.map((a) => [a.id.toLowerCase(), a]));
  const hits: Array<Hit & { id: string }> = [];
  for (const trigger of spec.role_triggers) {
    const re = new RegExp(`\\b${escapeRe(trigger).replace(/\\? /g, '\\s+')}\\b[\\s#:]*([A-Za-z]?\\d[\\w-]*)`, 'gi');
    for (let m = re.exec(text); m; m = re.exec(text)) {
      hits.push({ start: m.index, end: m.index + m[0].length, text: m[0], id: (m[1] as string).replace(/[-.]+$/, '') });
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.start - b.start);
  const inWorld = hits.filter((h) => byId.has(h.id.toLowerCase()));
  if (inWorld.length > 0) {
    const last = inWorld[inWorld.length - 1] as Hit & { id: string };
    const asset = byId.get(last.id.toLowerCase()) as Asset;
    const distinct = new Set(inWorld.map((h) => h.id.toLowerCase()));
    return fv(spec, asset.id, 'rule', distinct.size > 1 ? 0.88 : 0.97, last, distinct.size > 1 ? { note: 'Mentioned twice - used the latest' } : {});
  }
  const last = hits[hits.length - 1] as Hit & { id: string };
  return fv(spec, last.id, 'rule', 0.42, last, { status: 'needs_review', note: "Not in today's assets", candidates: nearbyIds(last.id, pool) });
}

function resolveNumber(spec: FieldSpec, text: string): FieldValue | null {
  const units = [...spec.unit_triggers].sort((a, b) => b.length - a.length).map((u) => escapeRe(u).replace(/ /g, '\\s+'));
  let hit: (Hit & { n: number }) | null = null;
  if (units.length > 0) {
    const re = new RegExp(`(-?\\d+(?:\\.\\d+)?)\\s*(?:${units.join('|')})\\b`, 'gi');
    for (let m = re.exec(text); m; m = re.exec(text)) hit = { start: m.index, end: m.index + m[0].length, text: m[0], n: Number(m[1]) };
  }
  if (!hit && spec.label_triggers.length > 0) {
    const labels = spec.label_triggers.map((l) => escapeRe(l)).join('|');
    const re = new RegExp(`\\b(?:${labels})\\b[^\\d.\\n]{0,12}?(-?\\d+(?:\\.\\d+)?)`, 'gi');
    for (let m = re.exec(text); m; m = re.exec(text)) hit = { start: m.index, end: m.index + m[0].length, text: m[0], n: Number(m[1]) };
  }
  if (!hit) return null;
  const outOfRange = (spec.min_value !== null && hit.n < spec.min_value) || (spec.max_value !== null && hit.n > spec.max_value);
  return fv(spec, hit.n, 'rule', outOfRange ? 0.45 : 0.95, hit, outOfRange ? { status: 'needs_review', note: 'Outside the expected range' } : {});
}

const NEGATION = String.raw`(?:not|never|no|didn't|wasn't|isn't|don't|doesn't)`;

function resolveBoolean(spec: FieldSpec, text: string): FieldValue | null {
  for (const trigger of spec.true_triggers) {
    const hit = findPhrase(text, trigger)[0];
    if (hit) return fv(spec, true, 'rule', 0.95, hit);
  }
  for (const trigger of spec.true_triggers) {
    const lastWord = trigger.trim().split(/\s+/).pop() ?? '';
    const stem = lastWord.slice(0, 5);
    if (stem.length < 4) continue;
    const re = new RegExp(`\\b${NEGATION}\\b(?:\\s+\\w+){0,3}?\\s+${escapeRe(stem)}\\w*`, 'i');
    const m = re.exec(text);
    if (m) return fv(spec, false, 'rule', 0.88, { start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return null;
}

function resolveText(spec: FieldSpec, text: string): FieldValue | null {
  if (!spec.fill_from_transcript || !text.trim()) return null;
  const max = spec.max_length ?? 400;
  const value = text.trim().slice(0, max);
  return fv(spec, value, 'rule', 0.7, { start: 0, end: Math.min(text.length, max), text: text.slice(0, max) }, { status: 'filled' });
}

function resolveRules(form: FormSchema, assets: Asset[], text: string): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const spec of form.fields) {
    let value: FieldValue | null = null;
    if (spec.type === 'enum') value = resolveEnum(spec, text);
    else if (spec.type === 'entity_ref') value = resolveEntity(spec, text, assets);
    else if (spec.type === 'number') value = resolveNumber(spec, text);
    else if (spec.type === 'boolean') value = resolveBoolean(spec, text);
    else value = resolveText(spec, text);
    if (value) out[spec.key] = value;
  }
  return out;
}

// ---- STT rendering ----------------------------------------------------------------------------------------------

function alterDigits(written: string, rng: Rng): string {
  const m = /\b\d{3,5}\b/.exec(written);
  if (!m) return written;
  const digits = m[0].split('');
  const at = digits.length - 1 - rng.int(0, 1);
  digits[at] = String((Number(digits[at]) + rng.int(1, 8)) % 10);
  return written.slice(0, m.index) + digits.join('') + written.slice(m.index + m[0].length);
}

const stripPunctuation = (s: string): string => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const estimateAudioMs = (text: string): number => Math.max(1500, Math.round(text.split(/\s+/).length * 390));

function renderTranscript(input: PipelineInput, rng: Rng): { raw: string; audioMs: number } {
  const audioMs = input.audioMs ?? estimateAudioMs(input.spoken ?? input.written);
  if (input.config.stt_engine_id === ORACLE_STT_ID) return { raw: input.written, audioMs };
  const profile = sttProfile(input.config.stt_engine_id);
  const mishear = rng.chance(profile.mishear);
  const written = mishear ? alterDigits(input.written, rng) : input.written;
  switch (profile.numberStyle) {
    case 'spaced':
      return { raw: spaceDigits(written), audioMs };
    case 'words':
      return { raw: !mishear && input.spoken ? stripPunctuation(input.spoken) : stripPunctuation(digitsToSpokenText(written)), audioMs };
    default:
      return { raw: written, audioMs };
  }
}

// ---- simulated LLM ----------------------------------------------------------------------------------------------

function confusable(spec: FieldSpec, truth: Scalar, assets: Asset[], rng: Rng): Scalar {
  if (spec.type === 'entity_ref') {
    const pool = assets.filter((a) => a.kind === spec.entity_kind && a.id !== String(truth));
    return pool.length > 0 ? rng.pick(pool).id : truth;
  }
  if (spec.type === 'enum') {
    const others = spec.options.filter((o) => o.code !== truth);
    return others.length > 0 ? rng.pick(others).code : truth;
  }
  if (spec.type === 'number') return typeof truth === 'number' ? truth * 10 : 10;
  if (spec.type === 'boolean') return !truth;
  return truth;
}

function plausible(spec: FieldSpec, assets: Asset[], rng: Rng): Scalar {
  if (spec.type === 'entity_ref') return rng.pick(assets.filter((a) => a.kind === spec.entity_kind)).id;
  if (spec.type === 'enum') return rng.pick(spec.options).code;
  if (spec.type === 'number') return spec.min_value ?? 10;
  if (spec.type === 'boolean') return true;
  return null;
}

function evidenceFor(spec: FieldSpec, value: Scalar, text: string): Hit | null {
  if (value === null || value === '') return null;
  const needle = spec.type === 'enum' ? (spec.options.find((o) => o.code === value)?.synonyms[0] ?? '') : String(value);
  if (!needle) return null;
  const hit = findPhrase(text, needle)[0];
  return hit ?? null;
}

const ID_MULT: Record<string, number> = { free_json: 1, schema_constrained: 1, enum_grammar: 0.6, hybrid: 0.5 };
const ENUM_MULT: Record<string, number> = { free_json: 1, schema_constrained: 1, enum_grammar: 0.3, hybrid: 0.5 };

function simulateLlm(
  input: PipelineInput,
  targets: FieldSpec[],
  text: string,
  rules: Record<string, FieldValue>,
  rng: Rng,
): { fields: Record<string, FieldValue>; warnings: string[] } {
  const profile = llmProfile(input.config.llm_engine_id);
  const strategy = input.config.strategy_id;
  const warnings: string[] = [];
  const fields: Record<string, FieldValue> = {};

  if (strategy === 'free_json' && rng.chance(profile.jsonInvalid)) {
    warnings.push('LLM output was not valid JSON and the lenient parse recovered nothing; all LLM-owned fields were left empty.');
    return { fields, warnings };
  }

  for (const spec of targets) {
    const hasTruth = input.expected != null && Object.prototype.hasOwnProperty.call(input.expected, spec.key);
    const truth: Scalar = hasTruth ? (input.expected?.[spec.key] ?? null) : (rules[spec.key]?.value ?? null);
    const pErr = (spec.type === 'entity_ref' ? profile.idError * (ID_MULT[strategy] ?? 1) : profile.enumError * (ENUM_MULT[strategy] ?? 1)) * (spec.type === 'number' || spec.type === 'boolean' ? 0.6 : 1);
    let value: Scalar;
    if (truth === null || truth === '') {
      const pHallucinate = (strategy === 'hybrid' ? 0.5 : 1.4) * profile.enumError;
      value = rng.chance(pHallucinate) ? plausible(spec, input.assets, rng) : null;
    } else {
      value = rng.chance(pErr) ? confusable(spec, truth, input.assets, rng) : truth;
    }
    if (spec.type === 'text') value = text.trim().slice(0, spec.max_length ?? 400) || null;
    if (value === null || value === '') continue;
    const confidence = strategy === 'hybrid' ? 0.72 + rng.float() * 0.2 : 0.9;
    fields[spec.key] = fv(spec, value, 'llm', confidence, evidenceFor(spec, value, text));
  }
  return { fields, warnings };
}

// ---- validation -------------------------------------------------------------------------------------------------

function validate(form: FormSchema, assets: Asset[], fields: Record<string, FieldValue>): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const spec of form.fields) {
    const f = fields[spec.key] ?? blank(spec.key);
    let next = f;
    if (f.value !== null && f.value !== '') {
      if (spec.type === 'entity_ref' && !assets.some((a) => a.id === String(f.value) && (!spec.entity_kind || a.kind === spec.entity_kind))) {
        next = { ...f, status: 'needs_review', confidence: Math.min(f.confidence, 0.45), note: f.note ?? "Not in today's assets" };
      } else if (spec.type === 'enum' && !spec.options.some((o) => o.code === f.value)) {
        next = { ...f, status: 'needs_review', confidence: Math.min(f.confidence, 0.4), note: 'Not one of the allowed options' };
      }
    }
    out[spec.key] = next;
  }
  return out;
}

// ---- pipeline ---------------------------------------------------------------------------------------------------

export function runPipeline(input: PipelineInput): PipelineRun {
  const { form, config } = input;
  const rng = new Rng(`${input.seed}|${configKey(config)}`);
  const strategy = config.strategy_id;
  const stt = sttProfile(config.stt_engine_id);
  const llm = llmProfile(config.llm_engine_id);
  const deterministic = strategy === 'hybrid' || strategy === 'rules_only';
  const llmAllowed = strategy !== 'rules_only' && config.llm_engine_id !== NO_LLM_ID;
  const oracle = config.stt_engine_id === ORACLE_STT_ID;

  const { raw, audioMs } = renderTranscript(input, rng);
  const normalized = normalizeNumbers(raw);

  const resolved = deterministic ? resolveRules(form, input.assets, normalized) : {};
  const nonText = form.fields.filter((f) => f.type !== 'text');
  const unresolved = deterministic ? nonText.filter((f) => !resolved[f.key] || resolved[f.key]?.value === null).map((f) => f.key) : [];

  let llmFields: Record<string, FieldValue> | null = null;
  let warnings: string[] = [];
  let promptTokens: number | null = null;
  let outputTokens: number | null = null;
  const words = normalized.split(/\s+/).filter(Boolean).length;

  if (llmAllowed) {
    const targets = strategy === 'hybrid' ? form.fields.filter((f) => unresolved.includes(f.key)) : form.fields;
    if (targets.length > 0) {
      const rulesForTruth = deterministic ? resolved : resolveRules(form, input.assets, normalized);
      const out = simulateLlm(input, targets, normalized, rulesForTruth, rng);
      llmFields = out.fields;
      warnings = out.warnings;
      const n = targets.length;
      if (strategy === 'free_json') {
        promptTokens = Math.round(180 + 38 * form.fields.length + words * 1.4);
        outputTokens = Math.round(25 + 14 * n);
      } else if (strategy === 'schema_constrained') {
        promptTokens = Math.round(180 + 38 * form.fields.length + words * 1.4);
        outputTokens = Math.round((25 + 14 * n) * 1.35);
      } else if (strategy === 'enum_grammar') {
        promptTokens = Math.round(90 + 14 * form.fields.length + words * 1.4);
        outputTokens = Math.round(6 * n);
      } else {
        promptTokens = Math.round(70 + 20 * n + words * 1.4);
        outputTokens = Math.round(8 * n);
      }
    }
  }

  const merged: Record<string, FieldValue> = {};
  for (const spec of form.fields) {
    const fromLlm = llmFields?.[spec.key];
    const fromRule = resolved[spec.key];
    merged[spec.key] = (strategy === 'hybrid' ? (fromRule && fromRule.value !== null ? fromRule : fromLlm) : (fromLlm ?? fromRule)) ?? blank(spec.key);
  }
  const validated = validate(form, input.assets, merged);

  const timings: StageTiming[] = [];
  const sttMs = oracle ? 0 : stt.streaming ? 220 + rng.float() * 220 + audioMs * 0.03 : audioMs * stt.rtf * rng.jitter(0.12);
  if (!oracle) timings.push({ stage: 'stt', ms: Math.round(sttMs), detail: { engine: config.stt_engine_id, streaming: stt.streaming } });
  const normalizeMs = Math.round((0.4 + rng.float() * 1.8) * 10) / 10;
  timings.push({ stage: 'normalize', ms: normalizeMs, detail: {} });
  let resolveMs: number | null = null;
  if (deterministic) {
    resolveMs = Math.round((2 + rng.float() * 9) * 10) / 10;
    timings.push({ stage: 'resolve', ms: resolveMs, detail: { resolved: Object.keys(resolved).length, unresolved: unresolved.length } });
  }
  let llmMs: number | null = null;
  if (llmFields !== null && promptTokens !== null && outputTokens !== null) {
    llmMs = Math.round((promptTokens * llm.prefillMsPerTok + outputTokens * llm.decodeMsPerTok) * rng.jitter(0.12));
    timings.push({ stage: 'llm', ms: llmMs, detail: { prompt_tokens: promptTokens, output_tokens: outputTokens } });
  }
  const validateMs = Math.round((0.5 + rng.float() * 1.5) * 10) / 10;
  timings.push({ stage: 'validate', ms: validateMs, detail: {} });
  const total = timings.reduce((acc, t) => acc + t.ms, 0) + Math.round(3 + rng.float() * 9);

  if (llmAllowed && llmFields === null && strategy === 'hybrid') {
    warnings = [...warnings, 'Every field was resolved deterministically, so the LLM was not called.'];
  }
  if (config.llm_engine_id === NO_LLM_ID && strategy !== 'rules_only' && strategy !== 'hybrid') {
    warnings = [...warnings, 'This strategy needs an LLM; no LLM was selected so nothing could be extracted.'];
  }

  return {
    result: {
      transcript_raw: raw,
      transcript_normalized: normalized,
      fields: validated,
      unresolved,
      timings,
      total_ms: Math.round(total),
      audio_ms: audioMs,
      stt_ms: Math.round(sttMs),
      stt_engine_id: config.stt_engine_id,
      llm_engine_id: config.llm_engine_id,
      strategy_id: strategy,
      llm_prompt_tokens: promptTokens,
      llm_output_tokens: outputTokens,
      warnings,
      error: null,
    },
    stages: { resolve: resolved, llm: llmFields, validate: validated },
    stageMs: { normalize: normalizeMs, resolve: resolveMs, llm: llmMs, validate: validateMs },
  };
}

export const mockExtract = (input: PipelineInput): ExtractionResult => runPipeline(input).result;
