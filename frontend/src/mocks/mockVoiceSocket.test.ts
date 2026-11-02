import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceServerEvent, VoiceStartMessage } from '@/api/types';
import { initialVoiceState, voiceReducer } from '@/lib/voiceSession';
import { parseServerEvent } from '@/lib/voiceSocket';
import { skipMorning, resetDemo } from '@/mocks/controls';
import { resetJobs } from '@/mocks/jobs';
import { MockVoiceSocket } from '@/mocks/mockVoiceSocket';

const NEMO = 'foundry:stt:nemotron-speech-streaming-en-0.6b:cpu';
const BASE = 'foundry:stt:whisper-base:cpu';
const QWEN = 'foundry:llm:qwen2.5-0.5b:cpu';

const start = (over: Partial<VoiceStartMessage> = {}): VoiceStartMessage => ({
  type: 'start',
  work_order_id: 'WO-1001',
  form_id: null,
  stt_engine_id: NEMO,
  llm_engine_id: QWEN,
  strategy_id: 'hybrid',
  sample_rate: 16000,
  ...over,
});

async function connected(socket: MockVoiceSocket): Promise<void> {
  const pending = socket.connect();
  await vi.runAllTimersAsync();
  await pending;
}

async function collect(socket: MockVoiceSocket, run: () => void): Promise<VoiceServerEvent[]> {
  const events: VoiceServerEvent[] = [];
  socket.onEvent((e) => events.push(e));
  await connected(socket);
  run();
  await vi.runAllTimersAsync();
  return events;
}

