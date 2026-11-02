import { CheckCircleIcon, MinusCircleIcon, XCircleIcon } from '@heroicons/react/24/solid';
import type { FieldSpec, FormSchema, Scalar } from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import type { FieldDiffRow } from '@/lib/fieldDiff';
import { formatFieldValue } from '@/lib/formLogic';
import { titleCase } from '@/lib/format';
import { FieldStatusBadge } from '@/components/domain/StatusBadges';

function show(spec: FieldSpec | undefined, v: Scalar | undefined): string {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (spec) return formatFieldValue(spec, v);
  return typeof v === 'string' && /^[a-z]+(_[a-z]+)+$/.test(v) ? titleCase(v) : String(v);
}

const ROW_TONE = {
  correct: 'bg-emerald-50/70 field:bg-white',
  wrong: 'bg-red-50/80 field:bg-white',
  unknown: 'bg-slate-50 field:bg-white',
} as const;

/** Expected vs extracted values per field: green = correct, red = wrong, grey = no ground truth. */
export function FieldsDiffTable({ rows, form, hideExpected }: { rows: FieldDiffRow[]; form?: FormSchema | null; hideExpected?: boolean }) {
  return (
    <div className="scroll-thin relative overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="px-2 py-1.5 font-semibold">
              Field
            </th>
            {hideExpected ? null : (
              <th scope="col" className="px-2 py-1.5 font-semibold">
                Expected
              </th>
            )}
            <th scope="col" className="px-2 py-1.5 font-semibold">
              Extracted
            </th>
            <th scope="col" className="px-2 py-1.5 font-semibold">
              Result
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const spec = form?.fields.find((f) => f.key === r.key);
            return (
              <tr key={r.key} className={cn('border-t border-white', ROW_TONE[r.verdict])}>
                <td className="px-2 py-2 align-top font-medium text-ink">{spec?.label ?? titleCase(r.key)}</td>
                {hideExpected ? null : <td className="px-2 py-2 align-top font-mono text-xs text-ink">{r.hasExpected ? show(spec, r.expected) : <span className="text-muted">-</span>}</td>}
                <td className="px-2 py-2 align-top">
                  <div className="font-mono text-xs text-ink">{show(spec, r.actual)}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <FieldStatusBadge status={r.status} />
                    {r.actual !== null ? <span className="text-xs tabular-nums text-muted">{Math.round(r.confidence * 100)}%</span> : null}
                  </div>
                </td>
                <td className="px-2 py-2 align-top">
                  {r.verdict === 'correct' ? (
                    <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
                      <CheckCircleIcon className="h-5 w-5" aria-hidden="true" /> Correct
                    </span>
                  ) : r.verdict === 'wrong' ? (
                    <span className="space-y-1">
                      <span className="inline-flex items-center gap-1 font-semibold text-red-700">
                        <XCircleIcon className="h-5 w-5" aria-hidden="true" /> Wrong
                      </span>
                      <span className="block">
                        {r.silentWrong ? (
                          <Badge tone="red" size="sm">
                            silent: shown as confident
                          </Badge>
                        ) : r.flagged ? (
                          <Badge tone="amber" size="sm">
                            flagged for review
                          </Badge>
                        ) : null}
                      </span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-muted">
                      <MinusCircleIcon className="h-5 w-5" aria-hidden="true" /> No ground truth
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
