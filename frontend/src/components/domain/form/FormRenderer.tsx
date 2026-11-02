import type { Asset, FormSchema, Scalar } from '@/api/types';
import type { FieldValues } from '@/lib/fieldMerge';
import { isRequired } from '@/lib/formLogic';
import { FieldRow } from './FieldRow';

export interface FormRendererProps {
  form: FormSchema;
  values: FieldValues;
  assets: Asset[];
  disabled: boolean;
  flashSeq: Record<string, number>;
  /** key of the field whose evidence is currently highlighted (hovered / focused) */
  activeKey: string | null;
  /** keys produced by the extraction whose transcript is on screen */
  evidenceKeys: ReadonlySet<string>;
  onEdit: (key: string, value: Scalar) => void;
  onConfirm: (key: string) => void;
  onActivate: (key: string | null, via: 'hover' | 'focus') => void;
  onShowEvidence: (key: string) => void;
}

/** Renders `FormSchema.fields` in order; each field type gets its own control. */
export function FormRenderer({ form, values, assets, disabled, flashSeq, activeKey, evidenceKeys, onEdit, onConfirm, onActivate, onShowEvidence }: FormRendererProps) {
  return (
    <div className="space-y-3">
      {form.fields.map((spec) => (
        <FieldRow
          key={spec.key}
          spec={spec}
          value={values[spec.key]}
          assets={assets}
          required={isRequired(spec, values)}
          disabled={disabled}
          flashSeq={flashSeq[spec.key] ?? 0}
          active={activeKey === spec.key}
          evidenceVisible={evidenceKeys.has(spec.key) && !!values[spec.key]?.evidence}
          onEdit={(v) => onEdit(spec.key, v)}
          onConfirm={() => onConfirm(spec.key)}
          onActivate={onActivate}
          onShowEvidence={onShowEvidence}
        />
      ))}
    </div>
  );
}
