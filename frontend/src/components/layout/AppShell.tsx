import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { SignalSlashIcon } from '@heroicons/react/24/solid';
import { useSystemStatus } from '@/hooks/queries';
import { LoadingBlock } from '@/components/ui/Feedback';
import { ErrorBoundary } from './ErrorBoundary';
import { Header } from './Header';
import { BottomNav, SideNav } from './Nav';

export function OfflineBanner() {
  const { data } = useSystemStatus();
  if (!data || data.connectivity.online) return null;
  return (
    <div role="status" className="border-b-2 border-amber-600 bg-amber-300 text-slate-950 field:border-black field:bg-amber-300">
      <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-2 text-sm font-semibold">
        <SignalSlashIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
        <span>
          Offline - working from local data
          <span className="ml-2 hidden font-normal sm:inline">
            Voice capture, review and "Approve &amp; save locally" all keep working; sync waits for a connection.
          </span>
        </span>
      </div>
    </div>
  );
}

export function AppShell() {
  const location = useLocation();
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:font-semibold focus:shadow-pop">
        Skip to content
      </a>
      <Header />
      <OfflineBanner />
      <div className="flex">
        <SideNav />
        <main id="main" className="min-w-0 flex-1 px-3 pb-28 pt-5 sm:px-5 lg:pb-10">
          <div className="mx-auto max-w-[1500px]">
            <ErrorBoundary key={location.pathname}>
              <Suspense fallback={<LoadingBlock label="Loading screen..." />}>
                <Outlet />
              </Suspense>
            </ErrorBoundary>
          </div>
        </main>
      </div>
      <BottomNav />
    </div>
  );
}
