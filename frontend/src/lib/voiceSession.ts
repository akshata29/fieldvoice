/** Pure state machine for one live-capture session (mic or sample playback). Driven by WebSocket events. */
import type {
  ExtractionResult,
  FieldValue,
  VoiceServerEvent,
  VoiceStageName,
} from '@/api/types';

export type VoicePhase = 'idle' | 'connecting' | 'listening' | 'processing' | 'done' | 'error';
export type VoiceMode = 'mic' | 'sample';

export interface VoiceSessionState {
  phase: VoicePhase;
  mode: VoiceMode | null;
  /** Interim transcript; each `partial` replaces the previous one. */
  partial: string;
  transcript: { text: string; sttMs: number; audioMs: number } | null;
  stages: Array<{ stage: VoiceStageName; ms: number }>;
  /** Progressive snapshot: later stage events replace earlier ones by key. */
  fields: Record<string, FieldValue>;
  unresolved: string[];
  result: ExtractionResult | null;
  error: string | null;
  errorCode: string | null;
}

export const initialVoiceState: VoiceSessionState = {
  phase: 'idle',
  mode: null,
  partial: '',
  transcript: null,
  stages: [],
  fields: {},
  unresolved: [],
  result: null,
  error: null,
  errorCode: null,
};

export type VoiceAction =
  | { type: 'reset' }
  | { type: 'begin'; mode: VoiceMode }
  | { type: 'listening' }
  | { type: 'stop_requested' }
  | { type: 'event'; event: VoiceServerEvent }
  | { type: 'fail'; message: string; code?: string }
  | { type: 'closed'; reason: string }
  /** A non-streaming result (typed transcript / uploaded WAV) lands as if the stream had completed. */
  | { type: 'external_result'; result: ExtractionResult };

export function isBusy(phase: VoicePhase): boolean {
  return phase === 'connecting' || phase === 'listening' || phase === 'processing';
}

export function voiceReducer(state: VoiceSessionState, action: VoiceAction): VoiceSessionState {
  switch (action.type) {
    case 'reset':
      return initialVoiceState;

    case 'begin':
      return { ...initialVoiceState, phase: 'connecting', mode: action.mode };

    case 'listening':
      return state.phase === 'connecting' ? { ...state, phase: 'listening' } : state;

    case 'stop_requested':
      return state.phase === 'listening' || state.phase === 'connecting' ? { ...state, phase: 'processing' } : state;

    case 'fail':
      return { ...state, phase: 'error', error: action.message, errorCode: action.code ?? null };

    case 'closed':
      if (state.phase === 'done' || state.phase === 'idle' || state.phase === 'error') return state;
      return { ...state, phase: 'error', error: `Connection to the voice service closed (${action.reason}).`, errorCode: 'closed' };

    case 'external_result':
      return {
        ...initialVoiceState,
        phase: 'done',
        mode: null,
        transcript: {
          text: action.result.transcript_raw,
          sttMs: action.result.stt_ms ?? 0,
          audioMs: action.result.audio_ms ?? 0,
        },
        fields: action.result.fields,
        unresolved: action.result.unresolved,
        result: action.result,
      };

    case 'event':
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: VoiceSessionState, event: VoiceServerEvent): VoiceSessionState {
  switch (event.type) {
    case 'ready':
      return state.phase === 'connecting' ? { ...state, phase: 'listening' } : state;

    case 'partial':
      return state.phase === 'error' || state.phase === 'done' ? state : { ...state, partial: event.text };

    case 'transcript':
      return {
        ...state,
        phase: 'processing',
        partial: '',
        transcript: { text: event.text, sttMs: event.stt_ms, audioMs: event.audio_ms },
      };

    case 'stage': {
      const stages = state.stages.filter((s) => s.stage !== event.stage);
      stages.push({ stage: event.stage, ms: event.ms });
      return { ...state, phase: state.phase === 'listening' ? 'processing' : state.phase, stages };
    }

    case 'fields':
      return {
        ...state,
        phase: state.phase === 'listening' ? 'processing' : state.phase,
        fields: { ...state.fields, ...event.fields },
        unresolved: event.unresolved,
      };

    case 'result':
      return {
        ...state,
        phase: 'done',
        partial: '',
        result: event.result,
        // the result is authoritative: it carries the validated final field set
        fields: event.result.fields,
        unresolved: event.result.unresolved,
        transcript: state.transcript ?? {
          text: event.result.transcript_raw,
          sttMs: event.result.stt_ms ?? 0,
          audioMs: event.result.audio_ms ?? 0,
        },
      };

    case 'error':
      return { ...state, phase: 'error', error: event.message, errorCode: 'server' };
  }
}
