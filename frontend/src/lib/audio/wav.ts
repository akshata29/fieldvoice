/** Minimal PCM16 WAV encoder/decoder-header used for uploads (/voice/extract-audio) and tests. */

export interface WavInfo {
  format: number; // 1 = PCM
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
  durationMs: number;
}

const HEADER_BYTES = 44;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Builds a canonical 44-byte-header mono PCM16 WAV (little-endian) around the samples. */
export function encodeWav(pcm: Int16Array, sampleRate = 16000, channels = 1): ArrayBuffer {
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(HEADER_BYTES + i * 2, pcm[i] ?? 0, true);
  return buffer;
}

export function wavBlob(pcm: Int16Array, sampleRate = 16000): Blob {
  return new Blob([encodeWav(pcm, sampleRate)], { type: 'audio/wav' });
}

function readAscii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

/** Walks the RIFF chunks and returns the fmt/data facts; throws on anything that is not a RIFF/WAVE file. */
export function parseWavHeader(buffer: ArrayBuffer): WavInfo {
  if (buffer.byteLength < 12) throw new Error('File is too small to be a WAV');
  const view = new DataView(buffer);
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');
  let offset = 12;
  let fmt: Pick<WavInfo, 'format' | 'channels' | 'sampleRate' | 'bitsPerSample'> | null = null;
  let dataBytes: number | null = null;
  while (offset + 8 <= buffer.byteLength) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buffer.byteLength) {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataBytes = Math.min(size, buffer.byteLength - body);
      break;
    }
    offset = body + size + (size % 2); // chunks are word aligned
  }
  if (!fmt) throw new Error('WAV has no fmt chunk');
  if (dataBytes === null) throw new Error('WAV has no data chunk');
  const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  return { ...fmt, dataBytes, durationMs: bytesPerSecond > 0 ? (dataBytes / bytesPerSecond) * 1000 : 0 };
}

/** Human-readable warnings for files that the on-device engines may not accept (16 kHz mono PCM16 is the safe format). */
export function wavWarnings(info: WavInfo): string[] {
  const warnings: string[] = [];
  if (info.format !== 1) warnings.push('Not PCM audio - the engines expect 16-bit PCM WAV.');
  if (info.sampleRate !== 16000) warnings.push(`Sample rate is ${info.sampleRate} Hz; 16 kHz is preferred.`);
  if (info.channels !== 1) warnings.push(`${info.channels} channels; mono is preferred.`);
  if (info.bitsPerSample !== 16) warnings.push(`${info.bitsPerSample}-bit samples; 16-bit is expected.`);
  return warnings;
}
