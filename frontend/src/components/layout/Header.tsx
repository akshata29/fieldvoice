import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  CheckBadgeIcon,
  EyeIcon,
  MicrophoneIcon,
  SignalSlashIcon,
  UserCircleIcon,
  WifiIcon,
  BeakerIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/solid';
import { cn } from '@/lib/cn';
import { USE_MOCKS } from '@/lib/env';
import { initials } from '@/lib/format';
import { useFieldMode } from '@/hooks/useFieldMode';
import { useSetConnectivity, useSystemStatus } from '@/hooks/queries';
import { Spinner } from '@/components/ui/Spinner';
import { Tooltip, useDismiss } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';

const chip =
  'inline-flex min-h-[40px] items-center gap-2 rounded-full px-3 text-sm font-semibold ring-1 ring-inset transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300 field:min-h-[48px] field:ring-2';

export function ConnectivitySwitch() {
  const { data } = useSystemStatus();
  const mutation = useSetConnectivity();
  const toast = useToast();
  const online = data?.connectivity.online ?? true;
  const pending = mutation.isPending;

  const set = (next: boolean) => {
    if (next === online || pending) return;
    mutation.mutate(next, {
      onSuccess: () => toast.info(next ? 'Back online' : 'Airplane mode on', next ? 'Sync and downloads are available again.' : 'Working from local data only.'),
    });
  };

  const seg = (active: boolean, tone: string) =>
    cn(
      'flex min-h-[36px] items-center gap-1.5 rounded-full px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300 field:min-h-[44px]',
      active ? tone : 'text-slate-300 hover:bg-white/10',
    );

  return (
    <div
      role="radiogroup"
      aria-label="Device connectivity (airplane mode switch)"
      className="inline-flex items-center rounded-full bg-white/10 p-0.5 ring-1 ring-inset ring-white/20 field:ring-2 field:ring-white"
    >
      <button type="button" role="radio" aria-checked={online} onClick={() => set(true)} className={seg(online, 'bg-emerald-500 text-slate-950')} title="Online">
        {pending && !online ? <Spinner className="h-4 w-4" /> : <WifiIcon className="h-4 w-4" aria-hidden="true" />}
        <span className="hidden sm:inline">Online</span>
      </button>
      <button type="button" role="radio" aria-checked={!online} onClick={() => set(false)} className={seg(!online, 'bg-amber-400 text-slate-950')} title="Offline (airplane mode)">
        {pending && online ? <Spinner className="h-4 w-4" /> : <SignalSlashIcon className="h-4 w-4" aria-hidden="true" />}
        <span className="hidden sm:inline">Offline</span>
      </button>
    </div>
  );
}

export function ReadinessChip() {
  const { data, isError } = useSystemStatus();
  const overall = data?.readiness?.overall;
  const spec = (() => {
    if (isError) return { label: 'Backend unreachable', tone: 'bg-red-500/20 text-red-100 ring-red-300/50', Icon: ExclamationTriangleIcon, hint: 'The status endpoint is not responding.' };
    switch (overall) {
      case 'pass':
        return { label: 'Offline ready', tone: 'bg-emerald-500/20 text-emerald-100 ring-emerald-300/50', Icon: CheckBadgeIcon, hint: 'All readiness checks passed.' };
      case 'warn':
        return { label: 'Ready, warnings', tone: 'bg-amber-400/20 text-amber-100 ring-amber-300/60', Icon: ExclamationTriangleIcon, hint: 'Ready to go offline, but some checks have warnings.' };
      case 'fail':
        return { label: 'Not ready', tone: 'bg-red-500/20 text-red-100 ring-red-300/50', Icon: ExclamationTriangleIcon, hint: 'A readiness check failed. Open Morning to see which one.' };
      case 'running':
      case 'pending':
        return { label: 'Checking...', tone: 'bg-sky-500/20 text-sky-100 ring-sky-300/50', Icon: null, hint: 'Readiness checks are running.' };
      default:
        return { label: 'Not checked', tone: 'bg-white/10 text-slate-200 ring-white/25', Icon: CheckBadgeIcon, hint: 'Run Morning prep to check this device.' };
    }
  })();
  const Icon = spec.Icon;
  return (
    <Tooltip content={spec.hint} side="bottom" align="end">
      <Link to="/morning" className={cn(chip, spec.tone)} aria-label={`Readiness: ${spec.label}`}>
        {Icon ? <Icon className="h-4 w-4" aria-hidden="true" /> : <Spinner className="h-4 w-4" />}
        <span className="hidden whitespace-nowrap md:inline">{spec.label}</span>
      </Link>
    </Tooltip>
  );
}

