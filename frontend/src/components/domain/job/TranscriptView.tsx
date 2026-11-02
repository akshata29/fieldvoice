import { useMemo } from 'react';
import type { FieldSpec } from '@/api/types';
import { cn } from '@/lib/cn';
import { buildSegments, type EvidenceSpan } from '@/lib/evidence';

export interface TranscriptViewProps {
  /** Live interim text (replaced by each partial). */
  partial: string;
  /** Final text from the speech engine (raw, before number normalisation). */
  raw: string;
  /** Normalised transcript the Evidence offsets index into. Empty until the result arrives. */
  normalized: string;
  spans: EvidenceSpan[];
  focusKey: string | null;
  fields: FieldSpec[];
  live: boolean;
  showRaw: boolean;
  placeholder: string;
}

/** Live + final transcript with evidence highlighting. The container is an aria-live region so results are announced. */
export function TranscriptView({ partial, raw, normalized, spans, focusKey, fields, live, showRaw, placeholder }: TranscriptViewProps) {
  const labels = useMemo(() => Object.fromEntries(fields.map((f) => [f.key, f.label])), [fields]);
  const segments = useMemo(() => buildSegments(normalized, spans, focusKey), [normalized, spans, focusKey]);

  let body: React.ReactNode;
  if (live && partial) {
    body = (
      <span className="caret text-ink">{partial}</span>
    );
  } else if (normalized && !showRaw) {
    body = (
      <span>
        {segments.map((s, i) =>
          s.keys.length > 0 ? (
            <mark
              key={i}
              title={`Evidence for: ${s.keys.map((k) => labels[k] ?? k).join(', ')}`}
              className={cn(
                'rounded px-0.5 text-ink transition-colors',
                s.focused ? 'bg-yellow-300 ring-2 ring-yellow-500 field:bg-yellow-300 field:ring-black' : 'bg-amber-100 underline decoration-amber-400 decoration-2 underline-offset-4',
              )}
            >
              {s.text}
            </mark>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </span>
    );
  } else if (raw) {
    body = <span className="text-ink">{raw}</span>;
  } else {
    body = <span className="text-muted">{placeholder}</span>;
  }

  return (
    <div
      className="min-h-[6rem] rounded-xl border border-line bg-surface-2 px-4 py-3 text-lg leading-8 field:border-2 field:border-black"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Transcript"
    >
      {body}
    </div>
  );
}
