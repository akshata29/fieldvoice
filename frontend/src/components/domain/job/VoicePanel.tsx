import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowUpTrayIcon,
  MicrophoneIcon,
  PlayIcon,
  StopIcon,
} from '@heroicons/react/24/solid';
import type { EngineInfo, EngineList, ExtractionResult, FieldSpec, FormSchema, SampleInfo, WorkOrder } from '@/api/types';
import { NO_LLM_ID, ORACLE_STT_ID } from '@/api/types';
import { samplesApi, voiceApi } from '@/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Checkbox, Select, Textarea } from '@/components/ui/Controls';
import { Alert } from '@/components/ui/Feedback';
import { Disclosure } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';
import { DemoTag } from '@/components/domain/DemoTag';
import { TimingWaterfall } from '@/components/domain/TimingWaterfall';
import { qk } from '@/hooks/queries';
import type { VoiceParams, VoiceSessionApi } from '@/hooks/useVoiceSession';
import { parseWavHeader, wavWarnings } from '@/lib/audio/wav';
import { engineName, strategyShort } from '@/lib/engineLabels';
import { fmtDuration, fmtMs } from '@/lib/format';
import type { EvidenceSpan } from '@/lib/evidence';
import { LevelMeter } from './LevelMeter';
import { RecordButton } from './RecordButton';
import { TranscriptView } from './TranscriptView';

export interface EngineSelection {
  stt: string;
  llm: string;
  strategy: string;
}

function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

function engineOption(e: EngineInfo) {
  const ready = e.availability === 'ready';
  const label = `${e.name}${e.supports_streaming ? ' (streaming)' : ''}${ready ? '' : ` - ${e.availability.replace('_', ' ')}`}`;
  return (
    <option key={e.id} value={e.id} disabled={!ready} title={e.availability_reason ?? undefined}>
      {label}
    </option>
  );
}

function EnginePicker({
  engines,
  selection,
  onChange,
  disabled,
}: {
  engines: EngineList | undefined;
  selection: EngineSelection;
  onChange: (next: EngineSelection) => void;
  disabled: boolean;
}) {
  if (!engines) return <p className="text-sm text-muted">Loading engines...</p>;
  const stt = engines.stt.find((e) => e.id === selection.stt);
  const llm = engines.llm.find((e) => e.id === selection.llm);
  const strategy = engines.strategies.find((s) => s.id === selection.strategy);
  const unready = [...engines.stt, ...engines.llm].filter((e) => e.availability !== 'ready').length;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold text-ink">Speech-to-text</span>
          <Select value={selection.stt} disabled={disabled} onChange={(e) => onChange({ ...selection, stt: e.target.value })}>
            {engines.stt.map(engineOption)}
          </Select>
          <span className="block text-xs text-muted">
            {stt?.id === ORACLE_STT_ID
              ? 'Reads the sample\'s reference text; it cannot hear the microphone.'
              : stt?.supports_streaming
                ? 'Streaming: words appear while you speak.'
                : 'Text appears after you stop speaking.'}
          </span>
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold text-ink">Language model</span>
          <Select value={selection.llm} disabled={disabled} onChange={(e) => onChange({ ...selection, llm: e.target.value })}>
            {engines.llm.map(engineOption)}
          </Select>
          <span className="block text-xs text-muted">{llm?.id === NO_LLM_ID ? 'Only the deterministic stages run.' : 'Used only for fields the rules cannot resolve (hybrid).'}</span>
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold text-ink">Strategy</span>
          <Select value={selection.strategy} disabled={disabled} onChange={(e) => onChange({ ...selection, strategy: e.target.value })}>
            {engines.strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <span className="block text-xs text-muted">{strategy?.description}</span>
        </label>
      </div>
      {unready > 0 ? <p className="text-xs text-muted">{unready} engines are greyed out (not downloaded or unavailable). The Models page explains why and lets you prepare them.</p> : null}
      {selection.strategy !== 'rules_only' && selection.strategy !== 'hybrid' && selection.llm === NO_LLM_ID ? (
        <Alert tone="warn">This strategy needs a language model. With "No LLM" nothing will be extracted.</Alert>
      ) : null}
    </div>
  );
}

export interface VoicePanelProps {
  workOrder: WorkOrder;
  form: FormSchema;
  voice: VoiceSessionApi;
  engines: EngineList | undefined;
  selection: EngineSelection;
  onSelectionChange: (next: EngineSelection) => void;
  locked: boolean;
  lastResult: ExtractionResult | null;
  spans: EvidenceSpan[];
  focusKey: string | null;
  fields: FieldSpec[];
  /** Called right before a non-streaming extraction (typed text / uploaded WAV) so the page can open a new session. */
  onExternalStart: () => void;
}

