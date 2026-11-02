/** Synthetic demo world for mock mode: workers, forms, assets, knowledge base and work orders. All fictional. */
import type { Asset, CodeOption, FieldSpec, FormSchema, KbDoc, ModelManifest, Worker, WorkOrder } from '@/api/types';

export const DEMO_PIN = '1234';

export const WORKERS: Worker[] = [
  { id: 'w-101', name: 'Dana Whitfield', role: 'Journeyman Lineworker', crew: 'A (Overhead)' },
  { id: 'w-102', name: 'Marcus Okafor', role: 'Lineworker', crew: 'A (Overhead)' },
  { id: 'w-103', name: 'Priya Raman', role: 'Troubleshooter', crew: 'C (Storm)' },
  { id: 'w-104', name: 'Luis Herrera', role: 'Meter Technician', crew: 'M (Metering)' },
  { id: 'w-105', name: 'Hannah Brooks', role: 'Apprentice Lineworker', crew: 'B (Underground)' },
];

function field(partial: Partial<FieldSpec> & Pick<FieldSpec, 'key' | 'label' | 'type'>): FieldSpec {
  return {
    required: false,
    help: null,
    options: [],
    entity_kind: null,
    role_triggers: [],
    unit: null,
    min_value: null,
    max_value: null,
    unit_triggers: [],
    label_triggers: [],
    true_triggers: [],
    fill_from_transcript: false,
    max_length: 400,
    required_when: null,
    ...partial,
  };
}

const opt = (code: string, label: string, synonyms: string[] = []): CodeOption => ({ code, label, synonyms });

