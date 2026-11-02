/** Combo-matrix helpers shared by the Lab and the "New run" builder: expansion, presets and default engine picks. */
import type { EngineInfo, EngineList, RunConfig } from '@/api/types';
import { NO_LLM_ID, ORACLE_STT_ID } from '@/api/types';
import { bySize, configKey } from '@/lib/engineLabels';

/** Strategies that cannot do anything without an LLM. `hybrid` degrades to its deterministic stages instead. */
export const LLM_ONLY_STRATEGIES: ReadonlySet<string> = new Set(['free_json', 'schema_constrained', 'enum_grammar']);

export interface ExpandedCombos {
  combos: RunConfig[];
  /** Cross-product cells dropped because they are meaningless (e.g. an LLM-only strategy with no LLM). */
  skipped: number;
  /** Raw cross-product size before filtering. */
  raw: number;
}

/**
 * STT x LLM x strategy -> configs. `rules_only` always pairs with "no LLM" (once per STT engine), and LLM-only
 * strategies are skipped for "no LLM", so the live count shows what will really run.
 */
export function expandCombos(stt: string[], llm: string[], strategies: string[]): ExpandedCombos {
  const seen = new Set<string>();
  const combos: RunConfig[] = [];
  const raw = stt.length * llm.length * strategies.length;
  for (const s of stt) {
    for (const strategy of strategies) {
      for (const l of llm) {
        let llmId = l;
        if (strategy === 'rules_only') llmId = NO_LLM_ID;
        else if (LLM_ONLY_STRATEGIES.has(strategy) && l === NO_LLM_ID) continue;
        const cfg: RunConfig = { stt_engine_id: s, llm_engine_id: llmId, strategy_id: strategy };
        const key = configKey(cfg);
        if (seen.has(key)) continue;
        seen.add(key);
        combos.push(cfg);
      }
    }
  }
  return { combos, skipped: Math.max(0, raw - combos.length), raw };
}

export const isReady = (e: EngineInfo): boolean => e.availability === 'ready';

export interface DefaultEngines {
  stt: string;
  llm: string;
  strategy: string;
}

/** Tag the backend puts on the engines named by today's work package (the ones morning prep made sure are on the device). */
export const IN_WORK_PACKAGE = 'in-work-package';
const isPrepared = (e: EngineInfo): boolean => e.tags.includes(IN_WORK_PACKAGE);

/**
 * The engines morning prep prepared (the work package's), else first ready streaming STT / first ready real STT / the
 * oracle; and for the model the smallest ready real LLM (else no LLM).
 */
export function pickDefaultEngines(engines: EngineList | undefined): DefaultEngines {
  if (!engines) return { stt: ORACLE_STT_ID, llm: NO_LLM_ID, strategy: 'hybrid' };
  const readyStt = engines.stt.filter(isReady).filter((e) => e.id !== ORACLE_STT_ID);
  const stt = readyStt.find(isPrepared) ?? readyStt.find((e) => e.supports_streaming) ?? readyStt[0];
  const readyLlm = engines.llm.filter(isReady).filter((e) => e.id !== NO_LLM_ID);
  const llm = readyLlm.find(isPrepared) ?? [...readyLlm].sort(bySize)[0];
  return { stt: stt?.id ?? ORACLE_STT_ID, llm: llm?.id ?? NO_LLM_ID, strategy: 'hybrid' };
}

export type PresetId = 'baseline_vs_hybrid' | 'whisper_sizes' | 'model_ladder';

export interface Preset {
  id: PresetId;
  label: string;
  description: string;
}

export const PRESETS: Preset[] = [
  {
    id: 'baseline_vs_hybrid',
    label: 'Baseline vs hybrid',
    description: 'Rules only vs one LLM doing everything (free JSON) vs the hybrid pipeline, on the same speech engine.',
  },
  {
    id: 'whisper_sizes',
    label: 'Whisper sizes',
    description: 'Every ready Whisper size with the deterministic pipeline, to see what a bigger speech model buys.',
  },
  {
    id: 'model_ladder',
    label: 'Model ladder (small to large)',
    description: 'Every ready LLM from smallest to largest with the hybrid strategy.',
  },
];

export interface PresetSelection {
  stt: string[];
  llm: string[];
  strategies: string[];
  notes: string[];
}

export function buildPreset(id: PresetId, engines: EngineList): PresetSelection {
  const defaults = pickDefaultEngines(engines);
  const notes: string[] = [];
  switch (id) {
    case 'baseline_vs_hybrid': {
      if (defaults.llm === NO_LLM_ID) notes.push('No LLM is ready: only the rules-only baseline can run. Prepare a model on the Models page.');
      return {
        stt: [defaults.stt],
        llm: [defaults.llm],
        strategies: defaults.llm === NO_LLM_ID ? ['rules_only'] : ['rules_only', 'free_json', 'hybrid'],
        notes,
      };
    }
    case 'whisper_sizes': {
      const whisper = engines.stt.filter((e) => /whisper/i.test(e.id));
      const ready = whisper.filter(isReady).sort(bySize);
      const missing = whisper.length - ready.length;
      if (missing > 0) notes.push(`${missing} Whisper size${missing === 1 ? '' : 's'} not ready (download on the Models page).`);
      if (ready.length === 0) notes.push('No Whisper engine is ready.');
      return { stt: ready.map((e) => e.id), llm: [NO_LLM_ID], strategies: ['rules_only'], notes };
    }
    case 'model_ladder': {
      const llms = engines.llm.filter(isReady).filter((e) => e.id !== NO_LLM_ID).sort(bySize);
      const missing = engines.llm.filter((e) => e.id !== NO_LLM_ID && !isReady(e)).length;
      if (missing > 0) notes.push(`${missing} LLM${missing === 1 ? '' : 's'} not ready (download on the Models page).`);
      if (llms.length === 0) notes.push('No LLM is ready.');
      return { stt: [defaults.stt], llm: llms.map((e) => e.id), strategies: ['hybrid'], notes };
    }
  }
}
