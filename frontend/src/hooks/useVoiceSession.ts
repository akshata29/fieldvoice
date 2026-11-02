/**
 * Live capture session: microphone (or server-side sample playback) -> WebSocket -> progressive extraction events.
 * The hook owns the transport + AudioCapture lifecycles; the reducer in lib/voiceSession.ts owns the state.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ExtractionResult, FieldValue, VoiceServerEvent, VoiceStartMessage } from '@/api/types';
import { AudioCapture, CaptureError, micSupport, type MicSupport } from '@/lib/audio/capture';
import { createVoiceTransport, type VoiceTransport } from '@/lib/voiceSocket';
import { initialVoiceState, isBusy, voiceReducer, type VoiceSessionState } from '@/lib/voiceSession';

export interface VoiceParams {
  work_order_id: string | null;
  form_id: string | null;
  stt_engine_id: string;
  llm_engine_id: string;
  strategy_id: string;
}

export interface VoiceSessionHandlers {
  /** Fired for every progressive `fields` event (stage = resolve | llm | validate) and once more with the final set. */
  onFields?: (fields: Record<string, FieldValue>, stage: string) => void;
  onTranscript?: (text: string) => void;
  /** Fired once with the final result (streamed or from a non-streaming call). */
  onResult?: (result: ExtractionResult) => void;
  /** Fired when a new capture / playback begins. */
  onStart?: () => void;
}

const READY_TIMEOUT_MS = 6000;

export interface VoiceSessionApi {
  state: VoiceSessionState;
  /** 0..1 live input level (mic mode). */
  level: number;
  /** Epoch ms when the mic started; drives the elapsed timer. */
  recordingStartedAt: number | null;
  mic: MicSupport;
  busy: boolean;
  startRecording: (params: VoiceParams) => Promise<void>;
  stopRecording: () => Promise<void>;
  /** The server feeds a dataset sample through the same pipeline as if it came from the microphone. */
  playSample: (params: VoiceParams, sampleId: string, realtime: boolean) => Promise<void>;
  cancel: () => void;
  reset: () => void;
  /** Adopt a non-streaming result (typed transcript / uploaded WAV) as the current session outcome. */
  adoptResult: (result: ExtractionResult) => void;
}

const startMessage = (p: VoiceParams): VoiceStartMessage => ({
  type: 'start',
  work_order_id: p.work_order_id,
  form_id: p.form_id,
  stt_engine_id: p.stt_engine_id,
  llm_engine_id: p.llm_engine_id,
  strategy_id: p.strategy_id,
  sample_rate: 16000,
});

function waitForReady(transport: VoiceTransport): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('The voice service did not respond (no "ready" event).'));
    }, READY_TIMEOUT_MS);
    const off = transport.onEvent((e) => {
      if (e.type === 'ready') {
        clearTimeout(timer);
        off();
        resolve();
      } else if (e.type === 'error') {
        clearTimeout(timer);
        off();
        reject(new Error(e.message));
      }
    });
  });
}

