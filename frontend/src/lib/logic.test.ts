import { describe, expect, it } from 'vitest';
import type { ExtractionResult, FieldSpec, FieldValue, FormSchema, WorkOrder } from '@/api/types';
import { buildDraft, formatFieldValue, isRequired, numberProblem, summarizeForm } from '@/lib/formLogic';
import { emptyFieldValue } from '@/lib/fieldMerge';
import { initialVoiceState, isBusy, voiceReducer, type VoiceSessionState } from '@/lib/voiceSession';
import { parseServerEvent, voiceSocketUrl } from '@/lib/voiceSocket';

const spec = (over: Partial<FieldSpec> & Pick<FieldSpec, 'key' | 'type'>): FieldSpec => ({
  label: over.key,
  required: false,
  help: null,
  options: [],
  entity_kind: null,
  role_triggers: [],
  unit: null,
  min_value: null,
  max_value: null,
  unit_triggers: [],
  label_triggers: [],
  true_triggers: [],
  fill_from_transcript: false,
  max_length: 400,
  required_when: null,
  ...over,
});

const fv = (key: string, value: FieldValue['value'], over: Partial<FieldValue> = {}): FieldValue => ({
  key,
  value,
  source: 'rule',
  confidence: 0.9,
  status: value === null ? 'missing' : 'filled',
  evidence: null,
  note: null,
  candidates: [],
  ...over,
});

const form: FormSchema = {
  id: 'transformer_replacement',
  version: 2,
  title: 'Transformer replacement',
  work_type: 'transformer_replacement',
  description: null,
  fields: [
    spec({ key: 'work_performed', type: 'enum', required: true, options: [{ code: 'transformer_replacement', label: 'Transformer replacement', synonyms: [] }] }),
    spec({ key: 'pole_id', type: 'entity_ref', required: true, entity_kind: 'pole' }),
    spec({ key: 'new_unit_id', type: 'entity_ref', entity_kind: 'stock_unit', required_when: { work_performed: 'transformer_replacement' } }),
    spec({ key: 'kva', type: 'number', unit: 'kVA', min_value: 5, max_value: 500 }),
    spec({ key: 'customer_notified', type: 'boolean' }),
    spec({ key: 'notes', type: 'text' }),
  ],
};

describe('isRequired', () => {
  it('honours required and required_when', () => {
    const [work, pole, unit] = form.fields as [FieldSpec, FieldSpec, FieldSpec];
    expect(isRequired(work, {})).toBe(true);
    expect(isRequired(pole, {})).toBe(true);
    expect(isRequired(unit, {})).toBe(false);
    expect(isRequired(unit, { work_performed: fv('work_performed', 'transformer_repair') })).toBe(false);
    expect(isRequired(unit, { work_performed: fv('work_performed', 'transformer_replacement') })).toBe(true);
  });
});

describe('summarizeForm', () => {
  it('counts missing required fields (including conditional ones), review items and conflicts', () => {
    const values = {
      work_performed: fv('work_performed', 'transformer_replacement'),
      pole_id: fv('pole_id', '123', { status: 'needs_review', confidence: 0.4 }),
      kva: fv('kva', 9000),
      notes: fv('notes', 'x', { status: 'conflict' }),
    };
    const s = summarizeForm(form, values);
    expect(s.requiredMissing.map((f) => f.key)).toEqual(['new_unit_id']);
    expect(s.needsReview.map((f) => f.key)).toEqual(['pole_id']);
    expect(s.conflicts.map((f) => f.key)).toEqual(['notes']);
    expect(s.outOfRange.map((f) => f.key)).toEqual(['kva']);
    expect(s.filled).toBe(4);
    expect(s.total).toBe(6);
  });

  it('counts a boolean false as filled and an empty form as all required missing', () => {
    expect(summarizeForm(form, { customer_notified: fv('customer_notified', false) }).filled).toBe(1);
    expect(summarizeForm(form, {}).requiredMissing.map((f) => f.key)).toEqual(['work_performed', 'pole_id']);
  });
});

