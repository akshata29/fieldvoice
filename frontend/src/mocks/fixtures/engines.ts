/** Mock engine registry, strategies, Foundry catalog and the behavioural profiles used to fake extraction/latency. */
import type { CatalogModel, CatalogVariant, EngineInfo, StrategyInfo } from '@/api/types';
import { NO_LLM_ID, ORACLE_STT_ID } from '@/api/types';

function engine(partial: Partial<EngineInfo> & Pick<EngineInfo, 'id' | 'kind' | 'name' | 'provider'>): EngineInfo {
  return {
    offline: true,
    supports_streaming: false,
    availability: 'ready',
    availability_reason: null,
    alias: null,
    variant_id: null,
    device: null,
    execution_provider: null,
    size_mb: null,
    loaded: false,
    tags: [],
    ...partial,
  };
}

const cpu = { device: 'cpu', execution_provider: 'CPUExecutionProvider' } as const;

export function buildEngines(): EngineInfo[] {
  return [
    engine({
      id: ORACLE_STT_ID,
      kind: 'stt',
      name: 'Reference transcript (oracle)',
      provider: 'oracle',
      availability_reason: "Uses the dataset's reference text instead of running speech recognition. Isolates extraction quality.",
      tags: ['evaluation'],
    }),
    engine({ id: 'foundry:stt:whisper-tiny:cpu', kind: 'stt', name: 'Whisper tiny', provider: 'foundry', alias: 'whisper-tiny', variant_id: 'whisper-tiny-generic-cpu:1', size_mb: 130, ...cpu }),
    engine({ id: 'foundry:stt:whisper-base:cpu', kind: 'stt', name: 'Whisper base', provider: 'foundry', alias: 'whisper-base', variant_id: 'whisper-base-generic-cpu:1', size_mb: 290, loaded: true, ...cpu }),
    engine({
      id: 'foundry:stt:whisper-small:cpu',
      kind: 'stt',
      name: 'Whisper small',
      provider: 'foundry',
      alias: 'whisper-small',
      variant_id: 'whisper-small-generic-cpu:1',
      size_mb: 480,
      availability: 'needs_download',
      availability_reason: 'Model files are not in the local cache yet.',
      ...cpu,
    }),
    engine({
      id: 'foundry:stt:whisper-medium:cpu',
      kind: 'stt',
      name: 'Whisper medium',
      provider: 'foundry',
      alias: 'whisper-medium',
      variant_id: 'whisper-medium-generic-cpu:1',
      size_mb: 900,
      availability: 'needs_download',
      availability_reason: 'Model files are not in the local cache yet.',
      ...cpu,
    }),
    engine({
      id: 'foundry:stt:whisper-large-v3-turbo:cpu',
      kind: 'stt',
      name: 'Whisper large-v3-turbo',
      provider: 'foundry',
      alias: 'whisper-large-v3-turbo',
      variant_id: 'whisper-large-v3-turbo-generic-cpu:1',
      size_mb: 1300,
      availability: 'needs_download',
      availability_reason: 'Model files are not in the local cache yet.',
      ...cpu,
    }),
    engine({
      id: 'foundry:stt:nemotron-speech-streaming-en-0.6b:cpu',
      kind: 'stt',
      name: 'Nemotron Speech Streaming 0.6B',
      provider: 'foundry',
      alias: 'nemotron-speech-streaming-en-0.6b',
      variant_id: 'nemotron-speech-streaming-en-0.6b-generic-cpu:1',
      supports_streaming: true,
      size_mb: 700,
      loaded: true,
      tags: ['streaming'],
      ...cpu,
    }),
    engine({
      id: 'foundry:stt:parakeet-tdt-0.6b:cpu',
      kind: 'stt',
      name: 'Parakeet TDT 0.6B',
      provider: 'foundry',
      alias: 'parakeet-tdt-0.6b',
      variant_id: 'parakeet-tdt-0.6b-generic-cpu:1',
      supports_streaming: true,
      size_mb: 700,
      availability: 'error',
      availability_reason: 'File transcription was rejected by this model; it only works through a live streaming session.',
      tags: ['streaming'],
      ...cpu,
    }),
    engine({
      id: 'azure-embedded:stt:en-US',
      kind: 'stt',
      name: 'Azure embedded speech (en-US)',
      provider: 'azure-embedded',
      availability: 'unavailable',
      availability_reason:
        'Limited access: registration is required (https://aka.ms/csgate-embedded-speech). Windows 11+ only; there is no iOS SDK. No model path is configured.',
      tags: ['limited-access'],
    }),
    engine({
      id: 'azure-cloud:stt:default',
      kind: 'stt',
      name: 'Azure Speech (cloud)',
      provider: 'azure-cloud',
      offline: false,
      availability: 'unavailable',
      availability_reason: 'Azure Speech key / region are not configured. Reference ceiling only: this engine needs the network at inference time.',
      tags: ['reference-only'],
    }),

    engine({ id: NO_LLM_ID, kind: 'llm', name: 'No LLM (rules only)', provider: 'rules', availability_reason: 'Deterministic stages only. Always works, even with no models installed.' }),
    engine({ id: 'foundry:llm:qwen2.5-0.5b:cpu', kind: 'llm', name: 'Qwen2.5 0.5B', provider: 'foundry', alias: 'qwen2.5-0.5b', variant_id: 'qwen2.5-0.5b-instruct-generic-cpu:4', size_mb: 530, loaded: true, ...cpu }),
    engine({
      id: 'foundry:llm:qwen2.5-0.5b:npu',
      kind: 'llm',
      name: 'Qwen2.5 0.5B (NPU)',
      provider: 'foundry',
      alias: 'qwen2.5-0.5b',
      variant_id: 'qwen2.5-0.5b-instruct-openvino-npu:1',
      size_mb: 560,
      device: 'npu',
      execution_provider: 'OpenVINOExecutionProvider',
      availability: 'error',
      availability_reason: 'The NPU variant failed to load. Accelerator variants must be pinned and self-tested before use; fall back to the CPU variant.',
      tags: ['accelerator'],
    }),
    engine({
      id: 'foundry:llm:qwen2.5-1.5b:cpu',
      kind: 'llm',
      name: 'Qwen2.5 1.5B',
      provider: 'foundry',
      alias: 'qwen2.5-1.5b',
      variant_id: 'qwen2.5-1.5b-instruct-generic-cpu:4',
      size_mb: 1100,
      availability: 'needs_download',
      availability_reason: 'Model files are not in the local cache yet.',
      ...cpu,
    }),
    engine({ id: 'foundry:llm:qwen3-0.6b:cpu', kind: 'llm', name: 'Qwen3 0.6B', provider: 'foundry', alias: 'qwen3-0.6b', variant_id: 'qwen3-0.6b-generic-cpu:1', size_mb: 640, ...cpu }),
    engine({ id: 'foundry:llm:phi-3.5-mini:cpu', kind: 'llm', name: 'Phi-3.5 mini (3.8B)', provider: 'foundry', alias: 'phi-3.5-mini', variant_id: 'phi-3.5-mini-instruct-generic-cpu:1', size_mb: 2600, ...cpu }),
    engine({
      id: 'foundry:llm:phi-4-mini:cpu',
      kind: 'llm',
      name: 'Phi-4 mini',
      provider: 'foundry',
      alias: 'phi-4-mini',
      variant_id: 'phi-4-mini-instruct-generic-cpu:1',
      size_mb: 2700,
      availability: 'needs_download',
      availability_reason: 'Model files are not in the local cache yet.',
      ...cpu,
    }),
    engine({
      id: 'foundry:llm:ministral-3-3b:cpu',
      kind: 'llm',
      name: 'Ministral 3 3B',
      provider: 'foundry',
      alias: 'ministral-3-3b',
      variant_id: 'ministral-3-3b-generic-cpu:1',
      size_mb: 4700,
      availability: 'needs_download',
      availability_reason: 'Model files are not in the local cache yet.',
      tags: ['vision'],
      ...cpu,
    }),
    engine({
      id: 'foundry:llm:smollm3-3b:cpu',
      kind: 'llm',
      name: 'SmolLM3 3B',
      provider: 'foundry',
      alias: 'smollm3-3b',
      variant_id: 'smollm3-3b-generic-cpu:1',
      size_mb: 1900,
      availability: 'needs_download',
      availability_reason: 'Model files are not in the local cache yet.',
      ...cpu,
    }),
    engine({
      id: 'foundry:llm:gemma-4-e2b:cpu',
      kind: 'llm',
      name: 'Gemma 4 E2B',
      provider: 'foundry',
      alias: 'gemma-4-e2b',
      variant_id: 'gemma-4-e2b-generic-cpu:1',
      size_mb: 6000,
      availability: 'unavailable',
      availability_reason: 'A 6 GB model does not fit the memory budget of this device profile.',
      tags: ['audio-in', 'vision'],
      ...cpu,
    }),
  ];
}

