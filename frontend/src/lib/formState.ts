/**
 * Reducer holding the form values on the Job page.
 *  - `base`    what the worker has: draft, prefill, committed extractions and manual edits
 *  - `session` the in-flight extraction snapshot (progressively filled by `fields` events)
 * The displayed values are `mergeIntoForm(base, session)`; a later stage event replaces earlier ones by key, so the
 * `validate` stage can downgrade something `resolve` proposed. Per-key sequence numbers drive the highlight animation.
 */
import type { FieldValue, Scalar } from '@/api/types';
import { changedKeys, confirmFieldValue, mergeIntoForm, userFieldValue, type FieldValues } from '@/lib/fieldMerge';

export interface FormState {
  base: FieldValues;
  session: FieldValues;
  /** Keys that were produced by the latest extraction (evidence offsets refer to its transcript). */
  sessionKeys: string[];
  /** Per-key change counter; bump => the row re-mounts its flash animation. */
  flashSeq: Record<string, number>;
  /** Whether anything changed since the last save. */
  dirty: boolean;
}

export type FormAction =
  | { type: 'load'; values: FieldValues }
  | { type: 'session_start' }
  | { type: 'session_fields'; fields: FieldValues }
  | { type: 'session_commit'; fields?: FieldValues }
  | { type: 'edit'; key: string; value: Scalar }
  | { type: 'confirm'; key: string }
  | { type: 'saved' };

export const initialFormState = (values: FieldValues = {}): FormState => ({
  base: values,
  session: {},
  sessionKeys: [],
  flashSeq: {},
  dirty: false,
});

export const selectValues = (s: FormState): FieldValues => mergeIntoForm(s.base, s.session);

function bump(seq: Record<string, number>, keys: string[]): Record<string, number> {
  if (keys.length === 0) return seq;
  const next = { ...seq };
  for (const k of keys) next[k] = (next[k] ?? 0) + 1;
  return next;
}

/** Keys whose displayed value actually came from this extraction (not kept from the worker / an earlier utterance). */
function appliedKeys(merged: FieldValues, session: FieldValues): string[] {
  return Object.keys(session).filter((k) => merged[k] === session[k]);
}

export function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'load':
      return { ...initialFormState(action.values), flashSeq: state.flashSeq };

    case 'session_start':
      return { ...state, session: {}, sessionKeys: [] };

    case 'session_fields': {
      const before = selectValues(state);
      const session = { ...state.session, ...action.fields };
      const after = mergeIntoForm(state.base, session);
      const changed = changedKeys(before, after);
      return {
        ...state,
        session,
        sessionKeys: appliedKeys(after, session),
        flashSeq: bump(state.flashSeq, changed),
        dirty: state.dirty || changed.length > 0,
      };
    }

    case 'session_commit': {
      const session = action.fields ? { ...state.session, ...action.fields } : state.session;
      const merged = mergeIntoForm(state.base, session);
      const changed = changedKeys(selectValues(state), merged);
      return {
        ...state,
        base: merged,
        session: {},
        sessionKeys: appliedKeys(merged, session),
        flashSeq: bump(state.flashSeq, changed),
        dirty: state.dirty || changed.length > 0,
      };
    }

    case 'edit': {
      const fv: FieldValue = userFieldValue(action.key, action.value);
      const base = { ...state.base, [action.key]: fv };
      const session = { ...state.session };
      delete session[action.key];
      return {
        ...state,
        base,
        session,
        sessionKeys: state.sessionKeys.filter((k) => k !== action.key),
        dirty: true,
      };
    }

    case 'confirm': {
      const current = selectValues(state)[action.key];
      if (!current) return state;
      const confirmed = confirmFieldValue(current);
      if (confirmed === current) return state;
      const session = { ...state.session };
      delete session[action.key];
      return { ...state, base: { ...state.base, [action.key]: confirmed }, session, dirty: true };
    }

    case 'saved':
      return state.dirty ? { ...state, dirty: false } : state;
  }
}