export function WorkerChip() {
  const { data } = useSystemStatus();
  const session = data?.session ?? null;
  if (!session) {
    return (
      <Link to="/morning" className={cn(chip, 'bg-white/10 text-slate-100 ring-white/25 hover:bg-white/20')}>
        <UserCircleIcon className="h-5 w-5" aria-hidden="true" />
        <span className="whitespace-nowrap">Sign in</span>
      </Link>
    );
  }
  const w = session.worker;
  return (
    <Tooltip content={`${w.name} · ${w.role} · crew ${w.crew}${session.mode === 'offline_unlock' ? ' · unlocked offline' : ''}`} side="bottom" align="end">
      <Link to="/morning" className={cn(chip, 'bg-white/10 pl-1.5 text-slate-100 ring-white/25 hover:bg-white/20')} aria-label={`Signed in as ${w.name}`}>
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-500 text-xs font-bold text-white">{initials(w.name)}</span>
        <span className="hidden max-w-[9rem] truncate lg:inline">{w.name}</span>
      </Link>
    </Tooltip>
  );
}

export function FieldModeToggle() {
  const { fieldMode, toggle } = useFieldMode();
  return (
    <button
      type="button"
      aria-pressed={fieldMode}
      onClick={toggle}
      title="Field mode: larger type, bigger buttons, high contrast for sunlight"
      className={cn(
        chip,
        fieldMode ? 'bg-amber-300 text-black ring-black' : 'bg-white/10 text-slate-100 ring-white/25 hover:bg-white/20',
      )}
    >
      <EyeIcon className="h-5 w-5" aria-hidden="true" />
      <span className="hidden whitespace-nowrap sm:inline">Field mode</span>
    </button>
  );
}

/** Mock mode only: states that every number on screen is demo data, with shortcuts to reset / skip the morning flow. */
export function DemoBadge() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const toast = useToast();
  useDismiss(ref, open, () => setOpen(false));
  if (!USE_MOCKS) return null;

  const run = async (action: 'reset' | 'skip') => {
    setOpen(false);
    const controls = await import('@/mocks/controls');
    if (action === 'reset') controls.resetDemo();
    else controls.skipMorning();
    await qc.resetQueries();
    toast.info(action === 'reset' ? 'Demo state reset' : 'Morning prep skipped', action === 'reset' ? 'Back to a fresh device.' : 'Signed in, bundle downloaded, models ready.');
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(chip, 'bg-fuchsia-500/20 text-fuchsia-100 ring-fuchsia-300/60 hover:bg-fuchsia-500/30')}
        title="Mock mode: all numbers, timings and models are fabricated demo data, not measurements"
      >
        <BeakerIcon className="h-4 w-4" aria-hidden="true" />
        <span className="whitespace-nowrap">Demo data</span>
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 z-50 mt-2 w-72 rounded-xl border border-line bg-surface p-3 text-sm text-ink shadow-pop">
          <p className="mb-2 text-xs text-muted">
            Mock mode: no backend is running. Transcripts, timings, model sizes and run metrics are simulated and are <strong>not measurements</strong>.
          </p>
          <button role="menuitem" type="button" onClick={() => void run('skip')} className="flex min-h-tap w-full items-center rounded-lg px-3 text-left font-medium hover:bg-slate-100">
            Skip morning (sign in + bundle + ready)
          </button>
          <button role="menuitem" type="button" onClick={() => void run('reset')} className="flex min-h-tap w-full items-center rounded-lg px-3 text-left font-medium hover:bg-slate-100">
            Reset demo to a fresh device
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Header() {
  return (
    <header className="sticky top-0 z-40 bg-slate-900 text-white shadow-md field:border-b-4 field:border-amber-300">
      <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:px-4">
        <Link to="/" className="mr-auto flex min-h-[44px] items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300 field:min-h-[52px]">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 shadow-inner">
            <MicrophoneIcon className="h-5 w-5 text-white" aria-hidden="true" />
          </span>
          <span className="leading-tight">
            <span className="block text-base font-bold tracking-tight">Field Voice</span>
            <span className="hidden text-[0.7rem] font-medium uppercase tracking-wider text-slate-400 sm:block">Offline voice-to-form · Foundry Local</span>
          </span>
        </Link>
        <DemoBadge />
        <ConnectivitySwitch />
        <ReadinessChip />
        <WorkerChip />
        <FieldModeToggle />
      </div>
    </header>
  );
}