export const STRATEGIES: StrategyInfo[] = [
  {
    id: 'free_json',
    name: 'Free JSON (baseline)',
    description: 'One prompt with the whole form; the model answers in unconstrained JSON and we parse it leniently. Approximates the current prototype.',
    uses_llm: true,
    deterministic_stages: false,
    constrained: false,
  },
  {
    id: 'schema_constrained',
    name: 'Schema-constrained JSON',
    description: 'Same prompt, but decoding is constrained to the form schema so the output always parses. Ids can still be wrong.',
    uses_llm: true,
    deterministic_stages: false,
    constrained: true,
  },
  {
    id: 'enum_grammar',
    name: 'Enum grammar',
    description: 'LLM only, with a tight grammar: enum codes and candidate-restricted ids, compact output.',
    uses_llm: true,
    deterministic_stages: false,
    constrained: true,
  },
  {
    id: 'hybrid',
    name: 'Hybrid (rules first, LLM for the rest)',
    description: 'Normalize numbers, resolve ids and enums deterministically against the job, call the LLM only for what is left, then validate.',
    uses_llm: true,
    deterministic_stages: true,
    constrained: true,
  },
  {
    id: 'rules_only',
    name: 'Rules only (no LLM)',
    description: 'Deterministic stages only. Always works without any model; unresolved fields are left for the worker.',
    uses_llm: false,
    deterministic_stages: true,
    constrained: false,
  },
];

