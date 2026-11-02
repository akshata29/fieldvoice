/**
 * Typed client for the live-capture WebSocket (`/ws/voice`, docs/CONTRACT.md section 7).
 *   client -> server: text {start|stop|play_sample|cancel}, binary PCM16 LE mono @ 16 kHz
 *   server -> client: JSON {ready|partial|transcript|stage|fields|result|error}
 * `VoiceTransport` is the seam the mock replays (src/mocks/mockVoiceSocket.ts).
 */
import type { FieldValue, VoiceClientMessage, VoiceServerEvent } from '@/api/types';
import { USE_MOCKS } from '@/lib/env';
import { toArrayBuffer } from '@/lib/audio/resample';

export type VoiceEventHandler = (event: VoiceServerEvent) => void;
export interface VoiceCloseInfo {
  /** True when we closed it ourselves or the server closed it normally. */
  clean: boolean;
  reason: string;
}
export type VoiceCloseHandler = (info: VoiceCloseInfo) => void;

export interface VoiceTransport {
  readonly kind: 'ws' | 'mock';
  connect(): Promise<void>;
  send(message: VoiceClientMessage): void;
  sendAudio(pcm: Int16Array): void;
  onEvent(handler: VoiceEventHandler): () => void;
  onClose(handler: VoiceCloseHandler): () => void;
  close(): void;
}

const SERVER_EVENT_TYPES = new Set(['ready', 'partial', 'transcript', 'stage', 'fields', 'result', 'error']);

/** Parses and sanity-checks one server frame; unknown / malformed frames return null instead of throwing. */
export function parseServerEvent(raw: string): VoiceServerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string' || !SERVER_EVENT_TYPES.has(type)) return null;
  const e = value as Record<string, unknown>;
  switch (type) {
    case 'partial':
      if (typeof e.text !== 'string') return null;
      return { type: 'partial', text: e.text, t_ms: typeof e.t_ms === 'number' ? e.t_ms : 0 };
    case 'transcript':
      if (typeof e.text !== 'string') return null;
      return {
        type: 'transcript',
        text: e.text,
        final: true,
        stt_ms: typeof e.stt_ms === 'number' ? e.stt_ms : 0,
        audio_ms: typeof e.audio_ms === 'number' ? e.audio_ms : 0,
      };
    case 'stage':
      if (typeof e.stage !== 'string' || typeof e.ms !== 'number') return null;
      return value as VoiceServerEvent;
    case 'fields':
      if (typeof e.fields !== 'object' || e.fields === null) return null;
      return {
        type: 'fields',
        stage: e.stage as 'resolve' | 'llm' | 'validate',
        fields: e.fields as Record<string, FieldValue>,
        unresolved: Array.isArray(e.unresolved) ? (e.unresolved as string[]) : [],
      };
    case 'result':
      if (typeof e.result !== 'object' || e.result === null) return null;
      return value as VoiceServerEvent;
    case 'error':
      return { type: 'error', message: typeof e.message === 'string' ? e.message : 'Unknown server error' };
    default:
      return { type: 'ready' };
  }
}

export function voiceSocketUrl(location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws/voice`;
}

export class VoiceSocket implements VoiceTransport {
  readonly kind = 'ws' as const;
  private socket: WebSocket | null = null;
  private readonly eventHandlers = new Set<VoiceEventHandler>();
  private readonly closeHandlers = new Set<VoiceCloseHandler>();
  private closedByUs = false;

  constructor(
    private readonly url: string = voiceSocketUrl(),
    private readonly connectTimeoutMs = 8000,
  ) {}

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.url);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.closedByUs = true;
        socket.close();
        reject(new Error('Timed out connecting to the voice service.'));
      }, this.connectTimeoutMs);

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('Could not connect to the voice service (is the backend running?).'));
      };
      socket.onmessage = (message: MessageEvent<unknown>) => {
        if (typeof message.data !== 'string') return;
        const event = parseServerEvent(message.data);
        if (event) this.eventHandlers.forEach((h) => h(event));
      };
      socket.onclose = (ev: CloseEvent) => {
        clearTimeout(timer);
        const clean = this.closedByUs || ev.wasClean;
        this.closeHandlers.forEach((h) => h({ clean, reason: ev.reason || `closed (${ev.code})` }));
      };
    });
  }

  send(message: VoiceClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  sendAudio(pcm: Int16Array): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(toArrayBuffer(pcm));
  }

  onEvent(handler: VoiceEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onClose(handler: VoiceCloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): void {
    this.closedByUs = true;
    this.eventHandlers.clear();
    this.socket?.close();
    this.socket = null;
  }
}

/** Real WebSocket in normal builds; the scripted replay in mock mode (dynamic import keeps it out of production bundles). */
export async function createVoiceTransport(): Promise<VoiceTransport> {
  if (USE_MOCKS) {
    const { MockVoiceSocket } = await import('@/mocks/mockVoiceSocket');
    return new MockVoiceSocket();
  }
  return new VoiceSocket();
}
