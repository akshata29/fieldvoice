/**
 * Microphone capture: getUserMedia -> AudioContext -> AudioWorkletNode (inline worklet via Blob URL; falls back to
 * ScriptProcessorNode on old Safari) -> mono Float32 -> resample to 16 kHz -> Int16 PCM frames of ~100 ms.
 * Permission and device problems surface as CaptureError with a stable `code` so the UI can explain them.
 */
import {
  Int16Framer,
  StreamingResampler,
  TARGET_SAMPLE_RATE,
  concatInt16,
  floatToInt16,
  levelFromRms,
  rms,
} from './resample';

export type CaptureErrorCode =
  | 'unsupported'
  | 'insecure_context'
  | 'permission_denied'
  | 'no_device'
  | 'busy'
  | 'unknown';

export class CaptureError extends Error {
  constructor(
    readonly code: CaptureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CaptureError';
  }
}

export interface MicSupport {
  supported: boolean;
  code?: CaptureErrorCode;
  reason?: string;
}

/** Cheap synchronous check (does not prompt for permission). */
export function micSupport(): MicSupport {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return { supported: false, code: 'unsupported', reason: 'No browser environment.' };
  }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    if (!window.isSecureContext) {
      return {
        supported: false,
        code: 'insecure_context',
        reason: 'The microphone needs a secure context (https:// or http://localhost). Use sample playback instead.',
      };
    }
    return { supported: false, code: 'unsupported', reason: 'This browser does not expose a microphone API.' };
  }
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return { supported: false, code: 'unsupported', reason: 'Web Audio is not available in this browser.' };
  return { supported: true };
}

export function describeCaptureError(error: unknown): CaptureError {
  if (error instanceof CaptureError) return error;
  const name = (error as { name?: string } | null)?.name ?? '';
  const message = (error as { message?: string } | null)?.message ?? String(error);
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return new CaptureError(
        'permission_denied',
        'Microphone permission was denied. Allow microphone access in the browser, or use "Play sample".',
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new CaptureError('no_device', 'No microphone was found on this device. Use "Play sample" or upload a WAV.');
    case 'NotReadableError':
    case 'AbortError':
      return new CaptureError('busy', 'The microphone is in use by another app or could not be started.');
    default:
      return new CaptureError('unknown', `Could not start the microphone: ${message}`);
  }
}

const WORKLET_NAME = 'fv-capture';
const WORKLET_SOURCE = `
class FvCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 2048;
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channels = input.length;
      const frames = input[0].length;
      for (let i = 0; i < frames; i++) {
        let v = 0;
        for (let c = 0; c < channels; c++) v += input[c][i];
        this.buf[this.n++] = v / channels;
        if (this.n === this.size) {
          const out = this.buf.slice(0);
          this.port.postMessage(out, [out.buffer]);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', FvCapture);
`;

export interface CaptureOptions {
  /** Frame size handed to onFrame, in ms of 16 kHz audio. Default 100. */
  frameMs?: number;
  /** Keep every emitted sample so stop() can return the whole recording (for WAV upload). */
  retain?: boolean;
}

export interface CaptureCallbacks {
  onFrame: (pcm: Int16Array) => void;
  onLevel?: (level: number) => void;
}

export class AudioCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private resampler: StreamingResampler | null = null;
  private framer: Int16Framer;
  private retained: Int16Array[] = [];
  private active = false;

  constructor(
    private readonly callbacks: CaptureCallbacks,
    private readonly options: CaptureOptions = {},
  ) {
    this.framer = new Int16Framer(Math.round((TARGET_SAMPLE_RATE * (options.frameMs ?? 100)) / 1000));
  }

  get running(): boolean {
    return this.active;
  }

  async start(): Promise<void> {
    if (this.active) return;
    const support = micSupport();
    if (!support.supported) throw new CaptureError(support.code ?? 'unsupported', support.reason ?? 'Microphone unavailable.');

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      throw describeCaptureError(error);
    }

    try {
      const Ctx =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const context = new Ctx({ latencyHint: 'interactive' });
      if (context.state === 'suspended') await context.resume();
      this.context = context;
      this.stream = stream;
      this.resampler = new StreamingResampler(context.sampleRate, TARGET_SAMPLE_RATE);
      this.retained = [];
      this.source = context.createMediaStreamSource(stream);
      this.sink = context.createGain();
      this.sink.gain.value = 0; // keeps the graph pulling without playing the microphone back
      this.sink.connect(context.destination);

      if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
        try {
          await context.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        const node = new AudioWorkletNode(context, WORKLET_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        node.port.onmessage = (event: MessageEvent<Float32Array>) => this.handleSamples(event.data);
        this.node = node;
      } else {
        const node = context.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (event) => this.handleSamples(new Float32Array(event.inputBuffer.getChannelData(0)));
        this.node = node;
      }
      this.source.connect(this.node);
      this.node.connect(this.sink);
      this.active = true;
    } catch (error) {
      this.teardown();
      throw describeCaptureError(error);
    }
  }

  /** Stops capture, flushes the last partial frame and returns the retained recording (empty unless `retain`). */
  async stop(): Promise<Int16Array> {
    if (!this.active && !this.stream) return concatInt16(this.retained);
    this.active = false;
    const tail = this.framer.flush();
    if (tail && tail.length > 0) this.emit(tail);
    this.teardown();
    this.callbacks.onLevel?.(0);
    return concatInt16(this.retained);
  }

  private handleSamples(samples: Float32Array): void {
    if (!this.active || !this.resampler) return;
    this.callbacks.onLevel?.(levelFromRms(rms(samples)));
    const resampled = this.resampler.process(samples);
    if (resampled.length === 0) return;
    for (const frame of this.framer.push(floatToInt16(resampled))) this.emit(frame);
  }

  private emit(frame: Int16Array): void {
    if (this.options.retain) this.retained.push(frame);
    this.callbacks.onFrame(frame);
  }

  private teardown(): void {
    try {
      if (this.node) {
        if ('port' in this.node) this.node.port.onmessage = null;
        else this.node.onaudioprocess = null;
        this.node.disconnect();
      }
      this.source?.disconnect();
      this.sink?.disconnect();
    } catch {
      /* graph already torn down */
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => undefined);
    this.node = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
    this.context = null;
    this.resampler = null;
  }
}