export const FORMS: FormSchema[] = [
  {
    id: 'transformer_replacement',
    version: 3,
    title: 'Transformer replacement',
    work_type: 'transformer_replacement',
    description: 'Record the replacement of a pole-mounted distribution transformer.',
    fields: [
      field({
        key: 'work_performed',
        label: 'Work performed',
        type: 'enum',
        required: true,
        help: 'What was actually done on this visit.',
        options: [
          opt('transformer_replacement', 'Transformer replacement', ['replaced the transformer', 'swapped the transformer', 'changed out the transformer', 'transformer swap', 'replaced transformer']),
          opt('transformer_repair', 'Transformer repair', ['repaired the transformer', 'repair the transformer', 'fixed the transformer']),
          opt('inspection_only', 'Inspection only', ['inspected only', 'inspection only', 'just inspected']),
        ],
      }),
      field({
        key: 'pole_id',
        label: 'Pole',
        type: 'entity_ref',
        required: true,
        entity_kind: 'pole',
        role_triggers: ['pole'],
        help: 'Pole the transformer is mounted on.',
      }),
      field({
        key: 'old_unit_condition',
        label: 'Condition of old unit',
        type: 'enum',
        required_when: { work_performed: 'transformer_replacement' },
        options: [
          opt('leaking_oil', 'Leaking oil', ['leaking oil', 'oil leak', 'leaking', 'leaked oil']),
          opt('corroded', 'Corroded', ['corroded', 'corrosion', 'rusted']),
          opt('burnt', 'Burnt / overheated', ['burnt', 'burned', 'overheated', 'scorched']),
          opt('damaged', 'Physically damaged', ['damaged', 'cracked bushing', 'broken bushing']),
          opt('no_defect', 'No visible defect', ['no defect', 'looked fine', 'good condition', 'no visible damage']),
        ],
      }),
      field({
        key: 'new_unit_id',
        label: 'Installed unit',
        type: 'entity_ref',
        required_when: { work_performed: 'transformer_replacement' },
        entity_kind: 'stock_unit',
        role_triggers: ['unit', 'installed unit', 'installed'],
        help: 'Stock transformer that was installed (from the truck inventory).',
      }),
      field({
        key: 'new_unit_kva',
        label: 'Installed rating',
        type: 'number',
        unit: 'kVA',
        min_value: 5,
        max_value: 500,
        unit_triggers: ['kva'],
        label_triggers: ['rating', 'size'],
      }),
      field({
        key: 'customer_notified',
        label: 'Customer notified',
        type: 'boolean',
        true_triggers: ['customer was notified', 'notified the customer', 'notified customer', 'customer notified'],
      }),
      field({ key: 'notes', label: 'Notes', type: 'text', fill_from_transcript: true, max_length: 400 }),
    ],
  },
  {
    id: 'pole_inspection',
    version: 2,
    title: 'Pole inspection',
    work_type: 'pole_inspection',
    description: 'Visual and ground-line inspection of a wood distribution pole.',
    fields: [
      field({ key: 'pole_id', label: 'Pole', type: 'entity_ref', required: true, entity_kind: 'pole', role_triggers: ['pole'] }),
      field({
        key: 'pole_condition',
        label: 'Condition',
        type: 'enum',
        required: true,
        options: [
          opt('good', 'Good', ['good condition', 'no issues', 'looks good', 'sound']),
          opt('leaning', 'Leaning', ['leaning', 'leans', 'out of plumb']),
          opt('cracked', 'Cracked / split', ['cracked', 'split', 'checking']),
          opt('rotted', 'Rotted at base', ['rotted', 'rotten', 'decayed', 'soft at the base']),
          opt('woodpecker', 'Woodpecker damage', ['woodpecker', 'bird damage']),
        ],
      }),
      field({
        key: 'lean_angle_deg',
        label: 'Lean angle',
        type: 'number',
        unit: 'deg',
        min_value: 0,
        max_value: 45,
        unit_triggers: ['degrees', 'degree', 'deg'],
        label_triggers: ['lean', 'angle'],
      }),
      field({
        key: 'needs_treatment',
        label: 'Needs treatment',
        type: 'boolean',
        true_triggers: ['needs treatment', 'needs to be treated', 'needs treating'],
      }),
      field({ key: 'notes', label: 'Notes', type: 'text', fill_from_transcript: true }),
    ],
  },
  {
    id: 'meter_exchange',
    version: 1,
    title: 'Meter exchange',
    work_type: 'meter_exchange',
    description: 'Swap a customer meter and record the final reading.',
    fields: [
      field({
        key: 'old_meter_id',
        label: 'Removed meter',
        type: 'entity_ref',
        required: true,
        entity_kind: 'meter',
        role_triggers: ['old meter', 'meter', 'removed'],
      }),
      field({
        key: 'new_meter_id',
        label: 'Installed meter',
        type: 'entity_ref',
        required: true,
        entity_kind: 'stock_meter',
        role_triggers: ['new meter', 'installed', 'new'],
      }),
      field({
        key: 'final_reading_kwh',
        label: 'Final reading',
        type: 'number',
        required: true,
        unit: 'kWh',
        min_value: 0,
        max_value: 99999,
        unit_triggers: ['kwh', 'kilowatt hours', 'kilowatt hour'],
        label_triggers: ['reading', 'read'],
      }),
      field({
        key: 'exchange_reason',
        label: 'Reason',
        type: 'enum',
        options: [
          opt('scheduled_upgrade', 'Scheduled upgrade', ['scheduled upgrade', 'scheduled change', 'upgrade']),
          opt('faulty_meter', 'Faulty meter', ['faulty', 'not registering', 'stopped working']),
          opt('tamper_suspected', 'Tamper suspected', ['tamper', 'tampering', 'bypassed']),
        ],
      }),
      field({ key: 'seal_applied', label: 'Seal applied', type: 'boolean', true_triggers: ['seal applied', 'sealed it', 'applied the seal', 'sealed'] }),
      field({ key: 'notes', label: 'Notes', type: 'text', fill_from_transcript: true }),
    ],
  },
];

const asset = (id: string, kind: string, label: string, location: string | null, attributes: Record<string, string> = {}): Asset => ({
  id,
  kind,
  label,
  location,
  attributes,
});

