/**
 * Pure PCM helpers used by the microphone capture path: sample-rate conversion to 16 kHz, Float32 -> PCM16,
 * ~100 ms framing and a level meter. No browser APIs here so everything is unit-testable in Node.
 */

export const TARGET_SAMPLE_RATE = 16000;

/** Float32 [-1, 1] -> little-endian-ready Int16 (asymmetric scaling so +1.0 -> 32767 and -1.0 -> -32768). */
export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
  }
  return out;
}

export function int16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = input[i] ?? 0;
    out[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
  }
  return out;
}

export function rms(input: Float32Array): number {
  if (input.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    const v = input[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / input.length);
}

/** Maps an RMS amplitude to a 0..1 meter value on a dB scale (floorDb -> 0, 0 dBFS -> 1). */
export function levelFromRms(value: number, floorDb = -60): number {
  if (!(value > 0)) return 0;
  const db = 20 * Math.log10(value);
  return Math.max(0, Math.min(1, (db - floorDb) / -floorDb));
}

/**
 * Streaming sample-rate converter. Each output sample is the area-weighted average of the input interval it covers
 * (a box filter), which doubles as a cheap anti-alias filter when down-sampling 44.1/48 kHz microphones to 16 kHz.
 * State carries across chunks, so feeding arbitrary chunk sizes gives the same result as one big buffer.
 */
export class StreamingResampler {
  readonly ratio: number;
  private buffer: Float32Array = new Float32Array(0);
  private baseIndex = 0; // global input index of buffer[0]
  private nextOut = 0; // global index of the next output sample

  constructor(
    readonly inRate: number,
    readonly outRate: number = TARGET_SAMPLE_RATE,
  ) {
    if (!(inRate > 0) || !(outRate > 0)) throw new RangeError('sample rates must be positive');
    this.ratio = inRate / outRate;
  }

  process(chunk: Float32Array): Float32Array {
    if (this.inRate === this.outRate) return chunk.slice();
    if (chunk.length > 0) {
      const merged = new Float32Array(this.buffer.length + chunk.length);
      merged.set(this.buffer, 0);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
    }
    const out: number[] = [];
    const ratio = this.ratio;
    const available = this.baseIndex + this.buffer.length;
    for (;;) {
      const a = this.nextOut * ratio;
      const b = a + ratio;
      if (b > available + 1e-9) break;
      let sum = 0;
      const first = Math.floor(a);
      const last = Math.min(Math.ceil(b) - 1, available - 1);
      for (let i = first; i <= last; i++) {
        const lo = Math.max(a, i);
        const hi = Math.min(b, i + 1);
        if (hi > lo) sum += (this.buffer[i - this.baseIndex] ?? 0) * (hi - lo);
      }
      out.push(sum / ratio);
      this.nextOut++;
    }
    const keepFrom = Math.min(Math.floor(this.nextOut * ratio), available);
    if (keepFrom > this.baseIndex) {
      this.buffer = this.buffer.slice(keepFrom - this.baseIndex);
      this.baseIndex = keepFrom;
    }
    return Float32Array.from(out);
  }

  reset(): void {
    this.buffer = new Float32Array(0);
    this.baseIndex = 0;
    this.nextOut = 0;
  }
}

export function resampleOnce(input: Float32Array, inRate: number, outRate: number = TARGET_SAMPLE_RATE): Float32Array {
  return new StreamingResampler(inRate, outRate).process(input);
}

/** Collects PCM16 samples and emits fixed-size frames (default 100 ms @ 16 kHz = 1600 samples). */
export class Int16Framer {
  private pending: Int16Array;
  private filled = 0;

  constructor(readonly frameSamples: number = TARGET_SAMPLE_RATE / 10) {
    if (!(frameSamples > 0)) throw new RangeError('frameSamples must be positive');
    this.pending = new Int16Array(frameSamples);
  }

  push(samples: Int16Array): Int16Array[] {
    const frames: Int16Array[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(this.frameSamples - this.filled, samples.length - offset);
      this.pending.set(samples.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.frameSamples) {
        frames.push(this.pending.slice());
        this.filled = 0;
      }
    }
    return frames;
  }

  /** Returns the trailing partial frame (if any) and resets. */
  flush(): Int16Array | null {
    if (this.filled === 0) return null;
    const tail = this.pending.slice(0, this.filled);
    this.filled = 0;
    return tail;
  }
}

export function concatInt16(chunks: Int16Array[]): Int16Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function pcmDurationMs(samples: number, sampleRate: number = TARGET_SAMPLE_RATE): number {
  return (samples / sampleRate) * 1000;
}

/** Slice an Int16Array into a standalone ArrayBuffer (safe to hand to WebSocket.send / postMessage). */
export function toArrayBuffer(pcm: Int16Array): ArrayBuffer {
  const copy = new Int16Array(pcm.length);
  copy.set(pcm);
  return copy.buffer;
}
