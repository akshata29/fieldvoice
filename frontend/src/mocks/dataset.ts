/** Synthetic evaluation dataset generator for mock mode (templates -> spoken / written / expected). */
import type { EvalCase, EvalDatasetInfo, NoiseSpec, Scalar } from '@/api/types';
import { ASSETS } from './fixtures/world';
import { Rng } from './rng';
import { digitsToWords, groupedIdWords, numberToWords } from './text';

export interface GenerateOptions {
  id: string;
  name: string;
  n: number;
  seed: number;
  audioLimit: number | null;
  augment: boolean;
  createdAt?: string;
}

type Style = 'digits' | 'grouped';

interface Built {
  written: string;
  spoken: string;
  expected: Record<string, Scalar>;
  tags: string[];
  heldout?: boolean;
}

interface Ctx {
  rng: Rng;
  style: Style;
}

const ids = (kind: string): string[] => ASSETS.filter((a) => a.kind === kind).map((a) => a.id);
const POLES = ids('pole');
const STOCK_UNITS = ids('stock_unit');
const METERS = ids('meter');
const STOCK_METERS = ids('stock_meter');

/** Same id twice: how it is written and how it is said. */
function say(id: string, style: Style): { w: string; s: string } {
  return { w: id, s: style === 'grouped' && id.length === 3 ? groupedIdWords(id) : digitsToWords(id) };
}

const CONDITIONS: Array<{ code: string; phrase: string }> = [
  { code: 'leaking_oil', phrase: 'leaking oil' },
  { code: 'corroded', phrase: 'corroded' },
  { code: 'burnt', phrase: 'burnt' },
  { code: 'damaged', phrase: 'damaged' },
  { code: 'no_defect', phrase: 'in good condition' },
];

const base = (): Record<string, Scalar> => ({});

const transformer: Array<(c: Ctx) => Built> = [
  (c) => {
    const pole = say(c.rng.pick(POLES), c.style);
    const unit = say(c.rng.pick(STOCK_UNITS), c.style);
    const cond = c.rng.pick(CONDITIONS);
    return {
      written: `I replaced the transformer at pole ${pole.w}. The old unit was ${cond.phrase} and I installed unit ${unit.w}.`,
      spoken: `I replaced the transformer at pole ${pole.s}. The old unit was ${cond.phrase} and I installed unit ${unit.s}.`,
      expected: { ...base(), work_performed: 'transformer_replacement', pole_id: pole.w, old_unit_condition: cond.code, new_unit_id: unit.w, new_unit_kva: null, customer_notified: null },
      tags: ['standard'],
    };
  },
  (c) => {
    const pole = say(c.rng.pick(POLES), c.style);
    const unit = say(c.rng.pick(STOCK_UNITS), c.style);
    const kva = c.rng.pick([25, 50, 75, 100]);
    return {
      written: `Changed out the transformer on pole ${pole.w}, installed unit ${unit.w}, ${kva} kVA. The customer was notified.`,
      spoken: `Changed out the transformer on pole ${pole.s}, installed unit ${unit.s}, ${numberToWords(kva)} kVA. The customer was notified.`,
      expected: { work_performed: 'transformer_replacement', pole_id: pole.w, old_unit_condition: null, new_unit_id: unit.w, new_unit_kva: kva, customer_notified: true },
      tags: ['units', 'boolean'],
    };
  },
  (c) => {
    const [p1, p2] = c.rng.shuffle(POLES).slice(0, 2).map((p) => say(p, c.style)) as [ReturnType<typeof say>, ReturnType<typeof say>];
    const unit = say(c.rng.pick(STOCK_UNITS), c.style);
    return {
      written: `Replaced the transformer at pole ${p1.w}, no wait, pole ${p2.w}. Installed unit ${unit.w}.`,
      spoken: `Replaced the transformer at pole ${p1.s}, no wait, pole ${p2.s}. Installed unit ${unit.s}.`,
      expected: { work_performed: 'transformer_replacement', pole_id: p2.w, old_unit_condition: null, new_unit_id: unit.w, new_unit_kva: null, customer_notified: null },
      tags: ['correction'],
    };
  },
  (c) => {
    const pole = say(c.rng.pick(POLES), c.style);
    const unit = say(c.rng.pick(STOCK_UNITS), c.style);
    return {
      written: `Replaced the transformer at pole ${pole.w}. Installed unit ${unit.w}. The customer was not notified.`,
      spoken: `Replaced the transformer at pole ${pole.s}. Installed unit ${unit.s}. The customer was not notified.`,
      expected: { work_performed: 'transformer_replacement', pole_id: pole.w, old_unit_condition: null, new_unit_id: unit.w, new_unit_kva: null, customer_notified: false },
      tags: ['negation', 'boolean'],
    };
  },
  (c) => {
    const pole = say(c.rng.pick(POLES), c.style);
    return {
      written: `I replaced the transformer at pole ${pole.w}.`,
      spoken: `I replaced the transformer at pole ${pole.s}.`,
      expected: { work_performed: 'transformer_replacement', pole_id: pole.w, old_unit_condition: null, new_unit_id: null, new_unit_kva: null, customer_notified: null },
      tags: ['missing'],
    };
  },
  (c) => {
    const pole = say(c.rng.pick(POLES), c.style);
    const unit = say(c.rng.pick(STOCK_UNITS), c.style);
    return {
      written: `Swapped the pot on pole ${pole.w}. The old one was leaking, put in unit ${unit.w}.`,
      spoken: `Swapped the pot on pole ${pole.s}. The old one was leaking, put in unit ${unit.s}.`,
      expected: { work_performed: 'transformer_replacement', pole_id: pole.w, old_unit_condition: 'leaking_oil', new_unit_id: unit.w, new_unit_kva: null, customer_notified: null },
      tags: ['colloquial'],
      heldout: true,
    };
  },
  (c) => {
    const pole = say(c.rng.pick(POLES), c.style);
    return {
      written: `Repaired the transformer on pole ${pole.w}, nothing needed replacing.`,
      spoken: `Repaired the transformer on pole ${pole.s}, nothing needed replacing.`,
      expected: { work_performed: 'transformer_repair', pole_id: pole.w, old_unit_condition: null, new_unit_id: null, new_unit_kva: null, customer_notified: null },
      tags: ['alternate-work'],
    };
  },
];

