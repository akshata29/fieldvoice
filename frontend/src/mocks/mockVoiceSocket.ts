/**
 * Scripted replay of the /ws/voice protocol (docs/CONTRACT.md section 7) for mock mode. Event order:
 * ready, partial*, transcript, stage(normalize), fields(resolve), stage(resolve), [fields(llm), stage(llm)],
 * fields(validate), result. Engines without streaming emit no partial frames. Timings are simulated.
 */
import type { EvalCase, RunConfig, VoiceClientMessage, VoiceServerEvent, VoiceStartMessage } from '@/api/types';
import { ORACLE_STT_ID } from '@/api/types';
import type { VoiceCloseHandler, VoiceEventHandler, VoiceTransport } from '@/lib/voiceSocket';
import { DEFAULT_DATASET_ID, getDb } from './db';
import { runPipeline, type PipelineRun } from './extractor';
import { sttProfile } from './fixtures/engines';
import { assertEngineReady, findSample, resolveContext, type ExtractContext } from './handlersLab';
import { HttpError } from './router';

export interface MockVoiceSocketOptions {
  /** Multiplies every delay. 0 = as fast as the timer queue allows (tests). */
  timeScale?: number;
}

interface Session {
  start: VoiceStartMessage;
  ctx: ExtractContext;
  config: RunConfig;
  samplesReceived: number;
  partialsStarted: boolean;
  finalized: boolean;
}

export class MockVoiceSocket implements VoiceTransport {
  readonly kind = 'mock' as const;
  private readonly timeScale: number;
  private readonly eventHandlers = new Set<VoiceEventHandler>();
  private readonly closeHandlers = new Set<VoiceCloseHandler>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly partialTimers = new Set<ReturnType<typeof setTimeout>>();
  private session: Session | null = null;
  private closed = false;

  constructor(options: MockVoiceSocketOptions = {}) {
    this.timeScale = options.timeScale ?? 1;
  }

  connect(): Promise<void> {
    return new Promise((resolve) => this.later(resolve, 60));
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
    this.closed = true;
    this.clearAll();
    this.eventHandlers.clear();
    this.closeHandlers.forEach((h) => h({ clean: true, reason: 'closed by client' }));
    this.closeHandlers.clear();
  }

  send(message: VoiceClientMessage): void {
    if (this.closed) return;
    switch (message.type) {
      case 'start':
        return this.onStart(message);
      case 'play_sample':
        return this.onPlaySample(message.sample_id, message.realtime);
      case 'stop':
        return this.onStop();
      case 'cancel':
        this.clearAll();
        if (this.session) this.session.finalized = true;
        return;
    }
  }

  sendAudio(pcm: Int16Array): void {
    const s = this.session;
    if (!s || s.finalized || this.closed) return;
    s.samplesReceived += pcm.length;
    if (!s.partialsStarted && sttProfile(s.config.stt_engine_id).streaming) {
      s.partialsStarted = true;
      const sample = this.cannedSample(s);
      if (sample) this.revealWords(this.rawText(s, sample), 330, this.partialTimers);
    }
  }

  // ---- protocol steps ---------------------------------------------------------------------------------------------

  private onStart(start: VoiceStartMessage): void {
    try {
      const db = getDb();
      const ctx = resolveContext(db, start.work_order_id, start.form_id);
      const config: RunConfig = { stt_engine_id: start.stt_engine_id, llm_engine_id: start.llm_engine_id, strategy_id: start.strategy_id };
      assertEngineReady(db, config.stt_engine_id);
      assertEngineReady(db, config.llm_engine_id);
      this.session = { start, ctx, config, samplesReceived: 0, partialsStarted: false, finalized: false };
      this.later(() => this.emit({ type: 'ready' }), 70);
    } catch (error) {
      const message = error instanceof HttpError ? error.message : error instanceof Error ? error.message : String(error);
      this.later(() => this.emit({ type: 'error', message }), 40);
    }
  }

  private onStop(): void {
    const s = this.session;
    if (!s || s.finalized) return;
    this.clearTimers(this.partialTimers);
    const sample = this.cannedSample(s);
    if (!sample) return this.fail('No sample utterance exists for this form in mock mode.');
    const audioMs = Math.max(1200, Math.round((s.samplesReceived / 16000) * 1000));
    this.finalize(s, sample, audioMs, true);
  }

