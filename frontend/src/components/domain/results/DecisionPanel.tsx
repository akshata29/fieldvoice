import { useMemo } from 'react';
import { CheckCircleIcon, TrophyIcon, XCircleIcon } from '@heroicons/react/24/solid';
import type { ConfigMetrics, DecisionGates, DecisionReport, EngineInfo } from '@/api/types';
import { ErrorState, Spinner } from '@/components/ui/Feedback';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/Controls';
import { Table, Td, Th, Tr } from '@/components/ui/Table';
import { ConfigChips } from '@/components/domain/ConfigChips';
import { DemoTag } from '@/components/domain/DemoTag';
import { DEFAULT_GATES, explainGate } from '@/lib/gates';
import { fmtPct } from '@/lib/format';

const pct = (fraction: number): string => String(Math.round(fraction * 1000) / 10);
const fromPct = (text: string, fallback: number): number => {
  const n = Number(text);
  return Number.isFinite(n) && text.trim() !== '' ? Math.max(0, Math.min(1, n / 100)) : fallback;
};

export function DecisionPanel({
  gates,
  onGatesChange,
  report,
  loading,
  error,
  onRetry,
  configs,
  engines,
  selectedKey,
  onSelect,
}: {
  gates: DecisionGates;
  onGatesChange: (g: DecisionGates) => void;
  report: DecisionReport | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  configs: ConfigMetrics[];
  engines?: EngineInfo[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const byKey = useMemo(() => new Map(configs.map((m) => [m.config_key, m])), [configs]);
  const rows = useMemo(() => {
    const list = [...(report?.rows ?? [])];
    return list.sort((a, b) => Number(b.passes) - Number(a.passes) || (a.rank ?? 999) - (b.rank ?? 999) || b.score - a.score);
  }, [report]);
  const best = rows.find((r) => r.passes && r.rank === 1) ?? rows.find((r) => r.passes);
  const passing = rows.filter((r) => r.passes).length;

  return (
    <Card>
      <CardHeader
        title="Decision gates"
        subtitle="Set the bar a configuration must clear. The list below updates as you type."
        icon={<TrophyIcon className="h-6 w-6" aria-hidden="true" />}
        actions={
          <>
            {loading ? <Spinner className="h-5 w-5 text-muted" label="Updating decision" /> : null}
            <Button size="sm" onClick={() => onGatesChange(DEFAULT_GATES)}>
              Reset gates
            </Button>
          </>
        }
      />
      <CardBody className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Max p95 latency" hint="End of speech to proposed fields (ms)">
            {(p) => <Input {...p} type="number" inputMode="numeric" min={0} step={100} value={gates.max_p95_ms} onChange={(e) => onGatesChange({ ...gates, max_p95_ms: Math.max(0, Number(e.target.value) || 0) })} />}
          </Field>
          <Field label="Min ID-field accuracy (%)" hint="Entity ids must be right">
            {(p) => <Input {...p} type="number" inputMode="decimal" min={0} max={100} step={0.5} value={pct(gates.min_id_field_accuracy)} onChange={(e) => onGatesChange({ ...gates, min_id_field_accuracy: fromPct(e.target.value, gates.min_id_field_accuracy) })} />}
          </Field>
          <Field label="Max silent-wrong (%)" hint="Confident and wrong">
            {(p) => <Input {...p} type="number" inputMode="decimal" min={0} max={100} step={0.5} value={pct(gates.max_silent_wrong)} onChange={(e) => onGatesChange({ ...gates, max_silent_wrong: fromPct(e.target.value, gates.max_silent_wrong) })} />}
          </Field>
          <Field label="Max peak RAM (MB)" hint="Empty = no limit">
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="numeric"
                min={0}
                step={128}
                placeholder="no limit"
                value={gates.max_peak_rss_mb ?? ''}
                onChange={(e) => onGatesChange({ ...gates, max_peak_rss_mb: e.target.value.trim() === '' ? null : Math.max(0, Number(e.target.value) || 0) })}
              />
            )}
          </Field>
          <Field label="Min field accuracy (%)" hint="0 = not applied">
            {(p) => <Input {...p} type="number" inputMode="decimal" min={0} max={100} step={0.5} value={pct(gates.min_field_accuracy)} onChange={(e) => onGatesChange({ ...gates, min_field_accuracy: fromPct(e.target.value, gates.min_field_accuracy) })} />}
          </Field>
        </div>

        {error ? <ErrorState error={error} onRetry={onRetry} title="Could not evaluate the gates" /> : null}

        {report ? (
          <>
            <div className="rounded-xl border-2 border-dashed border-line p-4" aria-live="polite">
              {best ? (
                <div className="flex flex-wrap items-center gap-3">
                  <TrophyIcon className="h-8 w-8 shrink-0 text-amber-500" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">
                      Best configuration that clears every gate <span className="font-normal text-muted">({passing} of {rows.length} pass)</span>
                    </p>
                    {byKey.get(best.config_key) ? <ConfigChips config={byKey.get(best.config_key)!.config} engines={engines} size="md" /> : null}
                  </div>
                </div>
              ) : (
                <p className="text-sm font-semibold text-red-700">No configuration clears every gate. Loosen a gate or run more configurations.</p>
              )}
            </div>

            <Table aria-label="Decision per configuration">
              <thead>
                <tr>
                  <Th>Configuration</Th>
                  <Th>Verdict</Th>
                  <Th>Why not</Th>
                  <Th align="right">Score</Th>
                  <Th align="right">Rank</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const m = byKey.get(r.config_key);
                  return (
                    <Tr key={r.config_key} selected={r.config_key === selectedKey} onClick={() => onSelect(r.config_key)}>
                      <Td className="min-w-[14rem]">{m ? <ConfigChips config={m.config} engines={engines} /> : r.config_key}</Td>
                      <Td>
                        {r.passes ? (
                          <Badge tone="green" icon={CheckCircleIcon}>
                            Pass
                          </Badge>
                        ) : (
                          <Badge tone="red" icon={XCircleIcon}>
                            Fail
                          </Badge>
                        )}
                      </Td>
                      <Td className="text-xs text-red-800">
                        {r.failed_gates.length === 0 ? <span className="text-muted">-</span> : <ul className="list-disc pl-4">{r.failed_gates.map((g) => <li key={g}>{explainGate(g, m, report.gates)}</li>)}</ul>}
                      </Td>
                      <Td align="right" className="text-muted">
                        {r.passes ? r.score.toFixed(3) : '-'}
                      </Td>
                      <Td align="right" className="font-bold">
                        {r.rank ?? '-'}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
            <p className="flex items-center gap-2 text-xs text-muted">
              Score rewards accuracy, penalises silent errors and slowness; it only ranks configurations that pass. Gates: p95 &le; {report.gates.max_p95_ms} ms, ID accuracy &ge; {fmtPct(report.gates.min_id_field_accuracy)}, silent-wrong &le; {fmtPct(report.gates.max_silent_wrong)}.
              <DemoTag />
            </p>
          </>
        ) : loading ? (
          <p className="text-sm text-muted">Evaluating gates...</p>
        ) : null}
      </CardBody>
    </Card>
  );
}
