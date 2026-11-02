import { describe, expect, it } from 'vitest';
import {
  Int16Framer,
  StreamingResampler,
  concatInt16,
  floatToInt16,
  int16ToFloat,
  levelFromRms,
  resampleOnce,
  rms,
} from '@/lib/audio/resample';

const sine = (n: number, rate: number, freq: number, amp = 0.5): Float32Array =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

describe('floatToInt16 / int16ToFloat', () => {
  it('maps the extremes to the full Int16 range and clamps overshoot', () => {
    const out = floatToInt16(Float32Array.from([1, -1, 0, 2, -3]));
    expect(Array.from(out)).toEqual([32767, -32768, 0, 32767, -32768]);
  });

  it('rounds to the nearest integer', () => {
    expect(Array.from(floatToInt16(Float32Array.from([0.5, -0.5])))).toEqual([16384, -16384]);
  });

  it('round-trips within one quantisation step', () => {
    const src = sine(256, 16000, 440, 0.8);
    const back = int16ToFloat(floatToInt16(src));
    for (let i = 0; i < src.length; i++) expect(Math.abs((back[i] ?? 0) - (src[i] ?? 0))).toBeLessThan(1 / 16000);
  });
});

describe('rms / levelFromRms', () => {
  it('rms of a full-scale square wave is 1 and of silence is 0', () => {
    expect(rms(Float32Array.from([1, -1, 1, -1]))).toBeCloseTo(1, 6);
    expect(rms(new Float32Array(10))).toBe(0);
    expect(rms(new Float32Array(0))).toBe(0);
  });

  it('maps dBFS onto 0..1', () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(1)).toBe(1);
    expect(levelFromRms(10 ** (-30 / 20))).toBeCloseTo(0.5, 6); // -30 dB is halfway between -60 and 0
    expect(levelFromRms(10 ** (-90 / 20))).toBe(0); // below the floor
  });
});

describe('StreamingResampler', () => {
  it('48 kHz -> 16 kHz averages triples and yields n/3 samples', () => {
    const input = Float32Array.from([0, 3, 6, 9, 12, 15]);
    const out = resampleOnce(input, 48000, 16000);
    expect(Array.from(out)).toEqual([3, 12]);
  });

  it('keeps a constant signal constant for any ratio (44.1 kHz)', () => {
    const out = resampleOnce(new Float32Array(4410).fill(0.25), 44100, 16000);
    expect(out.length).toBe(1600);
    for (const v of out) expect(v).toBeCloseTo(0.25, 5);
  });

  it('produces round(n / ratio) samples', () => {
    for (const rate of [8000, 16000, 22050, 32000, 44100, 48000]) {
      const out = resampleOnce(new Float32Array(rate), rate, 16000);
      expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(1);
    }
  });

  it('preserves the amplitude of an in-band tone', () => {
    const out = resampleOnce(sine(48000, 48000, 440, 0.5), 48000, 16000);
    expect(rms(out)).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('passes through unchanged when the rates are equal', () => {
    const src = sine(100, 16000, 300);
    expect(Array.from(resampleOnce(src, 16000, 16000))).toEqual(Array.from(src));
  });

  it('gives the same result regardless of how the stream is chunked', () => {
    const src = sine(20000, 44100, 700);
    const whole = resampleOnce(src, 44100, 16000);
    const chunked = new StreamingResampler(44100, 16000);
    const parts: Float32Array[] = [];
    let offset = 0;
    for (const size of [1, 127, 128, 500, 3, 2048, 777]) {
      parts.push(chunked.process(src.subarray(offset, offset + size)));
      offset += size;
    }
    while (offset < src.length) {
      parts.push(chunked.process(src.subarray(offset, offset + 1024)));
      offset += 1024;
    }
    const merged = Float32Array.from(parts.flatMap((p) => Array.from(p)));
    expect(merged.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(merged[i]).toBeCloseTo(whole[i] ?? 0, 5);
  });

  it('rejects non-positive rates', () => {
    expect(() => new StreamingResampler(0, 16000)).toThrow(RangeError);
  });
});

describe('Int16Framer', () => {
  it('emits exact 100 ms frames (1600 samples) and keeps the remainder', () => {
    const framer = new Int16Framer();
    expect(framer.frameSamples).toBe(1600);
    const frames = framer.push(new Int16Array(4000).fill(7));
    expect(frames.map((f) => f.length)).toEqual([1600, 1600]);
    const tail = framer.flush();
    expect(tail?.length).toBe(800);
    expect(framer.flush()).toBeNull();
  });

  it('accumulates across pushes', () => {
    const framer = new Int16Framer(4);
    expect(framer.push(Int16Array.from([1, 2, 3]))).toHaveLength(0);
    const frames = framer.push(Int16Array.from([4, 5, 6, 7, 8, 9]));
    expect(frames.map((f) => Array.from(f))).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect(Array.from(framer.flush() ?? [])).toEqual([9]);
  });

  it('emits copies so consumers can keep them', () => {
    const framer = new Int16Framer(2);
    const [first] = framer.push(Int16Array.from([1, 2]));
    framer.push(Int16Array.from([9, 9]));
    expect(Array.from(first ?? [])).toEqual([1, 2]);
  });
});

describe('concatInt16', () => {
  it('joins chunks in order', () => {
    expect(Array.from(concatInt16([Int16Array.from([1, 2]), Int16Array.from([]), Int16Array.from([3])]))).toEqual([1, 2, 3]);
  });
});
