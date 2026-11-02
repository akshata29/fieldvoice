import { useCallback, useMemo, useState, type HTMLAttributes, type ReactNode, type TdHTMLAttributes, type ThHTMLAttributes } from 'react';
import { ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/20/solid';
import { cn } from '@/lib/cn';

export function Table({ children, className, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="scroll-thin relative overflow-x-auto">
      <table className={cn('min-w-full border-separate border-spacing-0 text-left text-sm', className)} {...rest}>
        {children}
      </table>
    </div>
  );
}

export type SortDir = 'asc' | 'desc';

export interface ThProps extends Omit<ThHTMLAttributes<HTMLTableCellElement>, 'onClick'> {
  sortKey?: string;
  activeSort?: { key: string; dir: SortDir } | null;
  onSort?: (key: string) => void;
  align?: 'left' | 'right' | 'center';
  sticky?: boolean;
}

export function Th({ children, className, sortKey, activeSort, onSort, align = 'left', sticky, ...rest }: ThProps) {
  const active = sortKey && activeSort?.key === sortKey ? activeSort : null;
  const alignClass = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  const content: ReactNode =
    sortKey && onSort ? (
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          'inline-flex min-h-[36px] items-center gap-1 rounded px-1 font-semibold uppercase tracking-wide hover:text-ink field:min-h-[44px]',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        {children}
        {active ? (
          active.dir === 'asc' ? <ChevronUpIcon className="h-4 w-4" aria-hidden="true" /> : <ChevronDownIcon className="h-4 w-4" aria-hidden="true" />
        ) : (
          <ChevronDownIcon className="h-4 w-4 opacity-25" aria-hidden="true" />
        )}
      </button>
    ) : (
      children
    );
  return (
    <th
      scope="col"
      aria-sort={active ? (active.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      className={cn(
        'whitespace-nowrap border-b border-line bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted field:border-b-2 field:border-black field:bg-slate-100',
        alignClass,
        sticky && 'sticky left-0 z-10',
        className,
      )}
      {...rest}
    >
      {content}
    </th>
  );
}

export function Td({
  children,
  className,
  align = 'left',
  sticky,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' | 'center'; sticky?: boolean }) {
  return (
    <td
      className={cn(
        'border-b border-line/60 px-3 py-2.5 align-middle',
        align === 'right' ? 'text-right tabular-nums' : align === 'center' ? 'text-center' : 'text-left',
        sticky && 'sticky left-0 z-[1] bg-inherit',
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

export function Tr({
  children,
  className,
  selected,
  onClick,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & { selected?: boolean }) {
  return (
    <tr
      className={cn(
        'bg-surface transition-colors',
        onClick && 'cursor-pointer hover:bg-brand-50/60',
        selected && 'bg-brand-50 outline outline-2 -outline-offset-2 outline-brand-500',
        className,
      )}
      onClick={onClick}
      {...rest}
    >
      {children}
    </tr>
  );
}

type Accessor<T> = (row: T) => number | string | null | undefined;

/** Client-side sorting with null-last semantics. Clicking the active column flips the direction. */
export function useSort<T>(
  rows: T[],
  accessors: Record<string, Accessor<T>>,
  initial: { key: string; dir: SortDir } | null = null,
) {
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(initial);
  const toggle = useCallback((key: string) => {
    setSort((prev) => (prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
  }, []);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const get = accessors[sort.key];
    if (!get) return rows;
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      const missingA = va === null || va === undefined;
      const missingB = vb === null || vb === undefined;
      if (missingA || missingB) return missingA === missingB ? 0 : missingA ? 1 : -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * factor;
      return String(va).localeCompare(String(vb)) * factor;
    });
    // accessors are expected to be stable (module-level or memoised)
  }, [rows, sort]);
  return { sorted, sort, toggle, setSort };
}