describe('numberProblem / formatFieldValue', () => {
  const kva = form.fields[3] as FieldSpec;
  it('validates min/max and non-numbers', () => {
    expect(numberProblem(kva, 25)).toBeNull();
    expect(numberProblem(kva, 2)).toMatch(/at least 5 kVA/);
    expect(numberProblem(kva, 900)).toMatch(/at most 500 kVA/);
    expect(numberProblem(kva, 'abc')).toBe('Enter a number');
    expect(numberProblem(kva, null)).toBeNull();
  });

  it('formats display values', () => {
    expect(formatFieldValue(form.fields[0] as FieldSpec, 'transformer_replacement')).toBe('Transformer replacement');
    expect(formatFieldValue(kva, 25)).toBe('25 kVA');
    expect(formatFieldValue(form.fields[4] as FieldSpec, true)).toBe('Yes');
    expect(formatFieldValue(form.fields[4] as FieldSpec, false)).toBe('No');
    expect(formatFieldValue(kva, null)).toBe('');
  });
});

describe('buildDraft', () => {
  it('keeps touched fields, drops empty placeholders and stamps the work-order version', () => {
    const wo = { id: 'WO-1', version: 3 } as unknown as WorkOrder;
    const draft = buildDraft({
      workOrder: wo,
      form,
      values: { pole_id: fv('pole_id', '123'), notes: emptyFieldValue('notes'), kva: fv('kva', null, { status: 'needs_review', candidates: ['25'] }) },
      transcript: 'hello',
      sttEngineId: 'a',
      llmEngineId: 'b',
      strategyId: 'hybrid',
      timings: [],
      photos: [],
      now: new Date('2026-10-30T12:00:00Z'),
    });
    expect(Object.keys(draft.values).sort()).toEqual(['kva', 'pole_id']);
    expect(draft).toMatchObject({
      work_order_id: 'WO-1',
      form_id: 'transformer_replacement',
      form_version: 2,
      base_version: 3,
      status: 'draft',
      operation_id: null,
      updated_at: '2026-10-30T12:00:00.000Z',
    });
  });
});