export const ASSETS: Asset[] = [
  asset('123', 'pole', 'Pole 123', 'Maple St & 4th Ave', { height_ft: '40', class: '4' }),
  asset('128', 'pole', 'Pole 128', 'Maple St & 5th Ave', { height_ft: '40', class: '4' }),
  asset('211', 'pole', 'Pole 211', 'Oak Ridge Rd #14', { height_ft: '45', class: '3' }),
  asset('305', 'pole', 'Pole 305', 'Cedar Ln (north end)', { height_ft: '35', class: '5' }),
  asset('412', 'pole', 'Pole 412', 'Quarry Rd & Mill St', { height_ft: '45', class: '3' }),
  asset('518', 'pole', 'Pole 518', 'Feeder 12 corridor, span 18', { height_ft: '50', class: '2' }),
  asset('627', 'pole', 'Pole 627', 'Feeder 12 corridor, span 27', { height_ft: '50', class: '2' }),
  asset('734', 'pole', 'Pole 734', 'Riverside Dr & Elm', { height_ft: '40', class: '4' }),
  asset('9921', 'transformer', 'Transformer 9921 (25 kVA)', 'Pole 123', { parent_pole: '123', kva: '25' }),
  asset('T4471', 'transformer', 'Transformer T4471 (50 kVA)', 'Pole 518', { parent_pole: '518', kva: '50' }),
  asset('F12', 'feeder', 'Feeder 12', 'Substation North', { voltage_kv: '12.47' }),
  asset('456', 'stock_unit', 'Stock transformer 456 (25 kVA)', 'Truck 14', { kva: '25', status: 'new' }),
  asset('471', 'stock_unit', 'Stock transformer 471 (50 kVA)', 'Truck 14', { kva: '50', status: 'new' }),
  asset('489', 'stock_unit', 'Stock transformer 489 (75 kVA)', 'Truck 14', { kva: '75', status: 'refurbished' }),
  asset('502', 'stock_unit', 'Stock transformer 502 (25 kVA)', 'Truck 14', { kva: '25', status: 'new' }),
  asset('517', 'stock_unit', 'Stock transformer 517 (100 kVA)', 'Central stores', { kva: '100', status: 'new' }),
  asset('533', 'stock_unit', 'Stock transformer 533 (50 kVA)', 'Central stores', { kva: '50', status: 'refurbished' }),
  asset('88201', 'meter', 'Meter 88201', '27 Cedar Ln', { phase: '1' }),
  asset('88202', 'meter', 'Meter 88202', '29 Cedar Ln', { phase: '1' }),
  asset('88207', 'meter', 'Meter 88207', '14 Quarry Rd', { phase: '3' }),
  asset('88210', 'meter', 'Meter 88210', '3 Mill St', { phase: '1' }),
  asset('70155', 'stock_meter', 'Stock meter 70155', 'Truck 22', { phase: '1' }),
  asset('70162', 'stock_meter', 'Stock meter 70162', 'Truck 22', { phase: '1' }),
  asset('70171', 'stock_meter', 'Stock meter 70171', 'Truck 22', { phase: '3' }),
];

