import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpTrayIcon, MicrophoneIcon, StopIcon, TrashIcon } from '@heroicons/react/24/solid';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Feedback';
import { AudioCapture, describeCaptureError, micSupport } from '@/lib/audio/capture';
import { parseWavHeader, wavBlob, wavWarnings } from '@/lib/audio/wav';
import { fmtDuration } from '@/lib/format';
import { LevelMeter } from './job/LevelMeter';

export interface AudioClip {
  blob: Blob;
  name: string;
  durationMs: number;
  warnings: string[];
}

/** Record from the microphone (kept as a 16 kHz WAV) or upload a WAV file; used as the audio source of the Lab. */
export function AudioSource({ clip, onChange }: { clip: AudioClip | null; onChange: (clip: AudioClip | null) => void }) {
  const mic = useMemo(() => micSupport(), []);
  const captureRef = useRef<AudioCapture | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [recording]);
  useEffect(
    () => () => {
      void captureRef.current?.stop();
    },
    [],
  );

  const previewUrl = useMemo(() => (clip ? URL.createObjectURL(clip.blob) : null), [clip]);
  useEffect(() => () => (previewUrl ? URL.revokeObjectURL(previewUrl) : undefined), [previewUrl]);

  const start = async () => {
    setError(null);
    const capture = new AudioCapture({ onFrame: () => undefined, onLevel: setLevel }, { retain: true });
    try {
      await capture.start();
      captureRef.current = capture;
      setStartedAt(Date.now());
      setRecording(true);
    } catch (e) {
      setError(describeCaptureError(e).message);
    }
  };

  const stop = async () => {
    const capture = captureRef.current;
    captureRef.current = null;
    setRecording(false);
    if (!capture) return;
    const pcm = await capture.stop();
    setLevel(0);
    if (pcm.length === 0) {
      setError('Nothing was recorded.');
      return;
    }
    onChange({ blob: wavBlob(pcm, 16000), name: 'recording.wav', durationMs: (pcm.length / 16000) * 1000, warnings: [] });
  };

  const upload = async (file: File) => {
    setError(null);
    try {
      const info = parseWavHeader(await file.arrayBuffer());
      onChange({ blob: file, name: file.name, durationMs: info.durationMs, warnings: wavWarnings(info) });
    } catch (e) {
      setError(`${file.name}: ${e instanceof Error ? e.message : 'not a WAV file'}`);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {recording ? (
          <Button variant="danger" icon={StopIcon} onClick={() => void stop()}>
            Stop ({fmtDuration(startedAt ? now - startedAt : 0)})
          </Button>
        ) : (
          <Button variant="primary" icon={MicrophoneIcon} disabled={!mic.supported} onClick={() => void start()} title={mic.reason}>
            Record
          </Button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".wav,audio/wav,audio/x-wav"
          className="sr-only"
          tabIndex={-1}
          aria-label="Upload a WAV file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }}
        />
        <Button icon={ArrowUpTrayIcon} disabled={recording} onClick={() => fileRef.current?.click()}>
          Upload WAV
        </Button>
        {clip ? (
          <Button variant="ghost" icon={TrashIcon} disabled={recording} onClick={() => onChange(null)}>
            Remove
          </Button>
        ) : null}
        {recording ? <LevelMeter level={level} active /> : null}
      </div>
      {!mic.supported ? <p className="text-xs text-muted">{mic.reason}</p> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {clip ? (
        <div className="space-y-1 rounded-lg bg-surface-2 p-3 text-sm field:border-2 field:border-black">
          <p className="font-medium text-ink">
            {clip.name} - {fmtDuration(clip.durationMs)}
          </p>
          {previewUrl ? <audio controls src={previewUrl} className="h-10 w-full" /> : null}
          {clip.warnings.map((w) => (
            <p key={w} className="text-xs text-amber-800">
              {w}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