describe('parseServerEvent', () => {
  it('parses every frame type from the contract', () => {
    expect(parseServerEvent('{"type":"ready"}')).toEqual({ type: 'ready' });
    expect(parseServerEvent('{"type":"partial","text":"i replaced","t_ms":420}')).toEqual({ type: 'partial', text: 'i replaced', t_ms: 420 });
    expect(parseServerEvent('{"type":"transcript","text":"hi","final":true,"stt_ms":300,"audio_ms":4200}')).toEqual({
      type: 'transcript',
      text: 'hi',
      final: true,
      stt_ms: 300,
      audio_ms: 4200,
    });
    expect(parseServerEvent('{"type":"stage","stage":"normalize","ms":3}')).toEqual({ type: 'stage', stage: 'normalize', ms: 3 });
    expect(parseServerEvent('{"type":"fields","stage":"resolve","fields":{"a":{}},"unresolved":["b"]}')).toMatchObject({ type: 'fields', unresolved: ['b'] });
    expect(parseServerEvent('{"type":"result","result":{"fields":{}}}')).toMatchObject({ type: 'result' });
    expect(parseServerEvent('{"type":"error","message":"boom"}')).toEqual({ type: 'error', message: 'boom' });
  });

  it('rejects malformed or unknown frames without throwing', () => {
    expect(parseServerEvent('not json')).toBeNull();
    expect(parseServerEvent('[]')).toBeNull();
    expect(parseServerEvent('{"type":"mystery"}')).toBeNull();
    expect(parseServerEvent('{"type":"partial"}')).toBeNull();
    expect(parseServerEvent('{"type":"fields","stage":"llm"}')).toBeNull();
  });

  it('builds ws/wss URLs from the page location', () => {
    expect(voiceSocketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws/voice');
    expect(voiceSocketUrl({ protocol: 'https:', host: 'field.example' })).toBe('wss://field.example/ws/voice');
  });
});

describe('voiceReducer', () => {
  const result = {
    transcript_raw: 'raw',
    transcript_normalized: 'norm',
    fields: { pole_id: fv('pole_id', '123') },
    unresolved: [],
    timings: [],
    total_ms: 10,
    audio_ms: 4000,
    stt_ms: 300,
    stt_engine_id: 'a',
    llm_engine_id: 'b',
    strategy_id: 'hybrid',
    llm_prompt_tokens: null,
    llm_output_tokens: null,
    warnings: [],
    error: null,
  } satisfies ExtractionResult;

  const run = (actions: Parameters<typeof voiceReducer>[1][], from: VoiceSessionState = initialVoiceState) =>
    actions.reduce(voiceReducer, from);

  it('follows the contract order: ready, partials, transcript, stages, fields, result', () => {
    let s = run([{ type: 'begin', mode: 'mic' }]);
    expect(s.phase).toBe('connecting');
    expect(isBusy(s.phase)).toBe(true);
    s = run([{ type: 'event', event: { type: 'ready' } }], s);
    expect(s.phase).toBe('listening');
    s = run(
      [
        { type: 'event', event: { type: 'partial', text: 'i', t_ms: 100 } },
        { type: 'event', event: { type: 'partial', text: 'i replaced', t_ms: 300 } },
      ],
      s,
    );
    expect(s.partial).toBe('i replaced'); // each partial replaces the previous one
    s = run([{ type: 'event', event: { type: 'transcript', text: 'i replaced the transformer', final: true, stt_ms: 250, audio_ms: 3000 } }], s);
    expect(s).toMatchObject({ phase: 'processing', partial: '', transcript: { text: 'i replaced the transformer', sttMs: 250, audioMs: 3000 } });
    s = run(
      [
        { type: 'event', event: { type: 'stage', stage: 'normalize', ms: 2 } },
        { type: 'event', event: { type: 'fields', stage: 'resolve', fields: { pole_id: fv('pole_id', '123') }, unresolved: ['condition'] } },
        { type: 'event', event: { type: 'stage', stage: 'resolve', ms: 9 } },
        { type: 'event', event: { type: 'fields', stage: 'llm', fields: { condition: fv('condition', 'leaking_oil', { source: 'llm' }) }, unresolved: [] } },
      ],
      s,
    );
    expect(Object.keys(s.fields)).toEqual(['pole_id', 'condition']);
    expect(s.stages.map((x) => x.stage)).toEqual(['normalize', 'resolve']);
    s = run([{ type: 'event', event: { type: 'result', result } }], s);
    expect(s.phase).toBe('done');
    expect(Object.keys(s.fields)).toEqual(['pole_id']); // the result is authoritative
    expect(s.result?.total_ms).toBe(10);
    expect(isBusy(s.phase)).toBe(false);
  });

  it('moves to processing when the user stops and records errors', () => {
    let s = run([{ type: 'begin', mode: 'mic' }, { type: 'event', event: { type: 'ready' } }, { type: 'stop_requested' }]);
    expect(s.phase).toBe('processing');
    s = run([{ type: 'event', event: { type: 'error', message: 'no model' } }], s);
    expect(s).toMatchObject({ phase: 'error', error: 'no model' });
  });

  it('turns an unexpected close into an error but ignores close after completion', () => {
    const mid = run([{ type: 'begin', mode: 'sample' }, { type: 'event', event: { type: 'ready' } }, { type: 'closed', reason: 'abnormal' }]);
    expect(mid.phase).toBe('error');
    const done = run([{ type: 'event', event: { type: 'result', result } }, { type: 'closed', reason: 'normal' }]);
    expect(done.phase).toBe('done');
  });

  it('adopts a non-streaming result (typed transcript / WAV upload)', () => {
    const s = run([{ type: 'external_result', result }]);
    expect(s).toMatchObject({ phase: 'done', transcript: { text: 'raw', sttMs: 300, audioMs: 4000 } });
    expect(s.fields.pole_id?.value).toBe('123');
  });

  it('reset returns to idle', () => {
    expect(run([{ type: 'begin', mode: 'mic' }, { type: 'reset' }])).toEqual(initialVoiceState);
  });
});