export const KB_DOCS: KbDoc[] = [
  {
    id: 'KB-TR-001',
    title: 'Transformer replacement procedure',
    applies_to: ['transformer_replacement', 'transformer', 'pole'],
    revision: 'C',
    effective_date: '2026-03-01',
    sections: [
      { heading: 'Before you start', text: 'Confirm the work order, the pole id and the unit you are installing match. Read back the nameplate rating of the replacement unit before it leaves the ground.' },
      { heading: 'De-energize and verify', text: 'Open the upstream cutout, test for absence of voltage on every bushing and apply protective grounds before touching the transformer. Do not rely on the outage map alone.' },
      { heading: 'Removal of the failed unit', text: 'Photograph the nameplate and the wiring before disconnecting. Record any oil staining, corrosion or bushing damage in the condition field. Treat any leaking unit as an oil spill (see KB-TR-014).' },
      { heading: 'Install and verify', text: 'Hang the new unit, torque connections to the values on the unit tag, re-energize in the sequence on the switching order and verify secondary voltage at the service point.' },
      { heading: 'Close-out', text: 'Record the pole, the old unit condition, the installed unit id and rating. Attach photos of the old and new nameplates. Notify affected customers before you leave the site.' },
    ],
  },
  {
    id: 'KB-TR-014',
    title: 'Oil-filled equipment: spill response',
    applies_to: ['transformer', 'transformer_replacement'],
    revision: 'B',
    effective_date: '2026-01-15',
    sections: [
      { heading: 'Contain first', text: 'Place absorbent boom and pads under the unit before it is lowered. Stop work if oil is reaching a storm drain or waterway and call the environmental line.' },
      { heading: 'Reporting', text: 'Any visible leak from a removed unit is reportable. Photograph the leak, note the pole id and record "leaking oil" as the condition so the unit is routed to testing instead of reuse.' },
    ],
  },
  {
    id: 'KB-PI-002',
    title: 'Wood pole inspection criteria',
    applies_to: ['pole_inspection', 'pole'],
    revision: 'D',
    effective_date: '2026-02-10',
    sections: [
      { heading: 'Ground-line decay', text: 'Sound the pole with a hammer from the ground line to head height. A hollow or soft response at the base is recorded as rotted and the pole is flagged for replacement review.' },
      { heading: 'Lean', text: 'Estimate lean from two directions with a plumb reference. Record the larger angle in degrees. A lean that is visibly increasing between visits is reported even when under the limit.' },
      { heading: 'Woodpecker damage', text: 'Holes above the ground line are recorded as woodpecker damage. Poles with several holes are flagged for treatment or replacement.' },
    ],
  },
  {
    id: 'KB-PI-007',
    title: 'Pole treatment and tagging',
    applies_to: ['pole_inspection', 'pole'],
    revision: 'A',
    effective_date: '2025-11-20',
    sections: [
      { heading: 'When to treat', text: 'Apply ground-line preservative to poles marked "needs treatment" and tag the pole with the date. Do not treat poles that are condemned.' },
    ],
  },
  {
    id: 'KB-ME-003',
    title: 'Meter exchange procedure',
    applies_to: ['meter_exchange', 'meter'],
    revision: 'A',
    effective_date: '2026-04-02',
    sections: [
      { heading: 'Record the final reading', text: 'Read and record the register before removal. A photograph of the register is required for every exchange.' },
      { heading: 'Seal and verify', text: 'Fit the new meter, apply a seal, record the seal number and confirm the new meter is registering before leaving.' },
    ],
  },
  {
    id: 'KB-ME-009',
    title: 'Tamper indicators and reporting',
    applies_to: ['meter_exchange', 'meter'],
    revision: 'B',
    effective_date: '2026-05-18',
    sections: [
      { heading: 'What to look for', text: 'Broken or missing seals, bypass wiring and drill holes in the base are tamper indicators. Photograph everything before touching the meter and select "tamper suspected" as the reason.' },
    ],
  },
  {
    id: 'KB-GEN-001',
    title: 'Customer notification policy',
    applies_to: ['transformer_replacement', 'meter_exchange'],
    revision: 'B',
    effective_date: '2026-01-05',
    sections: [
      { heading: 'Planned interruptions', text: 'Customers affected by a planned interruption must be notified before the work starts. Record whether the customer was notified on the form.' },
    ],
  },
];

export const MODEL_MANIFEST: ModelManifest = {
  requirements: [
    { role: 'stt', engine_id: 'foundry:stt:nemotron-speech-streaming-en-0.6b:cpu', alias: 'nemotron-speech-streaming-en-0.6b', device: 'cpu', required: true },
    { role: 'stt', engine_id: 'foundry:stt:whisper-base:cpu', alias: 'whisper-base', device: 'cpu', required: false },
    { role: 'llm', engine_id: 'foundry:llm:qwen2.5-0.5b:cpu', alias: 'qwen2.5-0.5b', device: 'cpu', required: true },
    { role: 'llm', engine_id: 'foundry:llm:qwen2.5-1.5b:cpu', alias: 'qwen2.5-1.5b', device: 'cpu', required: true },
  ],
};