// ---- behavioural profiles (fabricated; they only shape the demo data) ------------------------------------------

export interface SttProfile {
  /** stt time / audio time */
  rtf: number;
  coldStartMs: number;
  /** chance that one id in the utterance is misheard */
  mishear: number;
  numberStyle: 'digits' | 'spaced' | 'words';
  streaming: boolean;
  sizeMb: number;
  rssMb: number;
}

export interface LlmProfile {
  sizeMb: number;
  prefillMsPerTok: number;
  decodeMsPerTok: number;
  /** chance that an id the LLM has to produce is wrong */
  idError: number;
  enumError: number;
  /** chance that unconstrained JSON does not parse */
  jsonInvalid: number;
  coldStartMs: number;
  rssMb: number;
}

const STT_PROFILES: Array<[RegExp, SttProfile]> = [
  [/oracle/, { rtf: 0, coldStartMs: 0, mishear: 0, numberStyle: 'digits', streaming: false, sizeMb: 0, rssMb: 0 }],
  [/whisper-tiny/, { rtf: 0.18, coldStartMs: 900, mishear: 0.16, numberStyle: 'spaced', streaming: false, sizeMb: 130, rssMb: 260 }],
  [/whisper-base/, { rtf: 0.3, coldStartMs: 1400, mishear: 0.09, numberStyle: 'digits', streaming: false, sizeMb: 290, rssMb: 420 }],
  [/whisper-small/, { rtf: 0.7, coldStartMs: 2600, mishear: 0.05, numberStyle: 'digits', streaming: false, sizeMb: 480, rssMb: 780 }],
  [/whisper-medium/, { rtf: 1.6, coldStartMs: 6100, mishear: 0.03, numberStyle: 'digits', streaming: false, sizeMb: 900, rssMb: 1500 }],
  [/whisper-large/, { rtf: 2.3, coldStartMs: 9400, mishear: 0.02, numberStyle: 'digits', streaming: false, sizeMb: 1300, rssMb: 2100 }],
  [/nemotron/, { rtf: 0.12, coldStartMs: 2100, mishear: 0.06, numberStyle: 'words', streaming: true, sizeMb: 700, rssMb: 980 }],
  [/parakeet/, { rtf: 0.1, coldStartMs: 2000, mishear: 0.06, numberStyle: 'words', streaming: true, sizeMb: 700, rssMb: 960 }],
  [/azure-embedded/, { rtf: 0.2, coldStartMs: 1200, mishear: 0.03, numberStyle: 'digits', streaming: true, sizeMb: 400, rssMb: 520 }],
  [/azure-cloud/, { rtf: 0.15, coldStartMs: 0, mishear: 0.02, numberStyle: 'digits', streaming: true, sizeMb: 0, rssMb: 90 }],
];

