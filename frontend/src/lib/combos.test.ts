import { describe, expect, it } from 'vitest';
import type { EngineInfo, EngineList } from '@/api/types';
import { NO_LLM_ID, ORACLE_STT_ID } from '@/api/types';
import { buildPreset, expandCombos, pickDefaultEngines } from '@/lib/combos';
import { configKey, configLabel, engineName, parseConfigKey, parseEngineId } from '@/lib/engineLabels';

function engine(id: string, kind: 'stt' | 'llm', over: Partial<EngineInfo> = {}): EngineInfo {
  return {
    id,
    kind,
    name: id.split(':')[2] ?? id,
    provider: id.split(':')[0] ?? 'foundry',
    offline: true,
    supports_streaming: false,
    availability: 'ready',
    availability_reason: null,
    alias: id.split(':')[2] ?? null,
    variant_id: null,
    device: 'cpu',
    execution_provider: null,
    size_mb: null,
    loaded: false,
    tags: [],
    ...over,
  };
}

const engines: EngineList = {
  stt: [
    engine(ORACLE_STT_ID, 'stt'),
    engine('foundry:stt:whisper-tiny:cpu', 'stt', { size_mb: 130 }),
    engine('foundry:stt:whisper-small:cpu', 'stt', { size_mb: 480, availability: 'needs_download' }),
    engine('foundry:stt:whisper-base:cpu', 'stt', { size_mb: 290 }),
    engine('foundry:stt:nemotron-speech-streaming-en-0.6b:cpu', 'stt', { size_mb: 700, supports_streaming: true }),
    engine('azure-cloud:stt:default', 'stt', { availability: 'unavailable', offline: false }),
  ],
  llm: [
    engine(NO_LLM_ID, 'llm'),
    engine('foundry:llm:phi-3.5-mini:cpu', 'llm', { size_mb: 2600 }),
    engine('foundry:llm:qwen2.5-0.5b:cpu', 'llm', { size_mb: 530 }),
    engine('foundry:llm:qwen2.5-1.5b:cpu', 'llm', { size_mb: 1100, availability: 'needs_download' }),
  ],
  strategies: [],
};

describe('expandCombos', () => {
  it('builds the cross product', () => {
    const { combos, skipped, raw } = expandCombos(['s1', 's2'], ['l1', 'l2'], ['hybrid']);
    expect(combos).toHaveLength(4);
    expect(raw).toBe(4);
    expect(skipped).toBe(0);
  });

  it('pairs rules_only with no LLM exactly once per STT and skips LLM-only strategies without an LLM', () => {
    const { combos, skipped } = expandCombos(['s1'], [NO_LLM_ID, 'l1', 'l2'], ['rules_only', 'free_json', 'hybrid']);
    expect(combos.map(configKey)).toEqual([
      `s1|${NO_LLM_ID}|rules_only`,
      's1|l1|free_json',
      's1|l2|free_json',
      `s1|${NO_LLM_ID}|hybrid`,
      's1|l1|hybrid',
      's1|l2|hybrid',
    ]);
    expect(skipped).toBe(9 - 6);
  });

  it('is empty when any axis is empty', () => {
    expect(expandCombos([], ['l'], ['hybrid']).combos).toEqual([]);
    expect(expandCombos(['s'], [], ['hybrid']).combos).toEqual([]);
    expect(expandCombos(['s'], ['l'], []).combos).toEqual([]);
  });
});

