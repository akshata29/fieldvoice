/** Evidence highlighting: map the `Evidence` spans of extracted fields onto `transcript_normalized`. */
import type { Evidence, FieldValue } from '@/api/types';

export interface EvidenceSpan {
  key: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  text: string;
  /** Field keys whose evidence covers this segment. */
  keys: string[];
  /** True when the focused field's evidence covers this segment. */
  focused: boolean;
}

/**
 * The server promises `transcript.slice(start, end) === evidence.text`; when that does not hold (stale offsets after the
 * transcript changed, or the evidence came from an earlier utterance) fall back to the first literal occurrence.
 */
export function locateEvidence(transcript: string, evidence: Evidence): { start: number; end: number } | null {
  const { start, end, text } = evidence;
  if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= transcript.length) {
    if (transcript.slice(start, end) === text) return { start, end };
  }
  if (!text) return null;
  const idx = transcript.toLowerCase().indexOf(text.toLowerCase());
  return idx >= 0 ? { start: idx, end: idx + text.length } : null;
}

export function spansFromFields(transcript: string, fields: Record<string, FieldValue>, keys?: Iterable<string>): EvidenceSpan[] {
  const allowed = keys ? new Set(keys) : null;
  const spans: EvidenceSpan[] = [];
  for (const [key, fv] of Object.entries(fields)) {
    if (allowed && !allowed.has(key)) continue;
    if (!fv.evidence) continue;
    const located = locateEvidence(transcript, fv.evidence);
    if (located) spans.push({ key, ...located });
  }
  return spans;
}

/** Splits the transcript at every span boundary so overlapping evidence renders correctly. */
export function buildSegments(transcript: string, spans: EvidenceSpan[], focusKey?: string | null): TranscriptSegment[] {
  if (!transcript) return [];
  const valid = spans.filter((s) => s.start >= 0 && s.end > s.start && s.start < transcript.length);
  const cuts = new Set<number>([0, transcript.length]);
  for (const s of valid) {
    cuts.add(Math.max(0, s.start));
    cuts.add(Math.min(transcript.length, s.end));
  }
  const points = Array.from(cuts).sort((a, b) => a - b);
  const segments: TranscriptSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i] as number;
    const to = points[i + 1] as number;
    if (to <= from) continue;
    const covering = valid.filter((s) => s.start <= from && s.end >= to);
    segments.push({
      text: transcript.slice(from, to),
      keys: covering.map((s) => s.key),
      focused: focusKey != null && covering.some((s) => s.key === focusKey),
    });
  }
  return segments;
}