  private onPlaySample(sampleId: string, realtime: boolean): void {
    const s = this.session;
    if (!s) return this.fail('Send "start" before "play_sample".');
    const sample = findSample(getDb(), sampleId);
    if (!sample) return this.fail(`Unknown sample: ${sampleId}`);
    const probe = this.pipeline(s, sample, undefined);
    const audioMs = probe.result.audio_ms ?? 4000;
    const streaming = sttProfile(s.config.stt_engine_id).streaming;
    let wait = 0;
    if (streaming) {
      const words = probe.result.transcript_raw.split(/\s+/).filter(Boolean);
      const interval = realtime ? Math.max(120, Math.round(audioMs / Math.max(1, words.length))) : 45;
      this.revealWords(probe.result.transcript_raw, interval, this.partialTimers);
      wait = interval * words.length;
    } else {
      wait = realtime ? Math.min(audioMs, 4500) : 150;
    }
    this.later(() => this.finalize(s, sample, audioMs, false), wait + 120);
  }

  // ---- helpers ----------------------------------------------------------------------------------------------------

  private cannedSample(s: Session): EvalCase | undefined {
    const cases = getDb().datasets.get(DEFAULT_DATASET_ID)?.cases.filter((c) => c.form_id === s.ctx.form.id) ?? [];
    return cases.find((c) => c.tags.includes('hero')) ?? cases[0];
  }

  private pipeline(s: Session, sample: EvalCase, audioMs: number | undefined): PipelineRun {
    return runPipeline({
      form: s.ctx.form,
      assets: s.ctx.assets,
      written: sample.written_text,
      spoken: sample.spoken_text,
      expected: sample.expected,
      config: s.config,
      seed: `ws|${sample.id}`,
      audioMs,
    });
  }

  private rawText(s: Session, sample: EvalCase): string {
    return this.pipeline(s, sample, undefined).result.transcript_raw;
  }

  private revealWords(text: string, intervalMs: number, bucket: Set<ReturnType<typeof setTimeout>>): void {
    const words = text.split(/\s+/).filter(Boolean);
    words.forEach((_, i) => {
      this.later(() => this.emit({ type: 'partial', text: words.slice(0, i + 1).join(' '), t_ms: Math.round((i + 1) * intervalMs) }), intervalMs * (i + 1), bucket);
    });
  }

  private finalize(s: Session, sample: EvalCase, audioMs: number, canned: boolean): void {
    if (s.finalized || this.closed) return;
    s.finalized = true;
    const run = this.pipeline(s, sample, audioMs);
    const r = run.result;
    if (canned) r.warnings = [...r.warnings, 'Mock mode: the transcript is a canned sample for this form, not your voice.'];

    const streaming = sttProfile(s.config.stt_engine_id).streaming;
    const oracle = s.config.stt_engine_id === ORACLE_STT_ID;
    let t = oracle ? 40 : streaming ? 250 : Math.min(1400, (r.stt_ms ?? 0) * 0.6) + 150;
    const at = (delay: number, event: VoiceServerEvent) => this.later(() => this.emit(event), delay);

    at(t, { type: 'transcript', text: r.transcript_raw, final: true, stt_ms: r.stt_ms ?? 0, audio_ms: r.audio_ms ?? audioMs });
    t += 40;
    at(t, { type: 'stage', stage: 'normalize', ms: run.stageMs.normalize });
    t += 140;
    at(t, { type: 'fields', stage: 'resolve', fields: run.stages.resolve, unresolved: r.unresolved });
    if (run.stageMs.resolve !== null) {
      t += 30;
      at(t, { type: 'stage', stage: 'resolve', ms: run.stageMs.resolve });
    }
    if (run.stages.llm !== null && run.stageMs.llm !== null) {
      t += Math.min(1800, run.stageMs.llm * 0.6) + 200;
      at(t, { type: 'fields', stage: 'llm', fields: run.stages.llm, unresolved: [] });
      t += 20;
      at(t, { type: 'stage', stage: 'llm', ms: run.stageMs.llm });
    }
    t += 90;
    at(t, { type: 'fields', stage: 'validate', fields: run.stages.validate, unresolved: r.unresolved });
    t += 60;
    at(t, { type: 'result', result: r });
  }

  private fail(message: string): void {
    this.later(() => this.emit({ type: 'error', message }), 30);
  }

  private emit(event: VoiceServerEvent): void {
    if (this.closed) return;
    this.eventHandlers.forEach((h) => h(event));
  }

  private later(fn: () => void, ms: number, bucket: Set<ReturnType<typeof setTimeout>> = this.timers): void {
    const id = setTimeout(() => {
      bucket.delete(id);
      this.timers.delete(id);
      fn();
    }, Math.max(0, ms * this.timeScale));
    bucket.add(id);
    if (bucket !== this.timers) this.timers.add(id);
  }

  private clearTimers(bucket: Set<ReturnType<typeof setTimeout>>): void {
    bucket.forEach((id) => {
      clearTimeout(id);
      this.timers.delete(id);
    });
    bucket.clear();
  }

  private clearAll(): void {
    this.clearTimers(this.partialTimers);
    this.timers.forEach((id) => clearTimeout(id));
    this.timers.clear();
  }
}
