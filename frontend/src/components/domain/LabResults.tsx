import { useMemo } from 'react';
import type { EngineInfo, ExtractionResult, FormSchema, LabCompareItem, Scalar } from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { Alert } from '@/components/ui/Feedback';
import { cn } from '@/lib/cn';
import { diffFields, summarizeDiff } from '@/lib/fieldDiff';
import { fmtMs } from '@/lib/format';
import { ConfigChips } from './ConfigChips';
import { FieldsDiffTable } from './FieldsDiffTable';
import { TimingWaterfall } from './TimingWaterfall';

export type LabSort = 'accuracy' | 'latency' | 'silent';

export interface LabCardData {
  item: LabCompareItem;
  accuracy: number | null;
  silentWrong: number;
  totalMs: number | null;
}

/** Scores every item once so the grid can sort without recomputing. */
export function scoreItems(items: LabCompareItem[], expected: Record<string, Scalar> | null): LabCardData[] {
  return items.map((item) => {
    const ex = extractionOf(item);
    if (!ex) return { item, accuracy: null, silentWrong: 0, totalMs: null };
    const rows = diffFields(expected, ex.fields, { fieldCorrect: item.field_correct });
    const s = summarizeDiff(rows);
    const graded = s.correct + s.wrong;
    return { item, accuracy: graded > 0 ? s.correct / graded : null, silentWrong: s.silentWrong, totalMs: ex.total_ms };
  });
}

const extractionOf = (item: LabCompareItem): ExtractionResult | null => item.extraction;

export function sortCards(cards: LabCardData[], by: LabSort): LabCardData[] {
  const num = (v: number | null, fallback: number) => (v === null ? fallback : v);
  return [...cards].sort((a, b) => {
    if (by === 'latency') return num(a.totalMs, Infinity) - num(b.totalMs, Infinity);
    if (by === 'silent') return a.silentWrong - b.silentWrong || num(b.accuracy, -1) - num(a.accuracy, -1);
    return num(b.accuracy, -1) - num(a.accuracy, -1) || a.silentWrong - b.silentWrong || num(a.totalMs, Infinity) - num(b.totalMs, Infinity);
  });
}

function ResultCard({ data, expected, form, engines, rank }: { data: LabCardData; expected: Record<string, Scalar> | null; form: FormSchema | null; engines: EngineInfo[]; rank: number }) {
  const { item } = data;
  const ex = item.extraction;
  const rows = useMemo(
    () => (ex ? diffFields(expected, ex.fields, { fieldCorrect: item.field_correct, keys: form?.fields.map((f) => f.key) }) : []),
    [ex, expected, item.field_correct, form],
  );
  const s = useMemo(() => summarizeDiff(rows), [rows]);
  const graded = s.correct + s.wrong;
  const perfect = graded > 0 && s.wrong === 0;

  return (
    <article className={cn('flex min-w-0 flex-col gap-3 rounded-xl border bg-surface p-4 shadow-card field:border-2 field:shadow-none', s.silentWrong > 0 ? 'border-red-300 field:border-black' : perfect ? 'border-emerald-300 field:border-black' : 'border-line')} aria-label={`Result ${rank}`}>
      <header className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <ConfigChips config={item.config} engines={engines} />
          <span className="shrink-0 text-xs font-semibold text-muted">#{rank}</span>
        </div>
        {ex ? (
          <p className="flex flex-wrap gap-1.5" aria-label="Summary">
            {graded > 0 ? (
              <Badge tone={perfect ? 'green' : s.correct / graded >= 0.7 ? 'amber' : 'red'}>
                {s.correct}/{graded} correct
              </Badge>
            ) : (
              <Badge tone="gray">no ground truth</Badge>
            )}
            <Badge tone={s.silentWrong > 0 ? 'red' : 'green'}>{s.silentWrong} silent-wrong</Badge>
            {s.flagged > 0 ? <Badge tone="amber">{s.flagged} flagged</Badge> : null}
            <Badge tone="blue">{fmtMs(ex.total_ms)} total</Badge>
          </p>
        ) : null}
      </header>

      {item.error ? (
        <Alert tone="error" title="This combination could not run">
          {item.error}
        </Alert>
      ) : null}

      {ex ? (
        <>
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Transcript</p>
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm leading-6 text-ink field:border-2 field:border-black">{ex.transcript_raw || '(empty)'}</p>
            {ex.transcript_normalized && ex.transcript_normalized !== ex.transcript_raw ? (
              <p className="text-xs text-muted">
                Normalised: <span className="text-ink">{ex.transcript_normalized}</span>
              </p>
            ) : null}
          </div>
          <TimingWaterfall compact timings={ex.timings} totalMs={ex.total_ms} audioMs={ex.audio_ms} promptTokens={ex.llm_prompt_tokens} outputTokens={ex.llm_output_tokens} />
          <FieldsDiffTable rows={rows} form={form} hideExpected={!expected} />
          {ex.warnings.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-800">
              {ex.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
          {ex.error ? <Alert tone="error">{ex.error}</Alert> : null}
        </>
      ) : null}
    </article>
  );
}

export function LabResultGrid({ cards, expected, form, engines, sort }: { cards: LabCardData[]; expected: Record<string, Scalar> | null; form: FormSchema | null; engines: EngineInfo[]; sort: LabSort }) {
  const sorted = useMemo(() => sortCards(cards, sort), [cards, sort]);
  return (
    <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3" aria-live="polite">
      {sorted.map((c, i) => (
        <ResultCard key={`${c.item.config.stt_engine_id}|${c.item.config.llm_engine_id}|${c.item.config.strategy_id}`} data={c} expected={expected} form={form} engines={engines} rank={i + 1} />
      ))}
    </div>
  );
}