describe('pickDefaultEngines', () => {
  it('prefers the first ready streaming STT and the smallest ready real LLM', () => {
    expect(pickDefaultEngines(engines)).toEqual({
      stt: 'foundry:stt:nemotron-speech-streaming-en-0.6b:cpu',
      llm: 'foundry:llm:qwen2.5-0.5b:cpu',
      strategy: 'hybrid',
    });
  });

  it('falls back to the first ready non-oracle STT, then to rules only', () => {
    const noStreaming: EngineList = {
      ...engines,
      stt: engines.stt.map((e) => (e.supports_streaming ? { ...e, availability: 'needs_download' as const } : e)),
      llm: engines.llm.map((e) => (e.id === NO_LLM_ID ? e : { ...e, availability: 'unavailable' as const })),
    };
    expect(pickDefaultEngines(noStreaming)).toMatchObject({ stt: 'foundry:stt:whisper-tiny:cpu', llm: NO_LLM_ID });
    expect(pickDefaultEngines(undefined)).toEqual({ stt: ORACLE_STT_ID, llm: NO_LLM_ID, strategy: 'hybrid' });
  });

  it('prefers the engines morning prep prepared (tagged in-work-package) over streaming and size', () => {
    const tag = (e: EngineInfo): EngineInfo => ({ ...e, tags: ['in-work-package'] });
    const prepared: EngineList = {
      ...engines,
      stt: engines.stt.map((e) => (e.id === 'foundry:stt:whisper-base:cpu' ? tag(e) : e)),
      llm: [...engines.llm.filter((e) => e.id !== 'foundry:llm:phi-3.5-mini:cpu'), tag(engines.llm[1]!)],
    };
    expect(pickDefaultEngines(prepared)).toEqual({
      stt: 'foundry:stt:whisper-base:cpu',
      llm: 'foundry:llm:phi-3.5-mini:cpu',
      strategy: 'hybrid',
    });
  });
});

describe('presets', () => {
  it('baseline_vs_hybrid compares rules only, the free-JSON baseline and hybrid on one STT / LLM', () => {
    const p = buildPreset('baseline_vs_hybrid', engines);
    expect(p.strategies).toEqual(['rules_only', 'free_json', 'hybrid']);
    expect(p.llm).toEqual(['foundry:llm:qwen2.5-0.5b:cpu']);
    expect(expandCombos(p.stt, p.llm, p.strategies).combos).toHaveLength(3);
  });

  it('whisper_sizes lists ready Whisper engines smallest first and notes the missing ones', () => {
    const p = buildPreset('whisper_sizes', engines);
    expect(p.stt).toEqual(['foundry:stt:whisper-tiny:cpu', 'foundry:stt:whisper-base:cpu']);
    expect(p.notes.join(' ')).toMatch(/1 Whisper size not ready/);
  });

  it('model_ladder orders ready LLMs small to large and notes the missing ones', () => {
    const p = buildPreset('model_ladder', engines);
    expect(p.llm).toEqual(['foundry:llm:qwen2.5-0.5b:cpu', 'foundry:llm:phi-3.5-mini:cpu']);
    expect(p.strategies).toEqual(['hybrid']);
    expect(p.notes.join(' ')).toMatch(/1 LLM not ready/);
  });

  it('baseline_vs_hybrid degrades to rules only when no LLM is ready', () => {
    const none: EngineList = { ...engines, llm: [engine(NO_LLM_ID, 'llm')] };
    const p = buildPreset('baseline_vs_hybrid', none);
    expect(p.strategies).toEqual(['rules_only']);
    expect(p.notes.length).toBeGreaterThan(0);
  });
});

describe('engine labels', () => {
  it('round-trips config keys', () => {
    const cfg = { stt_engine_id: 'a:stt:b:cpu', llm_engine_id: NO_LLM_ID, strategy_id: 'rules_only' };
    expect(parseConfigKey(configKey(cfg))).toEqual(cfg);
    expect(parseConfigKey('nope')).toBeNull();
  });

  it('parses engine ids and builds readable names', () => {
    expect(parseEngineId('foundry:stt:whisper-base:cpu')).toEqual({ provider: 'foundry', kind: 'stt', alias: 'whisper-base', device: 'cpu' });
    expect(parseEngineId('azure-cloud:stt:default').device).toBeNull();
    expect(engineName(ORACLE_STT_ID)).toBe('Reference transcript');
    expect(engineName(NO_LLM_ID)).toBe('No LLM');
    expect(engineName('foundry:llm:qwen2.5-0.5b:cpu')).toBe('qwen2.5-0.5b');
    expect(engineName('foundry:llm:qwen2.5-0.5b:cpu', [engine('foundry:llm:qwen2.5-0.5b:cpu', 'llm', { name: 'Qwen 2.5 0.5B' })])).toBe('Qwen 2.5 0.5B');
    expect(configLabel({ stt_engine_id: 'foundry:stt:whisper-base:cpu', llm_engine_id: NO_LLM_ID, strategy_id: 'hybrid' })).toMatchObject({
      stt: 'whisper-base',
      llm: 'No LLM',
      strategy: 'hybrid',
      sttDevice: 'cpu',
    });
  });
});
