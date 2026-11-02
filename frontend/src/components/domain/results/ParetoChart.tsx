import { useMemo } from 'react';
import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import type { ConfigMetrics, DecisionGates, DecisionReport, EngineInfo } from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { configText } from '@/lib/engineLabels';
import { explainGate } from '@/lib/gates';
import { fmtMs, fmtPct } from '@/lib/format';

interface Point {
  key: string;
  x: number;
  y: number;
  silent: number;
  pass: boolean | null;
  pareto: boolean;
  rank: number | null;
  failed: string[];
  label: string;
}

const COLORS = { pass: '#16a34a', fail: '#dc2626', unknown: '#64748b', outline: '#0f172a' };

interface ShapeProps {
  cx?: number;
  cy?: number;
  payload?: Point;
}

function PointShape({ cx, cy, payload, selectedKey, onSelect }: ShapeProps & { selectedKey: string | null; onSelect: (key: string) => void }) {
  if (cx === undefined || cy === undefined || !payload) return <g />;
  const fill = payload.pass === null ? COLORS.unknown : payload.pass ? COLORS.pass : COLORS.fail;
  const selected = payload.key === selectedKey;
  return (
    <g onClick={() => onSelect(payload.key)} style={{ cursor: 'pointer' }}>
      {selected ? <circle cx={cx} cy={cy} r={17} fill="none" stroke="#1f7ac4" strokeWidth={3} strokeDasharray="4 3" /> : null}
      <circle cx={cx} cy={cy} r={payload.pareto ? 10 : 8} fill={fill} fillOpacity={0.9} stroke={payload.pareto ? COLORS.outline : '#ffffff'} strokeWidth={payload.pareto ? 3.5 : 1.5} />
    </g>
  );
}

function PointTooltip({ active, payload, metrics, gates }: { active?: boolean; payload?: Array<{ payload?: Point }>; metrics: Map<string, ConfigMetrics>; gates: DecisionGates | undefined }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  const m = metrics.get(p.key);
  return (
    <div className="max-w-xs rounded-xl border border-line bg-surface p-3 text-sm shadow-pop">
      <p className="font-semibold text-ink">{p.label}</p>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted">p95 total</dt>
        <dd className="text-right font-medium tabular-nums">{fmtMs(p.x)}</dd>
        <dt className="text-muted">Field accuracy</dt>
        <dd className="text-right font-medium tabular-nums">{fmtPct(p.y)}</dd>
        <dt className="text-muted">Silent-wrong</dt>
        <dd className="text-right font-medium tabular-nums">{fmtPct(p.silent)}</dd>
        {m ? (
          <>
            <dt className="text-muted">ID accuracy</dt>
            <dd className="text-right font-medium tabular-nums">{fmtPct(m.id_field_accuracy)}</dd>
          </>
        ) : null}
      </dl>
      <div className="mt-2 flex flex-wrap gap-1">
        {p.pass === null ? null : p.pass ? <Badge tone="green" size="sm">passes gates{p.rank ? ` - rank ${p.rank}` : ''}</Badge> : <Badge tone="red" size="sm">fails gates</Badge>}
        {p.pareto ? <Badge tone="violet" size="sm">Pareto-optimal</Badge> : null}
      </div>
      {p.failed.length > 0 && gates ? (
        <ul className="mt-1.5 list-disc pl-4 text-xs text-red-700">
          {p.failed.map((g) => (
            <li key={g}>{explainGate(g, m, gates)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** x = p95 total latency, y = field accuracy. Colour = passes the gates, thick outline = Pareto-optimal. */
export function ParetoChart({
  configs,
  report,
  gates,
  selectedKey,
  onSelect,
  engines,
}: {
  configs: ConfigMetrics[];
  report: DecisionReport | undefined;
  gates: DecisionGates | undefined;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  engines?: EngineInfo[];
}) {
  const metrics = useMemo(() => new Map(configs.map((m) => [m.config_key, m])), [configs]);
  const points = useMemo<Point[]>(() => {
    const rows = new Map((report?.rows ?? []).map((r) => [r.config_key, r]));
    const pareto = new Map((report?.pareto ?? []).map((p) => [p.config_key, p]));
    return configs
      .filter((m) => m.latency_total.p95 !== null)
      .map((m) => {
        const row = rows.get(m.config_key);
        return {
          key: m.config_key,
          x: m.latency_total.p95 as number,
          y: m.field_accuracy,
          silent: m.silent_wrong_rate,
          pass: row ? row.passes : null,
          pareto: pareto.get(m.config_key)?.pareto_optimal ?? false,
          rank: row?.rank ?? null,
          failed: row?.failed_gates ?? [],
          label: configText(m.config, engines),
        };
      });
  }, [configs, report, engines]);

  const missing = configs.length - points.length;
  const yMin = Math.max(0, Math.floor((Math.min(...points.map((p) => p.y), 1) - 0.04) * 20) / 20);

  return (
    <div>
      <div className="h-[26rem] w-full" role="img" aria-label="Scatter plot of field accuracy against p95 latency for every configuration">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 16, right: 28, bottom: 34, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis type="number" dataKey="x" name="p95 total latency" domain={[0, 'auto']} tickFormatter={(v: number) => fmtMs(v)} label={{ value: 'p95 end-of-speech to proposed fields', position: 'insideBottom', offset: -18, fill: '#475569', fontSize: 12 }} tick={{ fontSize: 12 }} />
            <YAxis type="number" dataKey="y" name="Field accuracy" domain={[yMin, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} width={52} tick={{ fontSize: 12 }} label={{ value: 'Field accuracy', angle: -90, position: 'insideLeft', fill: '#475569', fontSize: 12 }} />
            <ZAxis range={[100, 100]} />
            {gates ? <ReferenceLine x={gates.max_p95_ms} stroke={COLORS.fail} strokeDasharray="5 4" label={{ value: `max p95 ${fmtMs(gates.max_p95_ms)}`, position: 'insideTopRight', fill: COLORS.fail, fontSize: 11 }} /> : null}
            {gates && gates.min_field_accuracy > 0 ? <ReferenceLine y={gates.min_field_accuracy} stroke={COLORS.fail} strokeDasharray="5 4" /> : null}
            <Tooltip cursor={{ strokeDasharray: '3 3' }} content={(p) => <PointTooltip active={p.active} payload={p.payload as unknown as Array<{ payload?: Point }> | undefined} metrics={metrics} gates={gates} />} />
            <Scatter data={points} shape={(p: unknown) => <PointShape {...(p as ShapeProps)} selectedKey={selectedKey} onSelect={onSelect} />} isAnimationActive={false} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted" aria-label="Chart legend">
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full" style={{ background: COLORS.pass }} /> passes all gates
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full" style={{ background: COLORS.fail }} /> fails a gate
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-3.5 w-3.5 rounded-full border-[3px]" style={{ borderColor: COLORS.outline, background: '#e2e8f0' }} /> Pareto-optimal (nothing is both faster and more accurate)
        </li>
        {missing > 0 ? <li>{missing} configuration{missing === 1 ? '' : 's'} without latency data are not plotted</li> : null}
      </ul>
    </div>
  );
}