const DEFAULT_STT: SttProfile = { rtf: 0.4, coldStartMs: 1500, mishear: 0.08, numberStyle: 'digits', streaming: false, sizeMb: 300, rssMb: 450 };

export function sttProfile(engineId: string): SttProfile {
  return STT_PROFILES.find(([re]) => re.test(engineId))?.[1] ?? DEFAULT_STT;
}

const LLM_PROFILES: Array<[RegExp, LlmProfile]> = [
  [/rules:llm:none/, { sizeMb: 0, prefillMsPerTok: 0, decodeMsPerTok: 0, idError: 0, enumError: 0, jsonInvalid: 0, coldStartMs: 0, rssMb: 0 }],
  [/qwen2\.5-0\.5b/, { sizeMb: 530, prefillMsPerTok: 1.1, decodeMsPerTok: 28, idError: 0.16, enumError: 0.1, jsonInvalid: 0.12, coldStartMs: 1700, rssMb: 700 }],
  [/qwen2\.5-1\.5b/, { sizeMb: 1100, prefillMsPerTok: 3.2, decodeMsPerTok: 62, idError: 0.09, enumError: 0.05, jsonInvalid: 0.06, coldStartMs: 3100, rssMb: 1450 }],
  [/qwen3-0\.6b/, { sizeMb: 640, prefillMsPerTok: 1.4, decodeMsPerTok: 32, idError: 0.13, enumError: 0.08, jsonInvalid: 0.1, coldStartMs: 1900, rssMb: 820 }],
  [/phi-3\.5/, { sizeMb: 2600, prefillMsPerTok: 8.5, decodeMsPerTok: 150, idError: 0.05, enumError: 0.03, jsonInvalid: 0.03, coldStartMs: 6200, rssMb: 3300 }],
  [/phi-4/, { sizeMb: 2700, prefillMsPerTok: 9, decodeMsPerTok: 155, idError: 0.04, enumError: 0.03, jsonInvalid: 0.02, coldStartMs: 6500, rssMb: 3400 }],
  [/ministral/, { sizeMb: 4700, prefillMsPerTok: 7, decodeMsPerTok: 130, idError: 0.05, enumError: 0.03, jsonInvalid: 0.03, coldStartMs: 9800, rssMb: 5600 }],
  [/smollm3/, { sizeMb: 1900, prefillMsPerTok: 7, decodeMsPerTok: 125, idError: 0.06, enumError: 0.04, jsonInvalid: 0.05, coldStartMs: 4400, rssMb: 2500 }],
  [/gemma/, { sizeMb: 6000, prefillMsPerTok: 10, decodeMsPerTok: 170, idError: 0.04, enumError: 0.03, jsonInvalid: 0.03, coldStartMs: 11000, rssMb: 6800 }],
];

const DEFAULT_LLM: LlmProfile = { sizeMb: 1500, prefillMsPerTok: 4, decodeMsPerTok: 80, idError: 0.1, enumError: 0.06, jsonInvalid: 0.06, coldStartMs: 3000, rssMb: 1900 };

