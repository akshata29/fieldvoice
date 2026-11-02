import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/cn';
import type { IconComponent } from './Button';

export interface TabItem {
  id: string;
  label: ReactNode;
  /** When set the tab is a route link (deep-linkable); otherwise it is a button driven by `value`/`onChange`. */
  to?: string;
  disabled?: boolean;
  count?: number;
  icon?: IconComponent;
}

const tabBase =
  'relative inline-flex min-h-tap items-center gap-2 whitespace-nowrap border-b-4 px-4 text-base font-semibold transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-brand-300';
const tabIdle = 'border-transparent text-muted hover:border-slate-300 hover:text-ink';
const tabActive = 'border-brand-600 text-brand-800 field:border-black field:text-black';

function TabContent({ item }: { item: TabItem }) {
  const Icon = item.icon;
  return (
    <>
      {Icon ? <Icon className="h-5 w-5" aria-hidden="true" /> : null}
      {item.label}
      {typeof item.count === 'number' ? (
        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-bold tabular-nums text-slate-700">{item.count}</span>
      ) : null}
    </>
  );
}

export function Tabs({
  items,
  value,
  onChange,
  className,
  label,
}: {
  items: TabItem[];
  value?: string;
  onChange?: (id: string) => void;
  className?: string;
  label: string;
}) {
  const linkMode = items.some((i) => i.to);
  if (linkMode) {
    return (
      <nav aria-label={label} className={cn('scroll-thin -mb-px flex overflow-x-auto border-b border-line', className)}>
        {items.map((item) =>
          item.to && !item.disabled ? (
            <NavLink key={item.id} to={item.to} end className={({ isActive }) => cn(tabBase, isActive ? tabActive : tabIdle)}>
              <TabContent item={item} />
            </NavLink>
          ) : (
            <span key={item.id} className={cn(tabBase, 'cursor-not-allowed border-transparent text-slate-400')} aria-disabled="true">
              <TabContent item={item} />
            </span>
          ),
        )}
      </nav>
    );
  }
  return (
    <div role="tablist" aria-label={label} className={cn('scroll-thin flex overflow-x-auto border-b border-line', className)}>
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={item.disabled}
            onClick={() => onChange?.(item.id)}
            className={cn(tabBase, selected ? tabActive : tabIdle, item.disabled && 'cursor-not-allowed opacity-50')}
          >
            <TabContent item={item} />
          </button>
        );
      })}
    </div>
  );
}
