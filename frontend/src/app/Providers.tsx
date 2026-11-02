import { useRef, useState, type ReactNode } from 'react';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toApiError } from '@/api/errors';
import { FieldModeProvider } from '@/hooks/useFieldMode';
import { ToastProvider, useToast } from '@/components/ui/Toast';

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: { silent?: boolean };
  }
}

/** Mutation failures surface as toasts unless the mutation opts out with `meta: { silent: true }`. */
function QueryBoundary({ children }: { children: ReactNode }) {
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 2000 },
          mutations: { retry: 0 },
        },
        mutationCache: new MutationCache({
          onError: (error, _variables, _context, mutation) => {
            if (mutation.options.meta?.silent) return;
            const e = toApiError(error);
            if (e.code === 'offline') toastRef.current.warn('You are offline', e.message);
            else if (e.code === 'unauthenticated') toastRef.current.warn('Sign in first', e.message);
            else toastRef.current.error('That did not work', e.message);
          },
        }),
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <FieldModeProvider>
      <ToastProvider>
        <QueryBoundary>{children}</QueryBoundary>
      </ToastProvider>
    </FieldModeProvider>
  );
}
