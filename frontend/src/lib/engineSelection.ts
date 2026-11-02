import type { EngineList } from '@/api/types';
import { NO_LLM_ID, ORACLE_STT_ID } from '@/api/types';
import { pickDefaultEngines } from '@/lib/combos';

export interface EngineSelectionState {
  stt: string;
  llm: string;
  strategy: string;
}

/**
 * Turns the remembered choice into a usable one: engines that disappeared or are no longer ready fall back to the
 * defaults (first ready streaming STT, smallest ready LLM, hybrid). Before the engine list loads the safe values win.
 */
export function resolveSelection(stored: Partial<EngineSelectionState> | null | undefined, engines: EngineList | undefined): EngineSelectionState {
  const defaults = pickDefaultEngines(engines);
  if (!engines) return { stt: stored?.stt || ORACLE_STT_ID, llm: stored?.llm || NO_LLM_ID, strategy: stored?.strategy || defaults.strategy };
  const ready = (id: string | undefined, list: EngineList['stt']) => !!id && list.some((e) => e.id === id && e.availability === 'ready');
  const strategyOk = !!stored?.strategy && engines.strategies.some((s) => s.id === stored.strategy);
  return {
    stt: ready(stored?.stt, engines.stt) ? (stored?.stt as string) : defaults.stt,
    llm: ready(stored?.llm, engines.llm) ? (stored?.llm as string) : defaults.llm,
    strategy: strategyOk ? (stored?.strategy as string) : defaults.strategy,
  };
}
