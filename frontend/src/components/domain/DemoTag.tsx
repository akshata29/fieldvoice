import { BeakerIcon } from '@heroicons/react/20/solid';
import { USE_MOCKS } from '@/lib/env';
import { cn } from '@/lib/cn';

/** Marks numbers that come from the mock backend. Renders nothing against a real backend. */
export function DemoTag({ className, label = 'demo data' }: { className?: string; label?: string }) {
  if (!USE_MOCKS) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-fuchsia-100 px-2 py-0.5 text-[0.7rem] font-semibold uppercase tracking-wide text-fuchsia-800 ring-1 ring-inset ring-fuchsia-300 field:ring-2',
        className,
      )}
      title="Mock mode: this value is simulated, not measured"
    >
      <BeakerIcon className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Page-level reminder shown above result screens in mock mode. */
export function DemoBanner({ children }: { children?: string }) {
  if (!USE_MOCKS) return null;
  return (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-fuchsia-300 bg-fuchsia-50 px-4 py-2.5 text-sm text-fuchsia-950 field:border-2 field:border-black field:bg-white field:text-black" role="note">
      <BeakerIcon className="mt-0.5 h-5 w-5 shrink-0 text-fuchsia-600" aria-hidden="true" />
      <p>
        <strong>Demo data.</strong>{' '}
        {children ?? 'Everything on this screen is simulated by the mock backend. Timings, accuracy and memory figures are not measurements.'}
      </p>
    </div>
  );
}
