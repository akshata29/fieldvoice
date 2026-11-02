import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { IconComponent } from './Button';

export type BadgeTone = 'gray' | 'green' | 'amber' | 'red' | 'blue' | 'violet' | 'brand' | 'dark';

const tones: Record<BadgeTone, string> = {
  gray: 'bg-slate-100 text-slate-700 ring-slate-300',
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  amber: 'bg-amber-50 text-amber-900 ring-amber-400',
  red: 'bg-red-50 text-red-800 ring-red-300',
  blue: 'bg-sky-50 text-sky-800 ring-sky-300',
  violet: 'bg-violet-50 text-violet-800 ring-violet-300',
  brand: 'bg-brand-50 text-brand-800 ring-brand-300',
  dark: 'bg-slate-800 text-white ring-slate-800',
};

export interface BadgeProps {
  tone?: BadgeTone;
  icon?: IconComponent;
  dot?: boolean;
  size?: 'sm' | 'md';
  title?: string;
  className?: string;
  children: ReactNode;
}

export function Badge({ tone = 'gray', icon: Icon, dot, size = 'md', title, className, children }: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full font-medium ring-1 ring-inset field:font-bold field:ring-2 field:ring-current',
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm',
        tones[tone],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" /> : null}
      {Icon ? <Icon className={cn('shrink-0', size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4')} aria-hidden="true" /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}
