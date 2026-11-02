import { cn } from '@/lib/cn';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function Primitive({ value }: { value: string | number | boolean | null }) {
  if (value === null) return <span className="text-slate-500">null</span>;
  if (typeof value === 'string') return <span className="break-all text-emerald-700">"{value}"</span>;
  if (typeof value === 'number') return <span className="text-sky-700">{value}</span>;
  return <span className="text-violet-700">{String(value)}</span>;
}

function Node({ name, value, depth }: { name?: string; value: Json; depth: number }) {
  const label = name !== undefined ? <span className="text-slate-700">{name}: </span> : null;
  if (value === null || typeof value !== 'object') {
    return (
      <div className="py-px pl-4">
        {label}
        <Primitive value={value as string | number | boolean | null} />
      </div>
    );
  }
  const entries: Array<[string, Json]> = Array.isArray(value) ? value.map((v, i): [string, Json] => [String(i), v]) : Object.entries(value);
  const open = Array.isArray(value) ? '[' : '{';
  const close = Array.isArray(value) ? ']' : '}';
  if (entries.length === 0) {
    return (
      <div className="py-px pl-4">
        {label}
        <span className="text-slate-500">
          {open}
          {close}
        </span>
      </div>
    );
  }
  return (
    <details open={depth < 1} className="group pl-1">
      <summary className="cursor-pointer list-none rounded px-1 py-px marker:hidden hover:bg-slate-100 [&::-webkit-details-marker]:hidden">
        <span className="mr-1 inline-block w-3 text-slate-400 transition-transform group-open:rotate-90">&#9656;</span>
        {label}
        <span className="text-slate-500">
          {open}
          <span className="group-open:hidden"> {entries.length} {Array.isArray(value) ? 'items' : 'keys'} </span>
          <span className="hidden group-open:inline"> </span>
          <span className="group-open:hidden">{close}</span>
        </span>
      </summary>
      <div className="ml-2 border-l border-slate-200 pl-2">
        {entries.map(([k, v]) => (
          <Node key={k} name={Array.isArray(value) ? undefined : k} value={v} depth={depth + 1} />
        ))}
        <div className="pl-3 text-slate-500">{close}</div>
      </div>
    </details>
  );
}

/** Read-only collapsible JSON tree (used for the dispatcher console's received completions). */
export function JsonView({ value, className }: { value: unknown; className?: string }) {
  return (
    <div className={cn('scroll-thin max-h-96 overflow-auto rounded-lg border border-line bg-slate-50 p-3 font-mono text-xs leading-5', className)}>
      <Node value={value as Json} depth={0} />
    </div>
  );
}
