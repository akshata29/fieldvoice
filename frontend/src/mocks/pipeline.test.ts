import { describe, expect, it } from 'vitest';
import type { Asset, FormSchema, RunConfig } from '@/api/types';
import { NO_LLM_ID, ORACLE_STT_ID } from '@/api/types';
import { valuesEqual } from '@/lib/fieldDiff';
import { generateCases } from '@/mocks/dataset';
import { runPipeline } from '@/mocks/extractor';
import { ASSETS, FORMS, KB_DOCS, WORKERS, buildWorkOrders, closedWorld } from '@/mocks/fixtures/world';
import { buildEngines, llmProfile, sttProfile } from '@/mocks/fixtures/engines';
import { percentile, latencyStats } from '@/mocks/stats';

const form = (id: string): FormSchema => FORMS.find((f) => f.id === id) as FormSchema;
const cfg = (stt: string, llm: string, strategy: string): RunConfig => ({ stt_engine_id: stt, llm_engine_id: llm, strategy_id: strategy });
const QWEN05 = 'foundry:llm:qwen2.5-0.5b:cpu';
const TRANSFORMER = form('transformer_replacement');

describe('fixtures', () => {
  it('has 5 workers, 6 work orders over 3 form types, and every form field type is present', () => {
    expect(WORKERS).toHaveLength(5);
    const wos = buildWorkOrders('w-101');
    expect(wos).toHaveLength(6);
    expect(new Set(wos.map((w) => w.form_id)).size).toBe(3);
    const types = new Set(TRANSFORMER.fields.map((f) => f.type));
    expect(Array.from(types).sort()).toEqual(['boolean', 'entity_ref', 'enum', 'number', 'text']);
    expect(TRANSFORMER.fields.some((f) => f.required_when)).toBe(true);
  });

  it('references only assets and knowledge-base documents that exist', () => {
    const assetIds = new Set(ASSETS.map((a) => a.id));
    const docIds = new Set(KB_DOCS.map((d) => d.id));
    for (const wo of buildWorkOrders('w-101')) {
      for (const id of wo.asset_ids) expect(assetIds.has(id), `${wo.id} asset ${id}`).toBe(true);
      for (const id of wo.kb_doc_ids) expect(docIds.has(id), `${wo.id} doc ${id}`).toBe(true);
    }
    for (const f of FORMS) for (const spec of f.fields) if (spec.entity_kind) expect(ASSETS.some((a) => a.kind === spec.entity_kind), spec.key).toBe(true);
  });

  it("a work order's closed world is its assets plus the stock inventory", () => {
    const wo = buildWorkOrders('w-101')[0]!;
    const world = closedWorld(wo);
    expect(world.some((a) => a.id === '123')).toBe(true);
    expect(world.filter((a) => a.kind === 'stock_unit').length).toBeGreaterThan(3);
    expect(new Set(world.map((a) => a.id)).size).toBe(world.length);
  });

  it('offers engines in every availability state, each non-ready one with a reason', () => {
    const engines = buildEngines();
    const states = new Set(engines.map((e) => e.availability));
    expect(Array.from(states).sort()).toEqual(['error', 'needs_download', 'ready', 'unavailable']);
    for (const e of engines) if (e.availability !== 'ready') expect(e.availability_reason, e.id).toBeTruthy();
    expect(engines.find((e) => e.id === 'azure-cloud:stt:default')?.offline).toBe(false);
    expect(engines.find((e) => e.id.startsWith('azure-embedded'))?.availability_reason).toMatch(/aka\.ms\/csgate-embedded-speech/);
  });
});

describe('synthetic dataset', () => {
  const opts = { id: 'd', name: 'd', n: 72, seed: 11, audioLimit: 36, augment: true };
  const cases = generateCases(opts);

  it('is deterministic for a seed and covers all forms, splits and the key tags', () => {
    expect(generateCases(opts)).toEqual(cases);
    expect(new Set(cases.map((c) => c.form_id)).size).toBe(3);
    expect(new Set(cases.map((c) => c.split))).toEqual(new Set(['dev', 'heldout']));
    const tags = new Set(cases.flatMap((c) => c.tags));
    for (const t of ['correction', 'negation', 'missing', 'colloquial', 'digits', 'grouped', 'noisy']) expect(tags.has(t), t).toBe(true);
    expect(cases.filter((c) => c.audio_path).length).toBe(36);
  });

  it('starts every form with the hero utterance and gives each case ground truth for every field it mentions', () => {
    const hero = cases.find((c) => c.tags.includes('hero') && c.form_id === 'transformer_replacement');
    expect(hero?.written_text).toBe('I replaced the transformer at pole 123. The old unit was leaking oil and I installed unit 456.');
    expect(hero?.expected).toMatchObject({ pole_id: '123', new_unit_id: '456', old_unit_condition: 'leaking_oil' });
    for (const c of cases) {
      const f = form(c.form_id);
      for (const k of Object.keys(c.expected)) expect(f.fields.some((x) => x.key === k), `${c.id}.${k}`).toBe(true);
    }
  });
});

