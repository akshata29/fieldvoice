import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MagnifyingGlassCircleIcon } from '@heroicons/react/24/outline';
import type { CaseResult, ConfigMetrics, EngineInfo } from '@/api/types';
import { evalApi } from '@/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Checkbox, Select } from '@/components/ui/Controls';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/Feedback';
import { FieldsDiffTable } from '@/components/domain/FieldsDiffTable';
import { TimingWaterfall } from '@/components/domain/TimingWaterfall';
import { qk } from '@/hooks/queries';
import { configText } from '@/lib/engineLabels';
import { diffFields, summarizeDiff } from '@/lib/fieldDiff';
import { fmtPct } from '@/lib/format';

const PAGE = 10;

function CaseCard({ c, threshold }: { c: CaseResult; threshold: number }) {
  const ex = c.extraction;
  const rows = useMemo(() => (ex ? diffFields(c.expected, ex.fields, { fieldCorrect: c.field_correct, confidenceThreshold: threshold, keys: Object.keys(c.expected) }) : []), [c, ex, threshold]);
  const s = summarizeDiff(rows);
  const graded = s.correct + s.wrong;
  return (
    <details className="group rounded-xl border border-line bg-surface field:border-2" open={s.silentWrong > 0}>
      <summary className="flex min-h-tap cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 marker:hidden [&::-webkit-details-marker]:hidden">
        <span className="font-mono text-sm font-semibold text-ink">{c.case_id}</span>
        <Badge tone={s.wrong === 0 ? 'green' : 'red'} size="sm">
          {s.correct}/{graded} correct
        </Badge>
        {s.silentWrong > 0 ? (
          <Badge tone="red" size="sm">
            {s.silentWrong} silent-wrong
          </Badge>
        ) : null}
        {c.wer !== null ? (
          <Badge tone="gray" size="sm">
            WER {fmtPct(c.wer, 0)}
          </Badge>
        ) : null}
        {c.tags.slice(0, 4).map((t) => (
          <Badge key={t} tone="gray" size="sm">
            {t}
          </Badge>
        ))}
        {!c.ok ? <Badge tone="red" size="sm">error</Badge> : null}
      </summary>
      <div className="space-y-3 border-t border-line/70 px-4 py-3">
        {c.error ? <p className="text-sm font-medium text-red-700">{c.error}</p> : null}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Transcript heard</p>
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink field:border-2 field:border-black">{c.transcript_hyp || '(empty)'}</p>
        </div>
        <FieldsDiffTable rows={rows} />
        {ex ? <TimingWaterfall compact timings={ex.timings} totalMs={ex.total_ms} audioMs={ex.audio_ms} promptTokens={ex.llm_prompt_tokens} outputTokens={ex.llm_output_tokens} /> : null}
      </div>
    </details>
  );
}

export function CaseDrilldown({
  runId,
  configs,
  selectedKey,
  onSelect,
  threshold,
  engines,
}: {
  runId: string;
  configs: ConfigMetrics[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  threshold: number;
  engines?: EngineInfo[];
}) {
  const [onlyFailures, setOnlyFailures] = useState(true);
  const [offset, setOffset] = useState(0);
  const key = selectedKey ?? configs[0]?.config_key ?? null;
  useEffect(() => setOffset(0), [key, onlyFailures]);

  const q = useQuery({
    queryKey: qk.runCases(runId, key, onlyFailures, offset),
    queryFn: () => evalApi.runCases(runId, { config_key: key ?? undefined, only_failures: onlyFailures, offset, limit: PAGE }),
    enabled: !!key,
    placeholderData: (prev) => prev,
  });
  const list = q.data ?? [];

  return (
    <Card>
      <CardHeader
        title="Case drill-down"
        subtitle="What this configuration heard and extracted for each case, against the ground truth."
        icon={<MagnifyingGlassCircleIcon className="h-6 w-6" aria-hidden="true" />}
      />
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select aria-label="Configuration to inspect" value={key ?? ''} onChange={(e) => onSelect(e.target.value)} className="!w-auto min-w-[18rem] max-w-full">
            {configs.map((m) => (
              <option key={m.config_key} value={m.config_key}>
                {configText(m.config, engines)}
              </option>
            ))}
          </Select>
          <Checkbox checked={onlyFailures} onChange={setOnlyFailures} label="Only cases with a wrong field" />
        </div>
        {q.isLoading ? <LoadingBlock /> : null}
        {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
        {!q.isLoading && !q.isError && list.length === 0 ? <EmptyState title={onlyFailures ? 'No failing cases for this configuration' : 'No cases'} /> : null}
        <div className="space-y-2">
          {list.map((c) => (
            <CaseCard key={`${c.config_key}-${c.case_id}`} c={c} threshold={threshold} />
          ))}
        </div>
        {list.length > 0 || offset > 0 ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted">
              Cases {offset + 1}-{offset + list.length}
            </span>
            <div className="flex gap-2">
              <Button size="sm" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>
                Previous
              </Button>
              <Button size="sm" disabled={list.length < PAGE} onClick={() => setOffset((o) => o + PAGE)}>
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