export function llmProfile(engineId: string): LlmProfile {
  return LLM_PROFILES.find(([re]) => re.test(engineId))?.[1] ?? DEFAULT_LLM;
}

// ---- Foundry catalog -------------------------------------------------------------------------------------------

function variants(alias: string, sizeMb: number, cachedCpu: boolean, accelerators: Array<'gpu' | 'npu'> = ['gpu', 'npu']): CatalogVariant[] {
  const list: CatalogVariant[] = [
    { id: `${alias}-generic-cpu:1`, device: 'cpu', execution_provider: 'CPUExecutionProvider', size_mb: sizeMb, cached: cachedCpu },
  ];
  if (accelerators.includes('gpu')) {
    list.push({ id: `${alias}-webgpu-gpu:1`, device: 'gpu', execution_provider: 'WebGpuExecutionProvider', size_mb: Math.round(sizeMb * 1.05), cached: false });
    list.push({ id: `${alias}-openvino-gpu:1`, device: 'gpu', execution_provider: 'OpenVINOExecutionProvider', size_mb: Math.round(sizeMb * 1.1), cached: false });
  }
  if (accelerators.includes('npu')) {
    list.push({ id: `${alias}-openvino-npu:1`, device: 'npu', execution_provider: 'OpenVINOExecutionProvider', size_mb: Math.round(sizeMb * 1.08), cached: false });
  }
  return list;
}

const asr = (alias: string, publisher: string, sizeMb: number, cached: boolean, license: string | null = null): CatalogModel => ({
  alias,
  task: 'automatic-speech-recognition',
  publisher,
  license,
  input_modalities: ['audio'],
  supports_tool_calling: null,
  variants: variants(alias, sizeMb, cached),
});

const chat = (alias: string, publisher: string, sizeMb: number, cached: boolean, opts: { license?: string | null; tools?: boolean; modalities?: string[]; task?: string } = {}): CatalogModel => ({
  alias,
  task: opts.task ?? 'chat-completion',
  publisher,
  license: opts.license ?? null,
  input_modalities: opts.modalities ?? ['text'],
  supports_tool_calling: opts.tools ?? null,
  variants: variants(alias, sizeMb, cached),
});

export function buildCatalog(): CatalogModel[] {
  return [
    asr('whisper-tiny', 'OpenAI', 130, true, 'MIT'),
    asr('whisper-base', 'OpenAI', 290, true, 'MIT'),
    asr('whisper-small', 'OpenAI', 480, false, 'MIT'),
    asr('whisper-medium', 'OpenAI', 900, false, 'MIT'),
    asr('whisper-large-v3-turbo', 'OpenAI', 1300, false, 'MIT'),
    asr('nemotron-speech-streaming-en-0.6b', 'NVIDIA', 700, true),
    asr('parakeet-tdt-0.6b', 'NVIDIA', 700, false),
    chat('qwen2.5-0.5b', 'Alibaba', 530, true, { license: 'Apache-2.0', tools: true }),
    chat('qwen2.5-1.5b', 'Alibaba', 1100, false, { license: 'Apache-2.0', tools: true }),
    chat('qwen2.5-7b', 'Alibaba', 4700, false, { license: 'Apache-2.0', tools: true }),
    chat('qwen3-0.6b', 'Alibaba', 640, true, { license: 'Apache-2.0', tools: true }),
    chat('qwen3-4b', 'Alibaba', 2600, false, { license: 'Apache-2.0', tools: true }),
    chat('phi-3.5-mini', 'Microsoft', 2600, true, { license: 'MIT' }),
    chat('phi-4-mini', 'Microsoft', 2700, false, { license: 'MIT', tools: true }),
    chat('ministral-3-3b', 'Mistral AI', 4700, false, { modalities: ['text', 'image'], task: 'vision-language-chat', tools: true }),
    chat('smollm3-3b', 'Hugging Face', 1900, false),
    chat('gemma-4-e2b', 'Google', 6000, false, { modalities: ['text', 'image', 'audio'] }),
    chat('qwen3-embedding-0.6b', 'Alibaba', 640, false, { task: 'embeddings', license: 'Apache-2.0' }),
  ];
}
