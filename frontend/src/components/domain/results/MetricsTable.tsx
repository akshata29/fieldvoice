import { memo } from 'react';
import { StarIcon } from '@heroicons/react/24/solid';
import type { ConfigMetrics, DecisionRow, EngineInfo, LatencyStats } from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { Table, Td, Th, Tr, useSort } from '@/components/ui/Table';
import { ConfigChips } from '@/components/domain/ConfigChips';
import { fmtMb, fmtMs, fmtNum, fmtPct } from '@/lib/format';
import { cn } from '@/lib/cn';

const pair = (s: LatencyStats): string => (s.p50 === null ? '-' : `${fmtMs(s.p50)} / ${fmtMs(s.p95)}`);

const ACCESSORS: Record<string, (m: ConfigMetrics) => number | string | null> = {
  config: (m) => m.config_key,
  field_accuracy: (m) => m.field_accuracy,
  id_field_accuracy: (m) => m.id_field_accuracy,
  silent: (m) => m.silent_wrong_rate,
  review: (m) => m.review_rate,
  safe: (m) => m.safe_outcome_rate,
  wer: (m) => m.wer,
  p50: (m) => m.latency_total.p50,
  p95: (m) => m.latency_total.p95,
  stt: (m) => m.latency_stt.p95,
  extract: (m) => m.latency_extract.p95,
  llm: (m) => m.latency_llm.p95,
  tokens: (m) => (m.llm_prompt_tokens_mean ?? 0) + (m.llm_output_tokens_mean ?? 0) || null,
  rss: (m) => m.peak_rss_mb,
  size: (m) => m.model_size_mb,
  n: (m) => m.n_cases,
};

function silentTone(rate: number): string {
  if (rate > 0.05) return 'font-bold text-red-700';
  if (rate > 0.02) return 'font-semibold text-amber-700';
  return 'font-semibold text-emerald-700';
}

function MetricsTableImpl({
  configs,
  decision,
  pareto,
  selectedKey,
  onSelect,
  engines,
}: {
  configs: ConfigMetrics[];
  decision?: Map<string, DecisionRow>;
  pareto?: ReadonlySet<string>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  engines?: EngineInfo[];
}) {
  const { sorted, sort, toggle } = useSort(configs, ACCESSORS, { key: 'field_accuracy', dir: 'desc' });
  const th = (id: string, label: string, title?: string) => (
    <Th sortKey={id} activeSort={sort} onSort={toggle} align="right" title={title}>
      {label}
    </Th>
  );
  return (
    <Table aria-label="Metrics per configuration">
      <thead>
        <tr>
          <Th sortKey="config" activeSort={sort} onSort={toggle} sticky className="min-w-[16rem]">
            Configuration
          </Th>
          {th('field_accuracy', 'Field acc.', 'Share of (case, field) pairs extracted correctly, including "left empty" expectations')}
          {th('id_field_accuracy', 'ID acc.', 'Accuracy on entity-id fields only')}
          {th('silent', 'Silent-wrong', 'Confident, filled and wrong, as a share of confident fields: the number that matters')}
          {th('review', 'Review', 'Share of fields flagged for the worker')}
          {th('safe', 'Safe', 'Correct or flagged: never silently wrong')}
          {th('wer', 'WER', 'Raw word error rate vs the spoken text (normalised WER in the tooltip)')}
          {th('p50', 'p50 total')}
          {th('p95', 'p95 total')}
          {th('stt', 'STT p50/p95')}
          {th('extract', 'Extract p50/p95', 'Everything after speech-to-text')}
          {th('llm', 'LLM p50/p95')}
          {th('tokens', 'Tokens in/out')}
          {th('rss', 'Peak RAM')}
          {th('size', 'Model size')}
          {th('n', 'Cases')}
        </tr>
      </thead>
      <tbody>
        {sorted.map((m) => {
          const d = decision?.get(m.config_key);
          const selected = m.config_key === selectedKey;
          return (
            <Tr key={m.config_key} selected={selected} onClick={() => onSelect(m.config_key)} tabIndex={0} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(m.config_key)}>
              <Td sticky className="min-w-[16rem]">
                <ConfigChips config={m.config} engines={engines} />
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {d ? (
                    d.passes ? (
                      <Badge tone="green" size="sm">
                        passes{d.rank ? ` - rank ${d.rank}` : ''}
                      </Badge>
                    ) : (
                      <Badge tone="red" size="sm">
                        fails {d.failed_gates.length} gate{d.failed_gates.length === 1 ? '' : 's'}
                      </Badge>
                    )
                  ) : null}
                  {pareto?.has(m.config_key) ? (
                    <Badge tone="violet" size="sm" icon={StarIcon} title="Pareto-optimal: no other configuration is both faster and more accurate">
                      Pareto
                    </Badge>
                  ) : null}
                </div>
              </Td>
              <Td align="right" className="font-semibold">
                {fmtPct(m.field_accuracy)}
              </Td>
              <Td align="right">{fmtPct(m.id_field_accuracy)}</Td>
              <Td align="right" className={silentTone(m.silent_wrong_rate)}>
                {fmtPct(m.silent_wrong_rate)}
              </Td>
              <Td align="right">{fmtPct(m.review_rate)}</Td>
              <Td align="right">{fmtPct(m.safe_outcome_rate)}</Td>
              <Td align="right" title={m.wer_normalized !== null ? `normalised: ${fmtPct(m.wer_normalized)}` : undefined}>
                {fmtPct(m.wer)}
                {m.wer_normalized !== null ? <span className="block text-[0.7rem] text-muted">norm {fmtPct(m.wer_normalized)}</span> : null}
              </Td>
              <Td align="right">{fmtMs(m.latency_total.p50)}</Td>
              <Td align="right" className={cn('font-semibold')}>
                {fmtMs(m.latency_total.p95)}
              </Td>
              <Td align="right" className="whitespace-nowrap text-xs">
                {pair(m.latency_stt)}
              </Td>
              <Td align="right" className="whitespace-nowrap text-xs">
                {pair(m.latency_extract)}
              </Td>
              <Td align="right" className="whitespace-nowrap text-xs">
                {pair(m.latency_llm)}
              </Td>
              <Td align="right" className="whitespace-nowrap text-xs">
                {m.llm_prompt_tokens_mean === null ? '-' : `${fmtNum(m.llm_prompt_tokens_mean)} / ${fmtNum(m.llm_output_tokens_mean)}`}
              </Td>
              <Td align="right">{fmtMb(m.peak_rss_mb)}</Td>
              <Td align="right">{fmtMb(m.model_size_mb)}</Td>
              <Td align="right" className="whitespace-nowrap text-xs">
                {m.n_cases}
                {m.n_errors > 0 ? <span className="text-red-700"> ({m.n_errors} err)</span> : null}
              </Td>
            </Tr>
          );
        })}
      </tbody>
    </Table>
  );
}

export const MetricsTable = memo(MetricsTableImpl);
