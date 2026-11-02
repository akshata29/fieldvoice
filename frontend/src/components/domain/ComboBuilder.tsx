import { useMemo, useState } from 'react';
import { SparklesIcon } from '@heroicons/react/24/outline';
import type { EngineInfo, EngineList } from '@/api/types';
import { NO_LLM_ID, ORACLE_STT_ID } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { CheckChip } from '@/components/ui/Controls';
import { Alert } from '@/components/ui/Feedback';
import { buildPreset, expandCombos, PRESETS, type PresetId } from '@/lib/combos';
import { fmtMb } from '@/lib/format';
import { strategyName } from '@/lib/engineLabels';

export interface ComboSelection {
  stt: string[];
  llm: string[];
  strategies: string[];
}

export const EMPTY_SELECTION: ComboSelection = { stt: [], llm: [], strategies: [] };

const toggle = (list: string[], id: string, on: boolean): string[] => (on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id));

function EngineChip({ engine, checked, onChange }: { engine: EngineInfo; checked: boolean; onChange: (on: boolean) => void }) {
  const ready = engine.availability === 'ready';
  const hint = ready
    ? `${engine.name}${engine.supports_streaming ? ' (streaming)' : ''}${engine.availability_reason ? ` - ${engine.availability_reason}` : ''}`
    : `${engine.name}: ${engine.availability.replace('_', ' ')}${engine.availability_reason ? ` - ${engine.availability_reason}` : ''}`;
  return (
    <CheckChip checked={checked && ready} onChange={onChange} disabled={!ready} title={hint}>
      <span>{engine.name}</span>
      {engine.size_mb ? <span className="text-xs opacity-65">{fmtMb(engine.size_mb)}</span> : null}
      {!ready ? <span className="text-xs font-semibold opacity-80">{engine.availability === 'needs_download' ? 'download' : engine.availability}</span> : null}
    </CheckChip>
  );
}

function Column({
  title,
  description,
  onAll,
  onNone,
  children,
}: {
  title: string;
  description: string;
  onAll: () => void;
  onNone: () => void;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="min-w-0 rounded-xl border border-line bg-surface-2 p-3 field:border-2">
      <legend className="sr-only">{title}</legend>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <p className="text-xs text-muted">{description}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" onClick={onAll}>
            All ready
          </Button>
          <Button size="sm" variant="ghost" onClick={onNone}>
            None
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

export function ComboBuilder({
  engines,
  value,
  onChange,
  includeOracle = true,
  oracleOnly = false,
  maxRecommended = 16,
}: {
  engines: EngineList;
  value: ComboSelection;
  onChange: (next: ComboSelection) => void;
  /** Offer the reference-transcript "engine" (text sources only: it cannot transcribe audio). */
  includeOracle?: boolean;
  /** Typed text skips speech recognition, so only the reference transcript makes sense. */
  oracleOnly?: boolean;
  maxRecommended?: number;
}) {
  const [notes, setNotes] = useState<string[]>([]);
  const sttList = useMemo(
    () => engines.stt.filter((e) => (oracleOnly ? e.id === ORACLE_STT_ID : includeOracle || e.id !== ORACLE_STT_ID)),
    [engines.stt, includeOracle, oracleOnly],
  );
  const { combos, skipped } = useMemo(() => expandCombos(value.stt, value.llm, value.strategies), [value]);

  const readyIds = (list: EngineInfo[]) => list.filter((e) => e.availability === 'ready').map((e) => e.id);

  const applyPreset = (id: PresetId) => {
    const p = buildPreset(id, engines);
    const allowed = new Set(sttList.map((e) => e.id));
    let stt = p.stt.filter((s) => allowed.has(s));
    if (stt.length === 0 && oracleOnly) stt = [ORACLE_STT_ID];
    onChange({ stt, llm: p.llm, strategies: p.strategies });
    setNotes(p.notes);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <SparklesIcon className="h-5 w-5 text-brand-600" aria-hidden="true" />
          Presets
        </span>
        {PRESETS.map((p) => (
          <Button key={p.id} size="sm" onClick={() => applyPreset(p.id)} title={p.description}>
            {p.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onChange(EMPTY_SELECTION);
            setNotes([]);
          }}
        >
          Clear
        </Button>
      </div>
      {notes.length > 0 ? (
        <ul className="list-disc pl-5 text-xs text-amber-800">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-3">
        <Column
          title="Speech-to-text engines"
          description="How the audio becomes words."
          onAll={() => onChange({ ...value, stt: readyIds(sttList) })}
          onNone={() => onChange({ ...value, stt: [] })}
        >
          {sttList.map((e) => (
            <EngineChip key={e.id} engine={e} checked={value.stt.includes(e.id)} onChange={(on) => onChange({ ...value, stt: toggle(value.stt, e.id, on) })} />
          ))}
        </Column>
        <Column
          title="Language models"
          description="Only used for what the rules cannot resolve."
          onAll={() => onChange({ ...value, llm: readyIds(engines.llm) })}
          onNone={() => onChange({ ...value, llm: [] })}
        >
          {engines.llm.map((e) => (
            <EngineChip key={e.id} engine={e} checked={value.llm.includes(e.id)} onChange={(on) => onChange({ ...value, llm: toggle(value.llm, e.id, on) })} />
          ))}
        </Column>
        <Column
          title="Extraction strategies"
          description="From today's baseline to the proposed hybrid."
          onAll={() => onChange({ ...value, strategies: engines.strategies.map((s) => s.id) })}
          onNone={() => onChange({ ...value, strategies: [] })}
        >
          {engines.strategies.map((s) => (
            <CheckChip key={s.id} checked={value.strategies.includes(s.id)} onChange={(on) => onChange({ ...value, strategies: toggle(value.strategies, s.id, on) })} title={s.description}>
              {strategyName(s.id, engines.strategies)}
            </CheckChip>
          ))}
        </Column>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-slate-100 px-4 py-2 text-sm field:border-2 field:border-black field:bg-white" aria-live="polite">
        <span className="text-lg font-bold tabular-nums text-ink">{combos.length}</span>
        <span className="text-ink">combination{combos.length === 1 ? '' : 's'} to run</span>
        <span className="text-muted">
          {value.stt.length} STT &times; {value.llm.length} LLM &times; {value.strategies.length} strategies
          {skipped > 0 ? ` - ${skipped} skipped as meaningless (LLM-only strategies need an LLM; rules-only never uses one)` : ''}
        </span>
      </div>
      {combos.length > maxRecommended ? (
        <Alert tone="warn">
          {combos.length} combinations is a lot: each one runs the whole case set, so this can take a long time on a laptop. Narrow the matrix or use fewer cases.
        </Alert>
      ) : null}
      {value.llm.includes(NO_LLM_ID) && value.strategies.some((s) => ['free_json', 'schema_constrained', 'enum_grammar'].includes(s)) ? (
        <p className="text-xs text-muted">LLM-only strategies are skipped for "No LLM".</p>
      ) : null}
    </div>
  );
}