describe('MockVoiceSocket replays the /ws/voice protocol', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDemo();
    skipMorning();
  });
  afterEach(() => {
    resetJobs();
    vi.useRealTimers();
  });

  it('plays a sample through a streaming engine in the contract order', async () => {
    const socket = new MockVoiceSocket({ timeScale: 0 });
    const events = await collect(socket, () => {
      socket.send(start());
      socket.send({ type: 'play_sample', sample_id: 'tr-0001', realtime: true });
    });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('ready');
    expect(types.filter((t) => t === 'partial').length).toBeGreaterThan(5);
    const afterPartials = types.slice(types.lastIndexOf('partial') + 1);
    // transcript, stage(normalize), fields(resolve), stage(resolve), [fields(llm), stage(llm)], fields(validate), result
    expect(afterPartials[0]).toBe('transcript');
    expect(afterPartials.slice(1, 4)).toEqual(['stage', 'fields', 'stage']);
    expect(afterPartials[afterPartials.length - 1]).toBe('result');
    expect(afterPartials[afterPartials.length - 2]).toBe('fields');
    const stages = events.filter((e): e is Extract<VoiceServerEvent, { type: 'stage' }> => e.type === 'stage').map((e) => e.stage);
    expect(stages[0]).toBe('normalize');
    expect(stages).toContain('resolve');
    const fieldStages = events.filter((e): e is Extract<VoiceServerEvent, { type: 'fields' }> => e.type === 'fields').map((e) => e.stage);
    expect(fieldStages[0]).toBe('resolve');
    expect(fieldStages[fieldStages.length - 1]).toBe('validate');
    socket.close();
  });

  it('partials replace each other word by word and the transcript is the full text', async () => {
    const socket = new MockVoiceSocket({ timeScale: 0 });
    const events = await collect(socket, () => {
      socket.send(start());
      socket.send({ type: 'play_sample', sample_id: 'tr-0001', realtime: false });
    });
    const partials = events.filter((e): e is Extract<VoiceServerEvent, { type: 'partial' }> => e.type === 'partial');
    for (let i = 1; i < partials.length; i++) {
      expect(partials[i]!.text.startsWith(partials[i - 1]!.text)).toBe(true);
      expect(partials[i]!.text.split(' ').length).toBe(partials[i - 1]!.text.split(' ').length + 1);
      expect(partials[i]!.t_ms).toBeGreaterThan(partials[i - 1]!.t_ms);
    }
    const transcript = events.find((e) => e.type === 'transcript');
    expect(transcript).toMatchObject({ final: true });
    expect(partials[partials.length - 1]!.text).toBe((transcript as { text: string }).text);
    expect((transcript as { text: string }).text).toContain('one two three'); // streaming engine renders ids as words
  });

  it('emits no partial frames for engines without streaming', async () => {
    const socket = new MockVoiceSocket({ timeScale: 0 });
    const events = await collect(socket, () => {
      socket.send(start({ stt_engine_id: BASE }));
      socket.send({ type: 'play_sample', sample_id: 'tr-0001', realtime: true });
    });
    expect(events.some((e) => e.type === 'partial')).toBe(false);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['ready', 'transcript', 'result']));
  });

  it('ends with a self-consistent result: evidence indexes the normalised transcript and timings add up', async () => {
    const socket = new MockVoiceSocket({ timeScale: 0 });
    const events = await collect(socket, () => {
      socket.send(start());
      socket.send({ type: 'play_sample', sample_id: 'tr-0001', realtime: false });
    });
    const result = (events.find((e) => e.type === 'result') as Extract<VoiceServerEvent, { type: 'result' }>).result;
    expect(result.transcript_normalized).toContain('pole 123');
    expect(result.fields.pole_id).toMatchObject({ value: '123', status: 'filled' });
    for (const f of Object.values(result.fields)) {
      if (f.evidence) expect(result.transcript_normalized.slice(f.evidence.start, f.evidence.end)).toBe(f.evidence.text);
    }
    expect(result.timings.map((t) => t.stage)).toEqual(expect.arrayContaining(['stt', 'normalize', 'resolve', 'validate']));
    expect(result.total_ms).toBeGreaterThanOrEqual(result.timings.reduce((a, t) => a + t.ms, 0));
    expect(result.stt_engine_id).toBe(NEMO);
  });

  it('every frame survives JSON serialisation as the client parser expects', async () => {
    const socket = new MockVoiceSocket({ timeScale: 0 });
    const events = await collect(socket, () => {
      socket.send(start());
      socket.send({ type: 'play_sample', sample_id: 'tr-0002', realtime: false });
    });
    for (const e of events) expect(parseServerEvent(JSON.stringify(e)), e.type).toMatchObject({ type: e.type });
  });

  it('drives the client state machine from ready to done', async () => {
    const socket = new MockVoiceSocket({ timeScale: 0 });
    const events = await collect(socket, () => {
      socket.send(start());
      socket.send({ type: 'play_sample', sample_id: 'tr-0001', realtime: false });
    });
    let state = voiceReducer(initialVoiceState, { type: 'begin', mode: 'sample' });
    for (const event of events) state = voiceReducer(state, { type: 'event', event });
    expect(state.phase).toBe('done');
    expect(state.result?.fields.pole_id?.value).toBe('123');
    expect(state.partial).toBe('');
  });

  it('microphone flow: audio frames reveal live words, stop finalises a canned sample and says so', async () => {
    const socket = new MockVoiceSocket({ timeScale: 0 });
    const events: VoiceServerEvent[] = [];
    socket.onEvent((e) => events.push(e));
    await connected(socket);
    socket.send(start());
    await vi.runAllTimersAsync();
    expect(events.map((e) => e.type)).toEqual(['ready']);
    for (let i = 0; i < 10; i++) socket.sendAudio(new Int16Array(1600));
    await vi.runAllTimersAsync();
    expect(events.filter((e) => e.type === 'partial').length).toBeGreaterThan(3);
    socket.send({ type: 'stop' });
    await vi.runAllTimersAsync();
    const result = (events.find((e) => e.type === 'result') as Extract<VoiceServerEvent, { type: 'result' }>).result;
    expect(result.audio_ms).toBe(1200); // 10 x 100 ms, floored at 1.2 s
    expect(result.warnings.join(' ')).toMatch(/canned sample/);
    expect(events.at(-1)?.type).toBe('result');
  });

  it('reports errors for engines that are not ready, missing context and unknown samples', async () => {
    const notReady = new MockVoiceSocket({ timeScale: 0 });
    const a = await collect(notReady, () => notReady.send(start({ stt_engine_id: 'foundry:stt:whisper-small:cpu' })));
    expect(a).toEqual([{ type: 'error', message: expect.stringMatching(/not ready/) }]);

    const noContext = new MockVoiceSocket({ timeScale: 0 });
    const b = await collect(noContext, () => noContext.send(start({ work_order_id: null, form_id: null })));
    expect(b[0]).toMatchObject({ type: 'error', message: expect.stringMatching(/work_order_id or form_id/) });

    const unknown = new MockVoiceSocket({ timeScale: 0 });
    const c = await collect(unknown, () => {
      unknown.send(start());
      unknown.send({ type: 'play_sample', sample_id: 'nope', realtime: false });
    });
    expect(c.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/Unknown sample/) });
  });

  it('cancel stops the replay and close detaches listeners', async () => {
    const socket = new MockVoiceSocket({ timeScale: 1 });
    const events: VoiceServerEvent[] = [];
    socket.onEvent((e) => events.push(e));
    await vi.advanceTimersByTimeAsync(100);
    socket.send(start());
    socket.send({ type: 'play_sample', sample_id: 'tr-0001', realtime: true });
    await vi.advanceTimersByTimeAsync(1500);
    const before = events.length;
    expect(before).toBeGreaterThan(1);
    socket.send({ type: 'cancel' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(events.length).toBe(before);
    expect(events.some((e) => e.type === 'result')).toBe(false);
    socket.close();
  });

  it('works for a form without a work order (all known assets)', async () => {
    const socket = new MockVoiceSocket({ timeScale: 0 });
    const events = await collect(socket, () => {
      socket.send(start({ work_order_id: null, form_id: 'pole_inspection' }));
      socket.send({ type: 'play_sample', sample_id: 'pi-0001', realtime: false });
    });
    const result = (events.find((e) => e.type === 'result') as Extract<VoiceServerEvent, { type: 'result' }>).result;
    expect(result.fields.pole_id?.value).toBe('305');
    expect(result.fields.lean_angle_deg?.value).toBe(12);
  });
});
