import { useRef } from 'react';
import { MicrophoneIcon, StopIcon } from '@heroicons/react/24/solid';
import { cn } from '@/lib/cn';
import { Spinner } from '@/components/ui/Spinner';
import type { VoicePhase } from '@/lib/voiceSession';

/** Press and hold for longer than this and releasing the button stops recording (walkie-talkie style). */
export const HOLD_MS = 450;

export interface RecordButtonProps {
  phase: VoicePhase;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
}

/**
 * Tap to start, tap again to stop - or press and hold, speak, release. Pointer events cover mouse, pen and touch;
 * keyboard activation arrives as a click with detail === 0 (Enter / Space).
 */
export function RecordButton({ phase, disabled, onStart, onStop }: RecordButtonProps) {
  const recording = phase === 'listening' || phase === 'connecting';
  const busy = phase === 'processing';
  const downAt = useRef<number | null>(null);
  const startedOnDown = useRef(false);

  const release = () => {
    if (downAt.current === null) return;
    const held = performance.now() - downAt.current;
    downAt.current = null;
    if (startedOnDown.current) {
      startedOnDown.current = false;
      if (held >= HOLD_MS) onStop(); // hold-to-talk: letting go ends the utterance
    } else onStop(); // a tap while recording stops it
  };

  return (
    <button
      type="button"
      disabled={disabled || busy}
      aria-pressed={recording}
      aria-label={recording ? 'Stop recording' : busy ? 'Processing' : 'Start recording'}
      onPointerDown={(e) => {
        if (disabled || busy || e.button > 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        downAt.current = performance.now();
        if (!recording) {
          startedOnDown.current = true;
          onStart();
        }
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onClick={(e) => {
        if (e.detail !== 0) return; // pointer clicks were handled above
        if (recording) onStop();
        else if (!busy && !disabled) onStart();
      }}
      onContextMenu={(e) => e.preventDefault()}
      style={{ touchAction: 'none', WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
      className={cn(
        'relative flex h-28 w-28 shrink-0 items-center justify-center rounded-full text-white shadow-lg transition-colors',
        'focus-visible:outline-none focus-visible:ring-8 focus-visible:ring-brand-300 disabled:cursor-not-allowed disabled:opacity-60',
        'field:h-32 field:w-32 field:border-4 field:border-black',
        recording ? 'bg-red-600 hover:bg-red-700' : busy ? 'bg-slate-500' : 'bg-brand-600 hover:bg-brand-700 active:bg-brand-800',
      )}
    >
      {recording ? <span className="absolute inset-0 animate-pulse-ring rounded-full" aria-hidden="true" /> : null}
      {busy ? <Spinner className="h-10 w-10" /> : recording ? <StopIcon className="h-12 w-12" aria-hidden="true" /> : <MicrophoneIcon className="h-12 w-12" aria-hidden="true" />}
    </button>
  );
}
