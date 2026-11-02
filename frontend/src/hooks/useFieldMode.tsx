import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useLocalStorage } from './useLocalStorage';

interface FieldModeValue {
  fieldMode: boolean;
  setFieldMode: (on: boolean) => void;
  toggle: () => void;
}

const FieldModeContext = createContext<FieldModeValue | null>(null);

/** Field mode = larger type, 52px targets, high contrast (see index.css). Persisted in localStorage. */
export function FieldModeProvider({ children }: { children: ReactNode }) {
  const [fieldMode, setFieldMode] = useLocalStorage<boolean>('fv.fieldMode', false);

  useEffect(() => {
    document.documentElement.dataset.fieldMode = fieldMode ? 'on' : 'off';
  }, [fieldMode]);

  const value = useMemo<FieldModeValue>(
    () => ({ fieldMode, setFieldMode: (on) => setFieldMode(on), toggle: () => setFieldMode((v) => !v) }),
    [fieldMode, setFieldMode],
  );
  return <FieldModeContext.Provider value={value}>{children}</FieldModeContext.Provider>;
}

export function useFieldMode(): FieldModeValue {
  const ctx = useContext(FieldModeContext);
  if (!ctx) throw new Error('useFieldMode must be used inside <FieldModeProvider>');
  return ctx;
}
