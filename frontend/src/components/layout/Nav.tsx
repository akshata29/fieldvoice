import { NavLink } from 'react-router-dom';
import {
  BeakerIcon,
  ChartBarSquareIcon,
  ClipboardDocumentListIcon,
  CpuChipIcon,
  InformationCircleIcon,
  SunIcon,
  ArrowsRightLeftIcon,
} from '@heroicons/react/24/outline';
import {
  BeakerIcon as BeakerSolid,
  ChartBarSquareIcon as ChartSolid,
  ClipboardDocumentListIcon as ClipboardSolid,
  CpuChipIcon as CpuSolid,
  InformationCircleIcon as InfoSolid,
  SunIcon as SunSolid,
  ArrowsRightLeftIcon as ArrowsSolid,
} from '@heroicons/react/24/solid';
import { cn } from '@/lib/cn';
import { useOutbox } from '@/hooks/queries';
import type { IconComponent } from '@/components/ui/Button';

interface NavItem {
  to: string;
  label: string;
  icon: IconComponent;
  activeIcon: IconComponent;
  end?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Today', icon: ClipboardDocumentListIcon, activeIcon: ClipboardSolid, end: true },
  { to: '/morning', label: 'Morning', icon: SunIcon, activeIcon: SunSolid },
  { to: '/sync', label: 'Sync', icon: ArrowsRightLeftIcon, activeIcon: ArrowsSolid },
  { to: '/lab', label: 'Lab', icon: BeakerIcon, activeIcon: BeakerSolid },
  { to: '/results', label: 'Results', icon: ChartBarSquareIcon, activeIcon: ChartSolid },
  { to: '/models', label: 'Models', icon: CpuChipIcon, activeIcon: CpuSolid },
  { to: '/about', label: 'About', icon: InformationCircleIcon, activeIcon: InfoSolid },
];

/** Items still waiting to reach the system of record: the number the worker cares about. */
function useUnsyncedCount(): number {
  const { data } = useOutbox();
  return data?.filter((i) => i.state !== 'synced').length ?? 0;
}

function CountBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn('flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-400 px-1.5 text-xs font-bold tabular-nums text-slate-900', className)}
      aria-label={`${count} waiting to sync`}
    >
      {count}
    </span>
  );
}

export function SideNav() {
  const unsynced = useUnsyncedCount();
  return (
    <nav
      aria-label="Main"
      className="sticky top-14 hidden h-[calc(100vh-3.5rem)] shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-surface p-2 lg:flex lg:w-[4.5rem] xl:w-56 xl:p-3 field:border-r-2"
    >
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          title={item.label}
          className={({ isActive }) =>
            cn(
              'group relative flex min-h-tap items-center justify-center gap-3 rounded-xl px-3 text-base font-semibold transition-colors xl:justify-start',
              isActive ? 'bg-brand-600 text-white field:bg-black' : 'text-ink hover:bg-slate-100',
            )
          }
        >
          {({ isActive }) => {
            const Icon = isActive ? item.activeIcon : item.icon;
            return (
              <>
                <Icon className="h-6 w-6 shrink-0" aria-hidden="true" />
                <span className="hidden xl:inline">{item.label}</span>
                {item.to === '/sync' ? <CountBadge count={unsynced} className="absolute right-1 top-1 xl:static xl:ml-auto" /> : null}
              </>
            );
          }}
        </NavLink>
      ))}
    </nav>
  );
}

export function BottomNav() {
  const unsynced = useUnsyncedCount();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] shadow-[0_-2px_8px_rgb(15_23_42/0.08)] lg:hidden field:border-t-2"
    >
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              'relative flex min-h-[3.75rem] flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[0.7rem] font-semibold leading-tight transition-colors',
              isActive ? 'text-brand-700 field:bg-black field:text-white' : 'text-muted hover:text-ink',
            )
          }
        >
          {({ isActive }) => {
            const Icon = isActive ? item.activeIcon : item.icon;
            return (
              <>
                <span className="relative">
                  <Icon className="h-6 w-6" aria-hidden="true" />
                  {item.to === '/sync' ? <CountBadge count={unsynced} className="absolute -right-3 -top-1.5 h-4 min-w-4 px-1 text-[0.65rem]" /> : null}
                </span>
                {item.label}
              </>
            );
          }}
        </NavLink>
      ))}
    </nav>
  );
}