describe('mock extraction pipeline', () => {
  const assets: Asset[] = closedWorld(buildWorkOrders('w-101')[0]!);
  const hero = {
    written: 'I replaced the transformer at pole 123. The old unit was leaking oil and I installed unit 456.',
    spoken: 'I replaced the transformer at pole one two three. The old unit was leaking oil and I installed unit four five six.',
  };
  const input = (config: RunConfig, extra: Partial<Parameters<typeof runPipeline>[0]> = {}) =>
    ({ form: TRANSFORMER, assets, ...hero, config, seed: 'test', ...extra }) satisfies Parameters<typeof runPipeline>[0];

  it('rules-only resolves the example utterance deterministically, with evidence spans into the normalised transcript', () => {
    const { result } = runPipeline(input(cfg(ORACLE_STT_ID, NO_LLM_ID, 'rules_only')));
    const f = result.fields;
    expect(f.work_performed?.value).toBe('transformer_replacement');
    expect(f.pole_id?.value).toBe('123');
    expect(f.old_unit_condition?.value).toBe('leaking_oil');
    expect(f.new_unit_id?.value).toBe('456');
    expect(f.customer_notified?.status).toBe('missing');
    expect(f.pole_id?.source).toBe('rule');
    for (const key of ['pole_id', 'new_unit_id', 'old_unit_condition']) {
      const ev = f[key]?.evidence;
      expect(ev, key).not.toBeNull();
      expect(result.transcript_normalized.slice(ev!.start, ev!.end)).toBe(ev!.text);
    }
    expect(result.unresolved).toContain('customer_notified');
    expect(result.llm_prompt_tokens).toBeNull();
    expect(result.timings.map((t) => t.stage)).toEqual(['normalize', 'resolve', 'validate']);
  });

  it('flags ids that are not in the closed world instead of guessing', () => {
    const { result } = runPipeline(input(cfg(ORACLE_STT_ID, NO_LLM_ID, 'rules_only'), { written: 'I replaced the transformer at pole 999 and installed unit 456.' }));
    expect(result.fields.pole_id).toMatchObject({ value: '999', status: 'needs_review' });
    expect(result.fields.pole_id?.note).toMatch(/not in today's assets/i);
    expect(result.fields.new_unit_id?.status).toBe('filled');
  });

  it('handles negation, units, and the latest of two spoken ids', () => {
    const neg = runPipeline(input(cfg(ORACLE_STT_ID, NO_LLM_ID, 'rules_only'), { written: 'Replaced the transformer at pole 123. The customer was not notified. 50 kVA unit.' })).result;
    expect(neg.fields.customer_notified?.value).toBe(false);
    expect(neg.fields.new_unit_kva?.value).toBe(50);
    const fix = runPipeline(input(cfg(ORACLE_STT_ID, NO_LLM_ID, 'rules_only'), { written: 'Replaced the transformer at pole 123, no wait, pole 211.' })).result;
    expect(fix.fields.pole_id?.value).toBe('211');
  });

  it('engines render ids differently, and the normaliser makes them equivalent', () => {
    const tiny = runPipeline(input(cfg('foundry:stt:whisper-tiny:cpu', NO_LLM_ID, 'rules_only'), { seed: 'a-no-mishear' })).result;
    const nemo = runPipeline(input(cfg('foundry:stt:nemotron-speech-streaming-en-0.6b:cpu', NO_LLM_ID, 'rules_only'), { seed: 'a-no-mishear' })).result;
    // when no misheard digit is injected both normalise to the same ids
    const hasId = (r: typeof tiny, id: string) => r.transcript_normalized.includes(id);
    if (tiny.transcript_raw.includes('1 2 3')) expect(hasId(tiny, '123')).toBe(true);
    if (nemo.transcript_raw.includes('one two three')) expect(hasId(nemo, '123')).toBe(true);
    expect(nemo.transcript_raw).not.toMatch(/\d/);
    expect(nemo.transcript_raw).toBe(nemo.transcript_raw.toLowerCase());
  });

  it('is deterministic for the same seed and configuration', () => {
    const c = cfg('foundry:stt:whisper-base:cpu', QWEN05, 'hybrid');
    expect(runPipeline(input(c, { seed: 's1' })).result).toEqual(runPipeline(input(c, { seed: 's1' })).result);
  });

  it('hybrid only asks the LLM about what the rules left over; free_json asks it about everything', () => {
    const colloquial = { written: 'Swapped the pot on pole 123. The old one was leaking, put in unit 456.', spoken: null, expected: { work_performed: 'transformer_replacement', pole_id: '123', old_unit_condition: 'leaking_oil', new_unit_id: '456' } };
    const hybrid = runPipeline(input(cfg(ORACLE_STT_ID, QWEN05, 'hybrid'), colloquial));
    expect(hybrid.result.unresolved).toContain('work_performed');
    expect(hybrid.stages.llm).not.toBeNull();
    expect(Object.keys(hybrid.stages.llm ?? {}).every((k) => hybrid.result.unresolved.includes(k))).toBe(true);
    const free = runPipeline(input(cfg(ORACLE_STT_ID, QWEN05, 'free_json'), colloquial));
    expect(free.result.unresolved).toEqual([]);
    expect(free.result.llm_prompt_tokens).toBeGreaterThan(hybrid.result.llm_prompt_tokens ?? 0);
    expect(free.result.timings.find((t) => t.stage === 'resolve')).toBeUndefined();
  });

  it('skips the LLM entirely when the rules resolved everything', () => {
    const run = runPipeline(input(cfg(ORACLE_STT_ID, QWEN05, 'hybrid'), { form: form('pole_inspection'), written: 'Pole 305 is rotted at the base and needs treatment. Lean about 12 degrees.' }));
    expect(run.result.unresolved).toEqual(['pole_condition'].filter((k) => run.result.unresolved.includes(k)));
    const all = runPipeline(input(cfg(ORACLE_STT_ID, QWEN05, 'hybrid'), { form: form('pole_inspection'), written: 'Inspected pole 305. It is leaning. Pole 305 needs treatment. Lean angle about 12 degrees.' }));
    expect(all.result.unresolved).toEqual([]);
    expect(all.stages.llm).toBeNull();
    expect(all.result.warnings.join(' ')).toMatch(/LLM was not called/);
  });

  it('rejects nonsense combinations gracefully: LLM-only strategy with no LLM extracts nothing and warns', () => {
    const { result } = runPipeline(input(cfg(ORACLE_STT_ID, NO_LLM_ID, 'free_json')));
    expect(Object.values(result.fields).every((f) => f.status === 'missing')).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/needs an LLM/);
  });

  it('bigger models make fewer id mistakes on average (seeded profiles), and silent errors only come from confident values', () => {
    const cases = generateCases({ id: 'x', name: 'x', n: 90, seed: 5, audioLimit: 0, augment: false }).filter((c) => c.form_id === 'transformer_replacement');
    const wrongIds = (llm: string): number => {
      let wrong = 0;
      for (const c of cases) {
        const r = runPipeline({ form: TRANSFORMER, assets, written: c.written_text, spoken: c.spoken_text, expected: c.expected, config: cfg(ORACLE_STT_ID, llm, 'free_json'), seed: c.id }).result;
        for (const key of ['pole_id', 'new_unit_id']) if (key in c.expected && !valuesEqual(c.expected[key], r.fields[key]?.value ?? null)) wrong++;
      }
      return wrong;
    };
    expect(wrongIds('foundry:llm:phi-3.5-mini:cpu')).toBeLessThanOrEqual(wrongIds(QWEN05));
    expect(llmProfile(QWEN05).idError).toBeGreaterThan(llmProfile('foundry:llm:phi-3.5-mini:cpu').idError);
    expect(sttProfile('foundry:stt:whisper-tiny:cpu').mishear).toBeGreaterThan(sttProfile('foundry:stt:whisper-small:cpu').mishear);
  });
});

describe('stats helpers', () => {
  it('computes interpolated percentiles and latency summaries', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([10, 20], 50)).toBe(15);
    expect(percentile([0, 100], 95)).toBeCloseTo(95, 6);
    expect(latencyStats([100, 200, 300])).toEqual({ n: 3, mean: 200, p50: 200, p95: 290, max: 300 });
    expect(latencyStats([])).toEqual({ n: 0, mean: null, p50: null, p95: null, max: null });
  });
});
