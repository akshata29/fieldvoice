import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircleIcon, ExclamationTriangleIcon, InformationCircleIcon, XCircleIcon, XMarkIcon } from '@heroicons/react/24/solid';
import { cn } from '@/lib/cn';

export type ToastTone = 'success' | 'error' | 'info' | 'warn';

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
}

export interface ToastApi {
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
  warn: (title: string, message?: string) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const toneStyles: Record<ToastTone, { icon: typeof CheckCircleIcon; box: string; iconClass: string }> = {
  success: { icon: CheckCircleIcon, box: 'border-emerald-300', iconClass: 'text-emerald-600' },
  error: { icon: XCircleIcon, box: 'border-red-300', iconClass: 'text-red-600' },
  info: { icon: InformationCircleIcon, box: 'border-sky-300', iconClass: 'text-sky-600' },
  warn: { icon: ExclamationTriangleIcon, box: 'border-amber-400', iconClass: 'text-amber-600' },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((prev) => prev.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (tone: ToastTone, title: string, message?: string) => {
      const id = nextId.current++;
      setItems((prev) => [...prev.slice(-3), { id, tone, title, message }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 9000 : 5000);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (t, m) => push('success', t, m),
      error: (t, m) => push('error', t, m),
      info: (t, m) => push('info', t, m),
      warn: (t, m) => push('warn', t, m),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-3 lg:inset-x-auto lg:bottom-4 lg:right-4 lg:items-end"
        aria-live="polite"
        aria-relevant="additions"
      >
        {items.map((t) => {
          const s = toneStyles[t.tone];
          const Icon = s.icon;
          return (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : 'status'}
              className={cn(
                'pointer-events-auto flex w-full max-w-md animate-slide-up items-start gap-3 rounded-xl border bg-surface px-4 py-3 shadow-pop field:border-2 field:border-black',
                s.box,
              )}
            >
              <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', s.iconClass)} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">{t.title}</p>
                {t.message ? <p className="mt-0.5 break-words text-sm text-muted">{t.message}</p> : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="-m-1 rounded-md p-1 text-muted hover:bg-slate-100 hover:text-ink"
                aria-label="Dismiss notification"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