export function useVoiceSession(handlers: VoiceSessionHandlers = {}): VoiceSessionApi {
  const [state, dispatch] = useReducer(voiceReducer, initialVoiceState);
  const [level, setLevel] = useState(0);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const transportRef = useRef<VoiceTransport | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const unsubscribeRef = useRef<Array<() => void>>([]);
  const lastLevelAt = useRef(0);
  /** The server has acknowledged `start` and the queued mic frames were flushed. */
  const readyRef = useRef(false);
  /** The user released the mic before the server was ready: send `stop` as soon as it is. */
  const stopAfterReadyRef = useRef(false);
  /** Bumped by every teardown so late async continuations of an abandoned session can detect they are stale. */
  const sessionSeq = useRef(0);

  const mic = useMemo(() => micSupport(), []);

  const releaseTransport = useCallback(() => {
    unsubscribeRef.current.forEach((u) => u());
    unsubscribeRef.current = [];
    transportRef.current?.close();
    transportRef.current = null;
  }, []);

  const releaseCapture = useCallback(() => {
    const capture = captureRef.current;
    captureRef.current = null;
    if (capture?.running) void capture.stop();
    setRecordingStartedAt(null);
    setLevel(0);
  }, []);

  const teardown = useCallback(() => {
    sessionSeq.current++;
    readyRef.current = false;
    stopAfterReadyRef.current = false;
    releaseTransport();
    releaseCapture();
  }, [releaseCapture, releaseTransport]);

  useEffect(() => teardown, [teardown]);

  const handleEvent = useCallback((event: VoiceServerEvent) => {
    dispatch({ type: 'event', event });
    const h = handlersRef.current;
    if (event.type === 'fields') h.onFields?.(event.fields, event.stage);
    else if (event.type === 'transcript') h.onTranscript?.(event.text);
    else if (event.type === 'result') {
      h.onFields?.(event.result.fields, 'result');
      h.onResult?.(event.result);
    }
  }, []);

  const connect = useCallback(
    async (seq: number): Promise<VoiceTransport> => {
      const transport = await createVoiceTransport();
      if (seq !== sessionSeq.current) {
        transport.close();
        throw new Error('superseded');
      }
      unsubscribeRef.current.push(transport.onEvent(handleEvent));
      unsubscribeRef.current.push(
        transport.onClose((info) => {
          if (seq === sessionSeq.current) dispatch({ type: 'closed', reason: info.reason });
        }),
      );
      await transport.connect();
      transportRef.current = transport;
      return transport;
    },
    [handleEvent],
  );

  const fail = useCallback(
    (seq: number, error: unknown) => {
      if (seq !== sessionSeq.current) return; // a newer session took over; stay quiet
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof CaptureError ? error.code : 'connection';
      teardown();
      dispatch({ type: 'fail', message, code });
    },
    [teardown],
  );

  const startRecording = useCallback(
    async (params: VoiceParams) => {
      teardown();
      const seq = sessionSeq.current;
      handlersRef.current.onStart?.();
      dispatch({ type: 'begin', mode: 'mic' });

      // Open the microphone first so the permission prompt does not race the socket; frames queue until `ready`.
      const queue: Int16Array[] = [];
      const capture = new AudioCapture(
        {
          onFrame: (pcm) => {
            if (readyRef.current && transportRef.current) transportRef.current.sendAudio(pcm);
            else queue.push(pcm);
          },
          onLevel: (v) => {
            const now = performance.now();
            if (v === 0 || now - lastLevelAt.current > 60) {
              lastLevelAt.current = now;
              setLevel(v);
            }
          },
        },
        { frameMs: 100 },
      );

      try {
        await capture.start();
        if (seq !== sessionSeq.current) {
          void capture.stop();
          return;
        }
        captureRef.current = capture;
        setRecordingStartedAt(Date.now());
        const transport = await connect(seq);
        const readyPromise = waitForReady(transport);
        transport.send(startMessage(params));
        await readyPromise;
        if (seq !== sessionSeq.current) return;
        for (const frame of queue.splice(0)) transport.sendAudio(frame);
        readyRef.current = true;
        if (stopAfterReadyRef.current) transport.send({ type: 'stop' });
      } catch (error) {
        void capture.stop();
        fail(seq, error);
      }
    },
    [connect, fail, teardown],
  );

  const stopRecording = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture) return;
    dispatch({ type: 'stop_requested' });
    await capture.stop();
    captureRef.current = null;
    setRecordingStartedAt(null);
    setLevel(0);
    if (readyRef.current) transportRef.current?.send({ type: 'stop' });
    else stopAfterReadyRef.current = true;
  }, []);

  const playSample = useCallback(
    async (params: VoiceParams, sampleId: string, realtime: boolean) => {
      teardown();
      const seq = sessionSeq.current;
      handlersRef.current.onStart?.();
      dispatch({ type: 'begin', mode: 'sample' });
      try {
        const transport = await connect(seq);
        const readyPromise = waitForReady(transport);
        transport.send(startMessage(params));
        await readyPromise;
        if (seq !== sessionSeq.current) return;
        transport.send({ type: 'play_sample', sample_id: sampleId, realtime });
      } catch (error) {
        fail(seq, error);
      }
    },
    [connect, fail, teardown],
  );

  const cancel = useCallback(() => {
    transportRef.current?.send({ type: 'cancel' });
    teardown();
    dispatch({ type: 'reset' });
  }, [teardown]);

  const reset = useCallback(() => {
    teardown();
    dispatch({ type: 'reset' });
  }, [teardown]);

  const adoptResult = useCallback((result: ExtractionResult) => {
    dispatch({ type: 'external_result', result });
    const h = handlersRef.current;
    h.onFields?.(result.fields, 'result');
    h.onResult?.(result);
  }, []);

  // The pipeline is finished: do not keep the socket (or a still-open microphone) around.
  useEffect(() => {
    if (state.phase === 'done' || state.phase === 'error') {
      releaseTransport();
      releaseCapture();
    }
  }, [state.phase, releaseCapture, releaseTransport]);

  return {
    state,
    level,
    recordingStartedAt,
    mic,
    busy: isBusy(state.phase),
    startRecording,
    stopRecording,
    playSample,
    cancel,
    reset,
    adoptResult,
  };
}
