import { cn } from '@/lib/cn';
import type { StageTiming } from '@/api/types';
import { buildWaterfall, stageBg, stageLabel } from '@/lib/waterfall';
import { fmtMs, fmtNum } from '@/lib/format';
import { DemoTag } from './DemoTag';

export interface TimingWaterfallProps {
  timings: StageTiming[];
  totalMs?: number | null;
  audioMs?: number | null;
  promptTokens?: number | null;
  outputTokens?: number | null;
  /** Compact = just the stacked bar and a one-line legend (for side-by-side cards). */
  compact?: boolean;
  className?: string;
  showDemoTag?: boolean;
}

function detailText(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof detail.prompt_tokens === 'number') parts.push(`${detail.prompt_tokens} prompt tok`);
  if (typeof detail.output_tokens === 'number') parts.push(`${detail.output_tokens} out tok`);
  if (typeof detail.resolved === 'number') parts.push(`${detail.resolved} resolved`);
  if (typeof detail.unresolved === 'number') parts.push(`${detail.unresolved} left`);
  if (detail.streaming === true) parts.push('streaming');
  return parts.join(' · ');
}

export function TimingWaterfall({ timings, totalMs, audioMs, promptTokens, outputTokens, compact, className, showDemoTag = true }: TimingWaterfallProps) {
  const w = buildWaterfall(timings, totalMs);
  if (w.segments.length === 0) {
    return <p className={cn('text-sm text-muted', className)}>No timing data.</p>;
  }
  const tokens = promptTokens != null || outputTokens != null;
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-semibold text-ink">
          Total <span className="tabular-nums">{fmtMs(w.totalMs)}</span>
        </span>
        <span className="flex items-center gap-2 text-xs text-muted">
          {audioMs ? <span>audio {fmtMs(audioMs)}</span> : null}
          {tokens ? (
            <span className="tabular-nums">
              {fmtNum(promptTokens ?? 0)} prompt / {fmtNum(outputTokens ?? 0)} output tokens
            </span>
          ) : null}
          {showDemoTag ? <DemoTag /> : null}
        </span>
      </div>

      <div
        className="flex h-6 w-full overflow-hidden rounded-md bg-slate-100 ring-1 ring-inset ring-slate-200 field:ring-2 field:ring-black"
        role="img"
        aria-label={`Timing: ${w.segments.map((s) => `${stageLabel(s.stage)} ${fmtMs(s.ms)}`).join(', ')}, total ${fmtMs(w.totalMs)}`}
      >
        {w.segments.map((s, i) => (
          <div
            key={`${s.stage}-${i}`}
            className={cn('h-full border-r border-white/70 last:border-r-0', stageBg(s.stage))}
            style={{ width: `${Math.max(s.widthPct, s.ms > 0 ? 0.6 : 0)}%` }}
            title={`${stageLabel(s.stage)}: ${fmtMs(s.ms)}`}
          />
        ))}
        {w.otherMs > 0 ? <div className="stripes h-full" style={{ width: `${w.otherPct}%` }} title={`Other: ${fmtMs(w.otherMs)}`} /> : null}
      </div>

      {compact ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          {w.segments.map((s, i) => (
            <li key={`${s.stage}-${i}`} className="flex items-center gap-1.5">
              <span className={cn('h-2.5 w-2.5 rounded-sm', stageBg(s.stage))} aria-hidden="true" />
              {stageLabel(s.stage)} <span className="tabular-nums font-medium text-ink">{fmtMs(s.ms)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <ol className="space-y-1.5" aria-label="Stage timings">
          {w.segments.map((s, i) => (
            <li key={`${s.stage}-${i}`} className="grid grid-cols-[7.5rem_1fr_4.5rem] items-center gap-2 text-sm sm:grid-cols-[9rem_1fr_5rem]">
              <span className="flex items-center gap-2 truncate text-ink">
                <span className={cn('h-2.5 w-2.5 shrink-0 rounded-sm', stageBg(s.stage))} aria-hidden="true" />
                {stageLabel(s.stage)}
              </span>
              <span className="relative h-3 overflow-hidden rounded bg-slate-100">
                <span
                  className={cn('absolute inset-y-0 rounded', stageBg(s.stage))}
                  style={{ left: `${s.startPct}%`, width: `${Math.max(s.widthPct, s.ms > 0 ? 0.8 : 0)}%` }}
                />
              </span>
              <span className="text-right tabular-nums font-medium text-ink" title={detailText(s.detail) || undefined}>
                {fmtMs(s.ms)}
              </span>
            </li>
          ))}
          {w.otherMs > 0 ? (
            <li className="grid grid-cols-[7.5rem_1fr_4.5rem] items-center gap-2 text-sm text-muted sm:grid-cols-[9rem_1fr_5rem]">
              <span className="flex items-center gap-2">
                <span className="stripes h-2.5 w-2.5 shrink-0 rounded-sm" aria-hidden="true" />
                Other / overhead
              </span>
              <span />
              <span className="text-right tabular-nums">{fmtMs(w.otherMs)}</span>
            </li>
          ) : null}
        </ol>
      )}
    </div>
  );
}
