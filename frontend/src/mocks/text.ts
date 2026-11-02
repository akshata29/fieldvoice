/**
 * Text utilities for the mock speech pipeline: number <-> words, number normalisation (the real pipeline's
 * "normalize numbers" stage in miniature) and word error rate.
 */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const DIGIT_VALUE = new Map(ONES.map((w, i) => [w, i]));
const TEEN_VALUE = new Map(TEENS.map((w, i) => [w, 10 + i]));
const TENS_VALUE = new Map(TENS.map((w, i): [string, number] => [w, i * 10]).filter(([, v]) => v >= 20));

export function digitsToWords(digits: string): string {
  return digits
    .split('')
    .map((d) => ONES[Number(d)] ?? d)
    .join(' ');
}

/** 0..999 as spoken English ("one hundred twenty three"). */
export function numberToWords(n: number): string {
  if (n < 10) return ONES[n] as string;
  if (n < 20) return TEENS[n - 10] as string;
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
  const rest = n % 100;
  return `${ONES[Math.floor(n / 100)]} hundred${rest ? ` ${numberToWords(rest)}` : ''}`;
}

/** How a 3-digit id is read aloud when speakers group digits ("one twenty three", "three hundred five"). */
export function groupedIdWords(id: string): string {
  if (!/^\d{3}$/.test(id)) return digitsToWords(id);
  const [h, t, u] = id.split('').map(Number) as [number, number, number];
  if (t === 0) return u === 0 ? `${ONES[h]} hundred` : `${ONES[h]} hundred ${ONES[u]}`;
  return `${ONES[h]} ${numberToWords(t * 10 + u)}`;
}

interface Segment {
  value: number;
  /** What this segment can still absorb: a unit digit after a tens word, or anything under 100 after "hundred". */
  open: 'units' | 'under100' | null;
}

/** Joins a run of number words: "one twenty three" -> 123, "three hundred five" -> 305, "twenty five" -> 25. */
function convertRun(words: string[]): string {
  const segments: Segment[] = [];
  for (const word of words) {
    const last = segments[segments.length - 1];
    const digit = DIGIT_VALUE.get(word);
    const teen = TEEN_VALUE.get(word);
    const tens = TENS_VALUE.get(word);
    if (digit !== undefined) {
      if (digit > 0 && last?.open) {
        last.value += digit;
        last.open = null;
      } else segments.push({ value: digit, open: null });
    } else if (teen !== undefined) {
      if (last?.open === 'under100') {
        last.value += teen;
        last.open = null;
      } else segments.push({ value: teen, open: null });
    } else if (tens !== undefined) {
      if (last?.open === 'under100') {
        last.value += tens;
        last.open = 'units';
      } else segments.push({ value: tens, open: 'units' });
    } else if (word === 'hundred') {
      if (last && last.open === null && last.value >= 1 && last.value <= 9) {
        last.value *= 100;
        last.open = 'under100';
      } else segments.push({ value: 100, open: 'under100' });
    }
  }
  return segments.map((s) => String(s.value)).join('');
}

const NUMBER_WORD =
  '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)';
const NUMBER_TOKEN = `${NUMBER_WORD}(?:-${NUMBER_WORD})*`;
const NUMBER_RUN = new RegExp(`\\b${NUMBER_TOKEN}(?:\\s+${NUMBER_TOKEN})*\\b`, 'gi');
const ONE_NEEDS_CONTEXT = /(?:pole|unit|meter|number|no\.?|#)\s*$/i;

/**
 * "pole one two three" -> "pole 123", "twenty five kva" -> "25 kva", "pole 1 2 3" -> "pole 123" (a small Whisper model
 * spaces digits out). A lone "one" ("the old one") is only a number after a word like pole/unit/meter.
 */
export function normalizeNumbers(text: string): string {
  return text
    .replace(NUMBER_RUN, (match, offset: number) => {
      const words = match.toLowerCase().split(/[\s-]+/);
      if (words.length === 1 && words[0] === 'one' && !ONE_NEEDS_CONTEXT.test(text.slice(Math.max(0, offset - 10), offset))) return match;
      return convertRun(words);
    })
    .replace(/\b\d(?:\s+\d)+\b/g, (run) => run.replace(/\s+/g, ''));
}

/** "pole 123" -> "pole 1 2 3": how a small Whisper model renders ids. */
export function spaceDigits(text: string): string {
  return text.replace(/\d{2,}/g, (m) => m.split('').join(' '));
}

/** "pole 123" -> "pole one two three": how a streaming model renders ids. */
export function digitsToSpokenText(text: string): string {
  return text.replace(/\d+/g, (m) => digitsToWords(m));
}

/** Word error rate (substitutions + insertions + deletions over reference length). */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const tokenize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  const ref = tokenize(reference);
  const hyp = tokenize(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
    }
    prev = cur;
  }
  return (prev[hyp.length] as number) / ref.length;
}
