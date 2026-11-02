/** Engine / strategy naming helpers. Engine id convention: `{provider}:{kind}:{alias}[:{device}]`. */
import type { EngineInfo, RunConfig, StrategyInfo } from '@/api/types';
import { NO_LLM_ID, ORACLE_STT_ID } from '@/api/types';

export const configKey = (c: RunConfig): string => `${c.stt_engine_id}|${c.llm_engine_id}|${c.strategy_id}`;

export function parseConfigKey(key: string): RunConfig | null {
  const parts = key.split('|');
  if (parts.length !== 3) return null;
  const [stt, llm, strategy] = parts as [string, string, string];
  return { stt_engine_id: stt, llm_engine_id: llm, strategy_id: strategy };
}

export interface ParsedEngineId {
  provider: string;
  kind: string;
  alias: string;
  device: string | null;
}

export function parseEngineId(id: string): ParsedEngineId {
  const [provider = '', kind = '', alias = '', ...rest] = id.split(':');
  return { provider, kind, alias, device: rest.length > 0 ? rest.join(':') : null };
}

const STRATEGY_FALLBACK: Record<string, { name: string; short: string }> = {
  free_json: { name: 'Free JSON (baseline)', short: 'free JSON' },
  schema_constrained: { name: 'Schema-constrained JSON', short: 'schema' },
  enum_grammar: { name: 'Enum grammar', short: 'enum grammar' },
  hybrid: { name: 'Hybrid (rules first, LLM for the rest)', short: 'hybrid' },
  rules_only: { name: 'Rules only (no LLM)', short: 'rules only' },
};

export function strategyName(id: string, strategies?: StrategyInfo[]): string {
  return strategies?.find((s) => s.id === id)?.name ?? STRATEGY_FALLBACK[id]?.name ?? id;
}

export function strategyShort(id: string): string {
  return STRATEGY_FALLBACK[id]?.short ?? id;
}

/** Short display name for an engine id, preferring the registry's `name` when the engine list is known. */
export function engineName(id: string, engines?: EngineInfo[]): string {
  if (id === ORACLE_STT_ID) return 'Reference transcript';
  if (id === NO_LLM_ID) return 'No LLM';
  const found = engines?.find((e) => e.id === id);
  if (found) return found.name;
  const parsed = parseEngineId(id);
  return parsed.alias || id;
}

export function engineDevice(id: string, engines?: EngineInfo[]): string | null {
  const found = engines?.find((e) => e.id === id);
  if (found?.device) return found.device;
  return parseEngineId(id).device;
}

export interface ConfigLabel {
  stt: string;
  llm: string;
  strategy: string;
  sttDevice: string | null;
  llmDevice: string | null;
}

export function configLabel(c: RunConfig, engines?: EngineInfo[]): ConfigLabel {
  return {
    stt: engineName(c.stt_engine_id, engines),
    llm: engineName(c.llm_engine_id, engines),
    strategy: strategyShort(c.strategy_id),
    sttDevice: engineDevice(c.stt_engine_id, engines),
    llmDevice: engineDevice(c.llm_engine_id, engines),
  };
}

export function configText(c: RunConfig, engines?: EngineInfo[]): string {
  const l = configLabel(c, engines);
  return `${l.stt} + ${l.llm} / ${l.strategy}`;
}

/** Model-family size ordering for "small to large" ladders; falls back to size_mb. */
export function bySize(a: EngineInfo, b: EngineInfo): number {
  return (a.size_mb ?? Number.MAX_SAFE_INTEGER) - (b.size_mb ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name);
}