export const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** The system-of-record copy of today's jobs (version = dispatch's current revision). */
export function buildWorkOrders(workerId: string, today: string = todayIso()): WorkOrder[] {
  const base = {
    scheduled_for: today,
    worker_id: workerId,
    asset_ids: [] as string[],
    kb_doc_ids: [] as string[],
    version: 1,
    prefill: {},
  };
  return [
    {
      ...base,
      id: 'WO-1001',
      title: 'Emergency transformer replacement - Maple St',
      description: 'Customer reports a hum and flickering lights; a previous crew found the pole-mounted transformer weeping oil. Replace with a 25 kVA unit from truck stock and make the site safe.',
      location: 'Maple St & 4th Ave (pole 123)',
      priority: 'emergency',
      status: 'assigned',
      form_id: 'transformer_replacement',
      form_version: 3,
      asset_ids: ['123', '128', '211', '9921', 'F12'],
      kb_doc_ids: ['KB-TR-001', 'KB-TR-014', 'KB-GEN-001'],
    },
    {
      ...base,
      id: 'WO-1002',
      title: 'Planned 50 kVA transformer change - Feeder 12',
      description: 'Scheduled swap of an aging 50 kVA unit on the Feeder 12 corridor. Dispatch has pre-filled the pole; confirm it on site.',
      location: 'Feeder 12 corridor, span 18 (pole 518)',
      priority: 'high',
      status: 'in_progress',
      form_id: 'transformer_replacement',
      form_version: 3,
      asset_ids: ['518', '627', 'T4471', 'F12'],
      kb_doc_ids: ['KB-TR-001', 'KB-GEN-001'],
      prefill: { pole_id: '518' },
      version: 2,
    },
    {
      ...base,
      id: 'WO-1003',
      title: 'Pole inspection - Cedar Ln / Quarry Rd',
      description: 'Annual inspection of four poles flagged by the last patrol. Check ground-line decay, lean and woodpecker damage.',
      location: 'Cedar Ln (north end) to Quarry Rd',
      priority: 'normal',
      status: 'assigned',
      form_id: 'pole_inspection',
      form_version: 2,
      asset_ids: ['305', '412', '734', '123'],
      kb_doc_ids: ['KB-PI-002', 'KB-PI-007'],
    },
    {
      ...base,
      id: 'WO-1004',
      title: 'Meter exchange - 27 Cedar Ln',
      description: 'Scheduled upgrade to a new smart meter. Record the final reading and apply a seal.',
      location: '27 Cedar Ln',
      priority: 'low',
      status: 'completed',
      form_id: 'meter_exchange',
      form_version: 1,
      asset_ids: ['88201', '88202', '70155', '70162'],
      kb_doc_ids: ['KB-ME-003'],
    },
    {
      ...base,
      id: 'WO-1005',
      title: 'Pole inspection - Riverside Dr',
      description: 'Follow-up inspection after a reported lean.',
      location: 'Riverside Dr & Elm',
      priority: 'normal',
      status: 'completed',
      form_id: 'pole_inspection',
      form_version: 2,
      asset_ids: ['734', '412'],
      kb_doc_ids: ['KB-PI-002'],
    },
    {
      ...base,
      id: 'WO-1006',
      title: 'Meter exchange - 14 Quarry Rd (tamper check)',
      description: 'Customer-requested exchange; inspect for tamper indicators before removal.',
      location: '14 Quarry Rd',
      priority: 'high',
      status: 'completed',
      form_id: 'meter_exchange',
      form_version: 1,
      asset_ids: ['88207', '88210', '70171', '70155'],
      kb_doc_ids: ['KB-ME-003', 'KB-ME-009'],
      version: 2,
    },
  ];
}

/** Job assets + the stock inventory (what the server calls the closed world of the job). */
export function closedWorld(workOrder: WorkOrder): Asset[] {
  const job = ASSETS.filter((a) => workOrder.asset_ids.includes(a.id));
  const stock = ASSETS.filter((a) => (a.kind === 'stock_unit' || a.kind === 'stock_meter') && !workOrder.asset_ids.includes(a.id));
  return [...job, ...stock];
}
