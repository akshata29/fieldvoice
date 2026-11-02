import { describe, expect, it } from 'vitest';
import { encodeWav, parseWavHeader, wavBlob, wavWarnings } from '@/lib/audio/wav';

const ascii = (buf: ArrayBuffer, offset: number, len: number) =>
  String.fromCharCode(...new Uint8Array(buf, offset, len));

describe('encodeWav', () => {
  const pcm = Int16Array.from([0, 1000, -1000, 32767, -32768]);
  const wav = encodeWav(pcm, 16000);
  const view = new DataView(wav);

  it('writes a canonical 44-byte RIFF/WAVE header', () => {
    expect(wav.byteLength).toBe(44 + pcm.length * 2);
    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + pcm.length * 2);
    expect(ascii(wav, 8, 4)).toBe('WAVE');
    expect(ascii(wav, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(ascii(wav, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(pcm.length * 2);
  });

  it('declares 16 kHz mono 16-bit PCM', () => {
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16);
  });

  it('stores samples little-endian right after the header', () => {
    expect(Array.from(new Int16Array(wav.slice(44)))).toEqual(Array.from(pcm));
    const bytes = new Uint8Array(wav);
    expect(bytes[46]).toBe(1000 & 0xff); // sample #1 (1000): low byte first ...
    expect(bytes[47]).toBe(1000 >> 8); // ... then the high byte
  });

  it('honours a different sample rate', () => {
    const w = new DataView(encodeWav(pcm, 8000));
    expect(w.getUint32(24, true)).toBe(8000);
    expect(w.getUint32(28, true)).toBe(16000);
  });
});

describe('parseWavHeader', () => {
  it('reads back what encodeWav wrote, including the duration', () => {
    const info = parseWavHeader(encodeWav(new Int16Array(8000), 16000));
    expect(info).toMatchObject({ format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, dataBytes: 16000 });
    expect(info.durationMs).toBeCloseTo(500, 6);
  });

  it('skips unknown chunks before the data chunk', () => {
    const base = new Uint8Array(encodeWav(Int16Array.from([1, 2]), 16000));
    const listChunk = Uint8Array.from([0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 1, 2, 3, 4]);
    const merged = new Uint8Array(base.length + listChunk.length);
    merged.set(base.subarray(0, 36), 0);
    merged.set(listChunk, 36);
    merged.set(base.subarray(36), 36 + listChunk.length);
    expect(parseWavHeader(merged.buffer).dataBytes).toBe(4);
  });

  it('rejects non-WAV input', () => {
    expect(() => parseWavHeader(new ArrayBuffer(4))).toThrow();
    expect(() => parseWavHeader(new TextEncoder().encode('this is not a wave file').buffer as ArrayBuffer)).toThrow(/RIFF/);
  });

  it('flags formats the engines may not accept', () => {
    expect(wavWarnings(parseWavHeader(encodeWav(new Int16Array(10), 16000)))).toEqual([]);
    const warnings = wavWarnings({ format: 1, channels: 2, sampleRate: 44100, bitsPerSample: 16, dataBytes: 10, durationMs: 1 });
    expect(warnings.join(' ')).toMatch(/44100/);
    expect(warnings.join(' ')).toMatch(/2 channels/);
  });
});

describe('wavBlob', () => {
  it('wraps the buffer as audio/wav', () => {
    const blob = wavBlob(new Int16Array(10), 16000);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 20);
  });
});
