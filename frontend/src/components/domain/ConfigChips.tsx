import type { EngineInfo, RunConfig } from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { configLabel } from '@/lib/engineLabels';

/** STT / LLM / strategy of one configuration as three small chips. */
export function ConfigChips({ config, engines, size = 'sm' }: { config: RunConfig; engines?: EngineInfo[]; size?: 'sm' | 'md' }) {
  const l = configLabel(config, engines);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge tone="blue" size={size} title={config.stt_engine_id}>
        {l.stt}
        {l.sttDevice ? <span className="ml-1 opacity-60">{l.sttDevice}</span> : null}
      </Badge>
      <Badge tone="violet" size={size} title={config.llm_engine_id}>
        {l.llm}
        {l.llmDevice ? <span className="ml-1 opacity-60">{l.llmDevice}</span> : null}
      </Badge>
      <Badge tone="gray" size={size} title={config.strategy_id}>
        {l.strategy}
      </Badge>
    </div>
  );
}