const POLE_CONDITIONS: Array<{ code: string; phrase: string }> = [
  { code: 'good', phrase: 'in good condition' },
  { code: 'cracked', phrase: 'cracked near the crossarm' },
  { code: 'rotted', phrase: 'rotted at the base' },
  { code: 'woodpecker', phrase: 'showing woodpecker damage' },
];

const inspection: Array<(c: Ctx) => Built> = [
  (c) => {
    const pole = say(c.rng.pick(POLES), c.style);
    const cond = c.rng.pick(POLE_CONDITIONS);
    return {
      written: `Inspected pole ${pole.w}. It is ${cond.phrase}.`,
      spoken: `Inspected pole ${pole.s}. It is ${cond.phrase}.`,
      expected: { pole_id: pole.w, pole_condition: cond.code, lean_angle_deg: null, needs_treatment: null },
      tags: ['standard'],
    };
  },
  (c) => {
    const pole = say(c.rng.pick(POLES), c.style);
    const deg = c.rng.int(3, 30);
    return {
      written: `Pole ${pole.w} is leaning. Lean angle about ${deg} degrees.`,
      spoken: `Pole ${pole.s} is leaning. Lean angle about ${numberToWords(deg)} degrees.`,
      expected: { pole_id: pole.w, pole_condition: 'leaning', lean_angle_deg: deg, needs_treatment: null },
      tags: ['units'],
    };
  },
  (c) => {
    const pole = say(c.rng.pick(POLES), c.style);
    return {
      written: `Pole ${pole.w} is rotted at the base and needs treatment.`,
      spoken: `Pole ${pole.s} is rotted at the base and needs treatment.`,
      expected: { pole_id: pole.w, pole_condition: 'rotted', lean_angle_deg: null, needs_treatment: true },
      tags: ['boolean'],
    };
  },
  (c) => {
    const pole = say(c.rng.pick(POLES), c.style);
    return {
      written: `Pole ${pole.w}, good condition, does not need treatment.`,
      spoken: `Pole ${pole.s}, good condition, does not need treatment.`,
      expected: { pole_id: pole.w, pole_condition: 'good', lean_angle_deg: null, needs_treatment: false },
      tags: ['negation', 'boolean'],
    };
  },
  (c) => {
    const pole = say(c.rng.pick(POLES), c.style);
    return {
      written: `Looked at pole ${pole.w}. A bird has been pecking holes in it.`,
      spoken: `Looked at pole ${pole.s}. A bird has been pecking holes in it.`,
      expected: { pole_id: pole.w, pole_condition: 'woodpecker', lean_angle_deg: null, needs_treatment: null },
      tags: ['colloquial'],
      heldout: true,
    };
  },
];