export function VoicePanel({ workOrder, form, voice, engines, selection, onSelectionChange, locked, lastResult, spans, focusKey, fields, onExternalStart }: VoicePanelProps) {
  const toast = useToast();
  const { state } = voice;
  const elapsed = useElapsed(voice.recordingStartedAt);
  const [showRaw, setShowRaw] = useState(false);
  const [sampleId, setSampleId] = useState('');
  const [realtime, setRealtime] = useState(true);
  const [typed, setTyped] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const samplesQ = useQuery({ queryKey: qk.samples(form.id, null), queryFn: () => samplesApi.list({ form_id: form.id, limit: 30 }), staleTime: 60_000 });
  const samples: SampleInfo[] = useMemo(() => samplesQ.data ?? [], [samplesQ.data]);
  useEffect(() => {
    if (!sampleId && samples[0]) setSampleId(samples[0].id);
  }, [samples, sampleId]);
  const sample = samples.find((s) => s.id === sampleId);

  const params: VoiceParams = {
    work_order_id: workOrder.id,
    form_id: form.id,
    stt_engine_id: selection.stt,
    llm_engine_id: selection.llm,
    strategy_id: selection.strategy,
  };

  const typedMutation = useMutation({
    mutationFn: (text: string) =>
      voiceApi.extract({ work_order_id: workOrder.id, transcript: text, stt_engine_id: ORACLE_STT_ID, llm_engine_id: selection.llm, strategy_id: selection.strategy }),
    onSuccess: (result) => voice.adoptResult(result),
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      try {
        const info = parseWavHeader(await file.arrayBuffer());
        const warnings = wavWarnings(info);
        if (warnings.length > 0) toast.warn('Unusual WAV file', warnings.join(' '));
      } catch (e) {
        throw new Error(`${file.name}: ${e instanceof Error ? e.message : 'not a WAV file'}`);
      }
      return voiceApi.extractAudio(file, params, file.name);
    },
    onSuccess: (result) => voice.adoptResult(result),
  });

  const sttEngine = engines?.stt.find((e) => e.id === selection.stt);
  const oracleSelected = selection.stt === ORACLE_STT_ID;
  const micBlocked = !voice.mic.supported;
  const recordDisabled = locked || micBlocked || oracleSelected || !engines;
  const externalBusy = typedMutation.isPending || uploadMutation.isPending;
  const phase = state.phase;

  const statusText: Record<typeof phase, string> = {
    idle: 'Tap to record, or press and hold.',
    connecting: 'Connecting...',
    listening: 'Listening... tap to stop (or release if you are holding).',
    processing: 'Transcribing and extracting...',
    done: 'Done. Review the form on the right.',
    error: 'Something went wrong.',
  };

  const transcriptRaw = state.transcript?.text ?? lastResult?.transcript_raw ?? '';
  const transcriptNorm = lastResult?.transcript_normalized ?? '';
  const differs = !!transcriptNorm && transcriptRaw.trim() !== '' && transcriptRaw.trim() !== transcriptNorm.trim();

  return (
    <Card>
      <CardHeader
        title="Voice"
        subtitle="Speak the work you did. Fields appear as they are recognised; you review and edit before approving."
        icon={<MicrophoneIcon className="h-6 w-6" aria-hidden="true" />}
        actions={<DemoTag label="simulated speech" />}
      />
      <CardBody className="space-y-4">
        <Disclosure
          title="Engines"
          summary={
            engines ? (
              <span className="hidden max-w-[16rem] truncate sm:inline">
                {engineName(selection.stt, engines.stt)} + {engineName(selection.llm, engines.llm)} / {strategyShort(selection.strategy)}
              </span>
            ) : null
          }
        >
          <EnginePicker engines={engines} selection={selection} onChange={onSelectionChange} disabled={voice.busy} />
        </Disclosure>

        {micBlocked ? (
          <Alert tone="warn" title="The microphone is not available here">
            {voice.mic.reason} You can still use <strong>Play sample</strong> or upload a WAV file below.
          </Alert>
        ) : null}
        {oracleSelected && !micBlocked ? (
          <Alert tone="info">The reference-transcript engine cannot hear the microphone. Pick a speech engine under "Engines" to record, or play a sample.</Alert>
        ) : null}
        {locked ? <Alert tone="info">This form is already approved, so capture is switched off.</Alert> : null}

        <div className="flex flex-wrap items-center gap-5">
          <RecordButton
            phase={phase}
            disabled={recordDisabled || externalBusy || (voice.busy && state.mode === 'sample')}
            onStart={() => void voice.startRecording(params)}
            onStop={() => void voice.stopRecording()}
          />
          <div className="min-w-[12rem] flex-1 space-y-2">
            <p className="text-base font-semibold text-ink" aria-live="polite">
              {statusText[phase]}
            </p>
            <div className="flex items-center gap-4">
              <LevelMeter level={voice.level} active={phase === 'listening' && state.mode === 'mic'} />
              <span className="font-mono text-lg tabular-nums text-ink" aria-label="Recording time">
                {fmtDuration(elapsed)}
              </span>
            </div>
            {voice.busy ? (
              <Button size="sm" variant="ghost" icon={StopIcon} onClick={voice.cancel}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>

        {phase === 'error' && state.error ? (
          <Alert tone="error" title="Voice capture failed" live actions={<Button size="sm" onClick={voice.reset}>Dismiss</Button>}>
            {state.error}
          </Alert>
        ) : null}

        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">Transcript</h3>
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
              {state.transcript ? (
                <span className="tabular-nums">
                  speech-to-text {fmtMs(state.transcript.sttMs)} for {fmtMs(state.transcript.audioMs)} of audio
                </span>
              ) : null}
              {differs ? (
                <label className="flex min-h-[32px] cursor-pointer items-center gap-1.5 field:min-h-[48px] field:text-base">
                  <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
                  raw engine text
                </label>
              ) : null}
            </span>
          </div>
          <TranscriptView
            partial={state.partial}
            raw={transcriptRaw}
            normalized={transcriptNorm}
            spans={spans}
            focusKey={focusKey}
            fields={fields}
            live={voice.busy}
            showRaw={showRaw}
            placeholder={sttEngine?.supports_streaming ? 'Live words will appear here while you speak.' : 'The transcript will appear here after you stop speaking.'}
          />
          {transcriptNorm && spans.length > 0 ? (
            <p className="text-xs text-muted">Hover or focus a field to highlight the words it came from.</p>
          ) : null}
        </div>

        <div className="space-y-2 rounded-xl border border-dashed border-line p-3 field:border-2 field:border-black">
          <h3 className="text-sm font-semibold text-ink">No microphone? Play a sample</h3>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <Select aria-label="Sample utterance" value={sampleId} disabled={voice.busy || samples.length === 0} onChange={(e) => setSampleId(e.target.value)}>
              {samples.length === 0 ? <option value="">{samplesQ.isLoading ? 'Loading samples...' : 'No samples for this form'}</option> : null}
              {samples.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} - {s.written_text.length > 58 ? `${s.written_text.slice(0, 58)}...` : s.written_text}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              icon={PlayIcon}
              disabled={!sampleId || voice.busy || locked || externalBusy || !engines}
              onClick={() => void voice.playSample(params, sampleId, realtime)}
            >
              Play sample
            </Button>
          </div>
          {sample ? (
            <div className="space-y-1 text-sm">
              <p className="text-muted">
                Spoken: <span className="italic text-ink">"{sample.spoken_text}"</span>
              </p>
              <p className="flex flex-wrap gap-1">
                {sample.tags.map((t) => (
                  <Badge key={t} tone="gray" size="sm">
                    {t}
                  </Badge>
                ))}
                <Badge tone={sample.split === 'heldout' ? 'violet' : 'gray'} size="sm">
                  {sample.split}
                </Badge>
              </p>
            </div>
          ) : null}
          <Checkbox checked={realtime} onChange={setRealtime} label="Play at speaking pace" description="Off = replay as fast as possible." />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".wav,audio/wav,audio/x-wav"
            className="sr-only"
            tabIndex={-1}
            aria-label="Upload a WAV file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              voice.reset();
              onExternalStart();
              uploadMutation.mutate(file);
            }}
          />
          <Button icon={ArrowUpTrayIcon} loading={uploadMutation.isPending} disabled={locked || voice.busy || typedMutation.isPending} onClick={() => fileRef.current?.click()}>
            Upload WAV
          </Button>
          <span className="text-xs text-muted">16 kHz mono PCM works best.</span>
        </div>
        {uploadMutation.isError ? <Alert tone="error">{uploadMutation.error.message}</Alert> : null}

        <Disclosure title="Type a transcript instead" summary="skips speech recognition">
          <div className="space-y-2">
            <Textarea aria-label="Transcript text" rows={3} placeholder="I replaced the transformer at pole 123. The old unit was leaking oil and I installed unit 456." value={typed} onChange={(e) => setTyped(e.target.value)} />
            <Button
              loading={typedMutation.isPending}
              disabled={!typed.trim() || locked || voice.busy || uploadMutation.isPending}
              onClick={() => {
                voice.reset();
                onExternalStart();
                typedMutation.mutate(typed);
              }}
            >
              Extract fields from text
            </Button>
            {typedMutation.isError ? <Alert tone="error">{typedMutation.error.message}</Alert> : null}
          </div>
        </Disclosure>

        {lastResult ? (
          <div className="space-y-3 border-t border-line/70 pt-4">
            <h3 className="text-sm font-semibold text-ink">Last extraction</h3>
            <TimingWaterfall timings={lastResult.timings} totalMs={lastResult.total_ms} audioMs={lastResult.audio_ms} promptTokens={lastResult.llm_prompt_tokens} outputTokens={lastResult.llm_output_tokens} />
            <p className="flex flex-wrap gap-1.5 text-xs">
              <Badge tone="blue" size="sm">
                {engineName(lastResult.stt_engine_id ?? ORACLE_STT_ID, engines?.stt)}
              </Badge>
              <Badge tone="violet" size="sm">
                {engineName(lastResult.llm_engine_id ?? NO_LLM_ID, engines?.llm)}
              </Badge>
              <Badge tone="gray" size="sm">
                {strategyShort(lastResult.strategy_id)}
              </Badge>
            </p>
            {lastResult.error ? (
              <Alert tone="error" title="The pipeline reported an error">
                {lastResult.error}
              </Alert>
            ) : null}
            {lastResult.warnings.length > 0 ? (
              <Alert tone="warn" title="Warnings">
                <ul className="list-disc pl-5">
                  {lastResult.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
