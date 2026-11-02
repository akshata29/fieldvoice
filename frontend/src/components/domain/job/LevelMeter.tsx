import { cn } from '@/lib/cn';

const SEGMENTS = 18;

/** Segmented input level meter (0..1). Decorative for assistive tech except for the numeric meter role. */
export function LevelMeter({ level, active, className }: { level: number; active: boolean; className?: string }) {
  const lit = active ? Math.round(Math.max(0, Math.min(1, level)) * SEGMENTS) : 0;
  return (
    <div className={cn('flex items-end gap-[3px]', className)} role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
      {Array.from({ length: SEGMENTS }, (_, i) => {
        const on = i < lit;
        const tone = i < SEGMENTS * 0.6 ? 'bg-emerald-500' : i < SEGMENTS * 0.85 ? 'bg-amber-400' : 'bg-red-500';
        return <span key={i} className={cn('w-1.5 rounded-sm transition-colors duration-75', on ? tone : 'bg-slate-200 field:bg-slate-300')} style={{ height: `${10 + (i / SEGMENTS) * 20}px` }} />;
      })}
    </div>
  );
}