const meters: Array<(c: Ctx) => Built> = [
  (c) => {
    const oldM = say(c.rng.pick(METERS), 'digits');
    const newM = say(c.rng.pick(STOCK_METERS), 'digits');
    const reading = c.rng.int(100, 999);
    return {
      written: `Exchanged meter ${oldM.w} for new meter ${newM.w}. Final reading was ${reading} kilowatt hours.`,
      spoken: `Exchanged meter ${oldM.s} for new meter ${newM.s}. Final reading was ${numberToWords(reading)} kilowatt hours.`,
      expected: { old_meter_id: oldM.w, new_meter_id: newM.w, final_reading_kwh: reading, exchange_reason: null, seal_applied: null },
      tags: ['standard', 'units'],
    };
  },
  (c) => {
    const oldM = say(c.rng.pick(METERS), 'digits');
    const newM = say(c.rng.pick(STOCK_METERS), 'digits');
    const reading = c.rng.int(100, 999);
    return {
      written: `Meter ${oldM.w} was faulty so I installed new meter ${newM.w}. Final read ${reading} kWh. Seal applied.`,
      spoken: `Meter ${oldM.s} was faulty so I installed new meter ${newM.s}. Final read ${numberToWords(reading)} kWh. Seal applied.`,
      expected: { old_meter_id: oldM.w, new_meter_id: newM.w, final_reading_kwh: reading, exchange_reason: 'faulty_meter', seal_applied: true },
      tags: ['boolean', 'units'],
    };
  },
  (c) => {
    const [o1, o2] = c.rng.shuffle(METERS).slice(0, 2).map((m) => say(m, 'digits')) as [ReturnType<typeof say>, ReturnType<typeof say>];
    const newM = say(c.rng.pick(STOCK_METERS), 'digits');
    const reading = c.rng.int(100, 999);
    return {
      written: `Old meter ${o1.w}, no wait, meter ${o2.w}. New meter ${newM.w}. Reading ${reading} kilowatt hours.`,
      spoken: `Old meter ${o1.s}, no wait, meter ${o2.s}. New meter ${newM.s}. Reading ${numberToWords(reading)} kilowatt hours.`,
      expected: { old_meter_id: o2.w, new_meter_id: newM.w, final_reading_kwh: reading, exchange_reason: null, seal_applied: null },
      tags: ['correction'],
    };
  },
  (c) => {
    const oldM = say(c.rng.pick(METERS), 'digits');
    const newM = say(c.rng.pick(STOCK_METERS), 'digits');
    const reading = c.rng.int(100, 999);
    return {
      written: `Tamper suspected on meter ${oldM.w}. Installed new meter ${newM.w}, final reading ${reading} kilowatt hours.`,
      spoken: `Tamper suspected on meter ${oldM.s}. Installed new meter ${newM.s}, final reading ${numberToWords(reading)} kilowatt hours.`,
      expected: { old_meter_id: oldM.w, new_meter_id: newM.w, final_reading_kwh: reading, exchange_reason: 'tamper_suspected', seal_applied: null },
      tags: ['standard'],
    };
  },
];

const FORMS: Array<{ id: string; version: number; prefix: string; templates: Array<(c: Ctx) => Built> }> = [
  { id: 'transformer_replacement', version: 3, prefix: 'tr', templates: transformer },
  { id: 'pole_inspection', version: 2, prefix: 'pi', templates: inspection },
  { id: 'meter_exchange', version: 1, prefix: 'me', templates: meters },
];

const VOICES = ['Microsoft David', 'Microsoft Zira', 'Microsoft Mark'];
const NOISES: NoiseSpec['kind'][] = ['wind', 'engine', 'radio', 'crackle', 'muffled'];

/** Hand-picked first cases: the example utterance from the brief (and a counterpart per form). */
function hero(formIndex: number): Built {
  if (formIndex === 0) {
    return {
      written: 'I replaced the transformer at pole 123. The old unit was leaking oil and I installed unit 456.',
      spoken: 'I replaced the transformer at pole one two three. The old unit was leaking oil and I installed unit four five six.',
      expected: { work_performed: 'transformer_replacement', pole_id: '123', old_unit_condition: 'leaking_oil', new_unit_id: '456', new_unit_kva: null, customer_notified: null },
      tags: ['standard', 'hero'],
    };
  }
  if (formIndex === 1) {
    return {
      written: 'Inspected pole 305. It is leaning. Lean angle about 12 degrees.',
      spoken: 'Inspected pole three hundred five. It is leaning. Lean angle about twelve degrees.',
      expected: { pole_id: '305', pole_condition: 'leaning', lean_angle_deg: 12, needs_treatment: null },
      tags: ['standard', 'hero', 'grouped'],
    };
  }
  return {
    written: 'Exchanged meter 88201 for new meter 70155. Final reading was 482 kilowatt hours.',
    spoken: 'Exchanged meter eight eight two zero one for new meter seven zero one five five. Final reading was four hundred eighty two kilowatt hours.',
    expected: { old_meter_id: '88201', new_meter_id: '70155', final_reading_kwh: 482, exchange_reason: null, seal_applied: null },
    tags: ['standard', 'hero', 'units'],
  };
}

export function generateCases(opts: GenerateOptions): EvalCase[] {
  const rng = new Rng(opts.seed);
  const counters = [0, 0, 0];
  const cases: EvalCase[] = [];
  const worldIds = ASSETS.map((a) => a.id);

  for (let i = 0; i < opts.n; i++) {
    const formIndex = i % FORMS.length;
    const form = FORMS[formIndex] as (typeof FORMS)[number];
    const k = counters[formIndex] as number;
    counters[formIndex] = k + 1;

    const style: Style = rng.chance(0.4) ? 'grouped' : 'digits';
    const built = k === 0 ? hero(formIndex) : (form.templates[(k - 1) % form.templates.length] as (c: Ctx) => Built)({ rng, style });
    const tags = [...built.tags];
    if (k > 0 && !tags.includes('hero')) tags.push(style);

    const hasAudio = opts.audioLimit === null ? true : i < opts.audioLimit;
    const noisy = opts.augment && hasAudio && i % 4 === 3;
    const noise: NoiseSpec | null = noisy
      ? { kind: rng.pick(NOISES), snr_db: rng.int(8, 20), reverb: rng.chance(0.3) }
      : hasAudio
        ? { kind: 'none', snr_db: null, reverb: false }
        : null;
    if (noisy) tags.push('noisy');

    const id = `${form.prefix}-${String(k + 1).padStart(4, '0')}`;
    cases.push({
      id,
      form_id: form.id,
      form_version: form.version,
      job_asset_ids: worldIds,
      spoken_text: built.spoken,
      written_text: built.written,
      audio_path: hasAudio ? `audio/${id}.wav` : null,
      expected: built.expected,
      tags,
      split: built.heldout || k % 5 === 4 ? 'heldout' : 'dev',
      voice: hasAudio ? rng.pick(VOICES) : null,
      noise,
    });
  }
  return cases;
}

export function buildDatasetInfo(opts: GenerateOptions, cases: EvalCase[]): EvalDatasetInfo {
  const tagCounts: Record<string, number> = {};
  const splits: Record<string, number> = {};
  for (const c of cases) {
    for (const t of c.tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
    splits[c.split] = (splits[c.split] ?? 0) + 1;
  }
  return {
    id: opts.id,
    name: opts.name,
    created_at: opts.createdAt ?? new Date().toISOString(),
    seed: opts.seed,
    n_cases: cases.length,
    n_with_audio: cases.filter((c) => c.audio_path !== null).length,
    form_ids: Array.from(new Set(cases.map((c) => c.form_id))),
    tag_counts: tagCounts,
    splits,
    synthetic: true,
  };
}
