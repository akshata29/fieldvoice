/**
 * TypeScript mirror of backend/schemas/*.py (the source of truth for every JSON shape).
 * Pydantic enums are string-literal unions. Fields with defaults are always present in server responses.
 * Request bodies use the `*Input` helper types where the server fills in defaults.
 */

// ---- scalars / enums ----------------------------------------------------------------------------
export type Scalar = string | number | boolean | null;
export type Iso = string; // ISO-8601 UTC timestamp ending in "Z" (dates: YYYY-MM-DD)

export type FieldType = 'enum' | 'entity_ref' | 'number' | 'boolean' | 'text';
export type FieldStatus = 'filled' | 'needs_review' | 'missing' | 'conflict';
export type FieldSource = 'rule' | 'embedding' | 'llm' | 'user' | 'prefill';

export type EngineKind = 'stt' | 'llm' | 'embedding';
export type AvailabilityState = 'ready' | 'needs_download' | 'unavailable' | 'error';
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ReadinessStatus = 'pass' | 'warn' | 'fail' | 'running' | 'pending';
export type OutboxState = 'pending' | 'sending' | 'synced' | 'failed' | 'conflict';
export type OutboxKind = 'completion' | 'photo';
export type DraftStatus = 'none' | 'draft' | 'approved' | 'synced' | 'conflict';
export type PersistedDraftStatus = 'draft' | 'approved' | 'synced' | 'conflict';
export type Priority = 'low' | 'normal' | 'high' | 'emergency';
export type WorkOrderStatus = 'assigned' | 'in_progress' | 'completed';
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type DatasetSplit = 'dev' | 'heldout';
export type AuthMode = 'online' | 'offline_unlock';
export type StageName = 'stt' | 'normalize' | 'resolve' | 'llm' | 'validate';

export const STRATEGY_IDS = ['free_json', 'schema_constrained', 'enum_grammar', 'hybrid', 'rules_only'] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

/** Special engine ids (schemas/engines.py). */
export const ORACLE_STT_ID = 'oracle:stt:transcript';
export const NO_LLM_ID = 'rules:llm:none';

// ---- forms (schemas/forms.py) -------------------------------------------------------------------
export interface CodeOption {
  code: string;
  label: string;
  synonyms: string[];
}

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  help: string | null;
  options: CodeOption[];
  entity_kind: string | null;
  role_triggers: string[];
  unit: string | null;
  min_value: number | null;
  max_value: number | null;
  unit_triggers: string[];
  label_triggers: string[];
  true_triggers: string[];
  fill_from_transcript: boolean;
  max_length: number | null;
  required_when: Record<string, string> | null;
}

export interface FormSchema {
  id: string;
  version: number;
  title: string;
  work_type: string;
  description: string | null;
  fields: FieldSpec[];
}

// ---- extraction (schemas/extraction.py) ---------------------------------------------------------
export interface Evidence {
  /** Character span in ExtractionResult.transcript_normalized. */
  start: number;
  end: number;
  text: string;
}

export interface FieldValue {
  key: string;
  value: Scalar;
  source: FieldSource | null;
  confidence: number;
  status: FieldStatus;
  evidence: Evidence | null;
  note: string | null;
  candidates: string[];
}

export interface StageTiming {
  stage: string; // "stt" | "normalize" | "resolve" | "llm" | "validate" | ...
  ms: number;
  detail: Record<string, unknown>;
}

export interface ExtractionResult {
  transcript_raw: string;
  transcript_normalized: string;
  fields: Record<string, FieldValue>;
  unresolved: string[];
  timings: StageTiming[];
  total_ms: number;
  audio_ms: number | null;
  stt_ms: number | null;
  stt_engine_id: string | null;
  llm_engine_id: string | null;
  strategy_id: string;
  llm_prompt_tokens: number | null;
  llm_output_tokens: number | null;
  warnings: string[];
  error: string | null;
}

// ---- reference data (schemas/reference.py) ------------------------------------------------------
export interface Asset {
  id: string;
  kind: string; // "pole" | "transformer" | "stock_unit" | "meter" | "feeder" | ...
  label: string;
  location: string | null;
  attributes: Record<string, string>;
}

export interface Worker {
  id: string;
  name: string;
  role: string;
  crew: string;
}

export interface KbSection {
  heading: string;
  text: string;
}

export interface KbDoc {
  id: string;
  title: string;
  applies_to: string[];
  revision: string;
  effective_date: string;
  sections: KbSection[];
}

// ---- work orders, bundle, drafts, outbox (schemas/workorders.py) --------------------------------
export interface WorkOrder {
  id: string;
  title: string;
  description: string;
  location: string;
  scheduled_for: string; // ISO date
  priority: Priority;
  status: WorkOrderStatus;
  worker_id: string;
  form_id: string;
  form_version: number;
  asset_ids: string[];
  kb_doc_ids: string[];
  version: number;
  prefill: Record<string, Scalar>;
}

export interface ModelRequirement {
  role: 'stt' | 'llm' | 'embedding';
  engine_id: string;
  alias: string;
  device: string;
  required: boolean;
}

export interface ModelManifest {
  requirements: ModelRequirement[];
}

export interface Bundle {
  bundle_id: string;
  worker: Worker;
  issued_at: Iso;
  expires_at: Iso;
  work_orders: WorkOrder[];
  forms: FormSchema[];
  assets: Asset[];
  kb_docs: KbDoc[];
  model_manifest: ModelManifest;
  content_hash: string;
}

export interface BundleSummary {
  bundle_id: string;
  worker_id: string;
  issued_at: Iso;
  expires_at: Iso;
  n_work_orders: number;
  n_forms: number;
  n_assets: number;
  n_kb_docs: number;
  content_hash: string;
}

export interface PhotoRef {
  id: string;
  filename: string;
  content_type: string;
  sha256: string;
  size_bytes: number;
  taken_at: Iso;
}

export interface FormDraft {
  work_order_id: string;
  form_id: string;
  form_version: number;
  base_version: number;
  values: Record<string, FieldValue>;
  transcript: string | null;
  stt_engine_id: string | null;
  llm_engine_id: string | null;
  strategy_id: string | null;
  timings: StageTiming[];
  photos: PhotoRef[];
  status: PersistedDraftStatus;
  operation_id: string | null;
  updated_at: Iso;
  approved_at: Iso | null;
}

export interface OutboxItem {
  id: string;
  kind: OutboxKind;
  work_order_id: string;
  state: OutboxState;
  attempts: number;
  last_error: string | null;
  created_at: Iso;
  updated_at: Iso;
  base_version: number;
  server_version: number | null;
  detail: Record<string, unknown>;
}

export interface SyncSummary {
  attempted: number;
  synced: number;
  failed: number;
  conflicts: number;
  items: OutboxItem[];
}

export interface AuthSession {
  worker: Worker;
  token: string;
  issued_at: Iso;
  expires_at: Iso;
  offline_grant_expires_at: Iso;
  mode: AuthMode;
}

// ---- system (schemas/system.py) -----------------------------------------------------------------
export interface HardwareInfo {
  cpu_name: string;
  physical_cores: number | null;
  logical_cores: number | null;
  ram_gb: number | null;
  os: string;
  os_build: string | null;
  python_version: string;
  device_profile: string;
  battery_present: boolean | null;
  notes: string[];
}

export interface FoundryStatus {
  available: boolean;
  sdk_version: string | null;
  catalog_count: number | null;
  eps_registered: boolean;
  model_cache_dir: string | null;
  error: string | null;
}

export interface ConnectivityState {
  online: boolean;
  since: Iso;
}

export interface ReadinessCheck {
  id: string; // "auth" | "bundle" | "forms" | "kb" | "models_cached" | "models_load" | "self_test" | "disk" | "storage"
  label: string;
  status: ReadinessStatus;
  detail: string;
  duration_ms: number | null;
}

export interface ReadinessReport {
  overall: ReadinessStatus;
  checks: ReadinessCheck[];
  generated_at: Iso;
}

export interface SystemStatus {
  connectivity: ConnectivityState;
  session: AuthSession | null;
  bundle: BundleSummary | null;
  readiness: ReadinessReport | null;
  hardware: HardwareInfo;
  foundry: FoundryStatus;
  version: string;
}

// ---- engines / jobs (schemas/engines.py) --------------------------------------------------------
export interface EngineInfo {
  id: string;
  kind: EngineKind;
  name: string;
  provider: string; // "foundry" | "azure-embedded" | "azure-cloud" | "ort-genai" | "oracle" | "rules" | "mock"
  offline: boolean;
  supports_streaming: boolean;
  availability: AvailabilityState;
  availability_reason: string | null;
  alias: string | null;
  variant_id: string | null;
  device: string | null;
  execution_provider: string | null;
  size_mb: number | null;
  loaded: boolean;
  tags: string[];
}

export interface StrategyInfo {
  id: string;
  name: string;
  description: string;
  uses_llm: boolean;
  deterministic_stages: boolean;
  constrained: boolean;
}

export interface JobStatus<R = unknown> {
  id: string;
  kind: string; // "prepare_engine" | "morning_sync" | "readiness" | "eval_run" | "dataset_build" | "lab_compare" | ...
  state: JobState;
  progress: number; // 0..1
  message: string;
  started_at: Iso | null;
  finished_at: Iso | null;
  result: R | null;
  error: string | null;
}

// ---- evaluation (schemas/eval.py) ---------------------------------------------------------------
export type NoiseKind = 'none' | 'white' | 'pink' | 'wind' | 'engine' | 'crackle' | 'radio' | 'muffled';

export interface NoiseSpec {
  kind: NoiseKind;
  snr_db: number | null;
  reverb: boolean;
}

export interface EvalCase {
  id: string;
  form_id: string;
  form_version: number;
  job_asset_ids: string[];
  spoken_text: string;
  written_text: string;
  audio_path: string | null;
  expected: Record<string, Scalar>;
  tags: string[];
  split: DatasetSplit;
  voice: string | null;
  noise: NoiseSpec | null;
}

export interface EvalDatasetInfo {
  id: string;
  name: string;
  created_at: Iso;
  seed: number;
  n_cases: number;
  n_with_audio: number;
  form_ids: string[];
  tag_counts: Record<string, number>;
  splits: Record<string, number>;
  synthetic: boolean;
}

/** One cell of the evaluation matrix. The matrix key is `${stt}|${llm}|${strategy}` (see lib/engineLabels.configKey). */
export interface RunConfig {
  stt_engine_id: string;
  llm_engine_id: string;
  strategy_id: string;
}

export interface RunRequest {
  dataset_id: string;
  configs: RunConfig[];
  limit: number | null;
  splits: string[] | null;
  tags: string[] | null;
  repeats: number;
  warmup: number;
  confidence_threshold: number;
  label: string | null;
}

export type RunRequestInput = Pick<RunRequest, 'dataset_id' | 'configs'> &
  Partial<Omit<RunRequest, 'dataset_id' | 'configs'>>;

export interface LatencyStats {
  n: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface ConfigMetrics {
  config_key: string;
  config: RunConfig;
  n_cases: number;
  n_errors: number;

  wer: number | null;
  wer_normalized: number | null;
  id_exact_match: number | null;
  rtf: number | null;

  field_accuracy: number;
  id_field_accuracy: number | null;
  accuracy_by_type: Record<string, number>;
  accuracy_by_tag: Record<string, number>;
  form_exact_match: number;
  silent_wrong_rate: number;
  hallucination_rate: number | null;
  review_rate: number;
  safe_outcome_rate: number;
  schema_valid_rate: number | null;

  latency_total: LatencyStats;
  latency_stt: LatencyStats;
  latency_extract: LatencyStats;
  latency_llm: LatencyStats;
  llm_prompt_tokens_mean: number | null;
  llm_output_tokens_mean: number | null;
  cold_start_ms: number | null;
  peak_rss_mb: number | null;
  model_size_mb: number | null;
}

export interface CaseResult {
  case_id: string;
  config_key: string;
  ok: boolean;
  error: string | null;
  tags: string[];
  transcript_hyp: string;
  wer: number | null;
  expected: Record<string, Scalar>;
  field_correct: Record<string, boolean>;
  extraction: ExtractionResult | null;
}

export interface RunSummary {
  run_id: string;
  label: string | null;
  created_at: Iso;
  finished_at: Iso | null;
  dataset_id: string;
  status: RunStatus;
  progress: number;
  hardware: HardwareInfo;
  request: RunRequest;
  configs: ConfigMetrics[];
  notes: string[];
}

export interface DecisionGates {
  max_p95_ms: number;
  min_id_field_accuracy: number;
  max_silent_wrong: number;
  max_peak_rss_mb: number | null;
  min_field_accuracy: number;
}

export interface DecisionRow {
  config_key: string;
  passes: boolean;
  failed_gates: string[];
  score: number;
  rank: number | null;
}

export interface ParetoPoint {
  config_key: string;
  p95_ms: number | null;
  field_accuracy: number;
  silent_wrong_rate: number;
  pareto_optimal: boolean;
}

export interface DecisionReport {
  run_id: string;
  gates: DecisionGates;
  rows: DecisionRow[];
  pareto: ParetoPoint[];
}

// ---- REST request/response models (schemas/api.py) ----------------------------------------------
export interface LoginRequest {
  worker_id: string;
  pin: string;
}

export interface ConnectivityRequest {
  online: boolean;
}

export interface KbHit {
  doc_id: string;
  title: string;
  heading: string;
  snippet: string;
  score: number;
  revision: string;
}

export interface WorkOrderListItem {
  work_order: WorkOrder;
  form_title: string;
  draft_status: DraftStatus;
}

export interface WorkOrderDetail {
  work_order: WorkOrder;
  form: FormSchema;
  /** Job assets + stock inventory: the closed world the pipeline resolves ids against. */
  assets: Asset[];
  draft: FormDraft | null;
  kb: KbHit[];
}

export interface ResolveRequest {
  item_id: string;
  action: 'keep_mine' | 'take_theirs';
}

export interface SorFaults {
  fail_next: number;
  latency_ms: number;
  drop_response_next: number;
  conflict_next: number;
}

export interface BumpRequest {
  title?: string | null;
  note?: string | null;
}

export interface SorState {
  work_orders: WorkOrder[];
  completions: Array<Record<string, unknown>>;
  photos: number;
  faults: SorFaults;
}

export interface EngineList {
  stt: EngineInfo[];
  llm: EngineInfo[];
  strategies: StrategyInfo[];
}

export interface CatalogVariant {
  id: string;
  device: string; // "cpu" | "gpu" | "npu"
  execution_provider: string;
  size_mb: number | null;
  cached: boolean;
}

export interface CatalogModel {
  alias: string;
  task: string; // "chat-completion" | "automatic-speech-recognition" | "embeddings" | "vision-language-chat"
  publisher: string | null;
  license: string | null;
  input_modalities: string[];
  supports_tool_calling: boolean | null;
  variants: CatalogVariant[];
}

export type MorningStepId = 'authenticate' | 'download_bundle' | 'sync_reference' | 'ensure_models' | 'readiness';

export interface MorningStep {
  id: MorningStepId;
  label: string;
  status: ReadinessStatus;
  detail: string;
  duration_ms: number | null;
}

export interface MorningResult {
  steps: MorningStep[];
  readiness: ReadinessReport | null;
  ready_to_go_offline: boolean;
}

export interface SampleInfo {
  id: string;
  form_id: string;
  tags: string[];
  split: string;
  has_audio: boolean;
  spoken_text: string;
  written_text: string;
  expected: Record<string, Scalar>;
  noise: NoiseSpec | null;
  voice: string | null;
  audio_url: string | null;
}

/** Provide exactly one of `transcript` or `sample_id`. For uploaded audio use the multipart route. */
export interface ExtractRequest {
  work_order_id?: string | null;
  form_id?: string | null;
  transcript?: string | null;
  sample_id?: string | null;
  stt_engine_id?: string;
  llm_engine_id?: string;
  strategy_id?: string;
}

export interface LabCompareRequest {
  work_order_id?: string | null;
  form_id?: string | null;
  sample_id?: string | null;
  transcript?: string | null;
  combos: RunConfig[];
}

export interface LabCompareItem {
  config: RunConfig;
  extraction: ExtractionResult | null;
  field_correct: Record<string, boolean> | null;
  error: string | null;
}

export interface LabCompareResult {
  expected: Record<string, Scalar> | null;
  items: LabCompareItem[];
}

export interface DatasetGenerateRequest {
  name?: string;
  n_cases?: number;
  seed?: number;
  with_audio?: boolean;
  audio_limit?: number | null;
  augment?: boolean;
}

export interface RunStarted {
  run_id: string;
}

// ---- WebSocket /ws/voice (docs/CONTRACT.md section 7) -------------------------------------------
export interface VoiceStartMessage {
  type: 'start';
  work_order_id: string | null;
  form_id: string | null;
  stt_engine_id: string;
  llm_engine_id: string;
  strategy_id: string;
  sample_rate: 16000;
}

export type VoiceClientMessage =
  | VoiceStartMessage
  | { type: 'stop' }
  | { type: 'play_sample'; sample_id: string; realtime: boolean }
  | { type: 'cancel' };

export type VoiceStageName = 'normalize' | 'resolve' | 'llm' | 'validate';

export type VoiceServerEvent =
  | { type: 'ready' }
  | { type: 'partial'; text: string; t_ms: number }
  | { type: 'transcript'; text: string; final: true; stt_ms: number; audio_ms: number }
  | { type: 'stage'; stage: VoiceStageName; ms: number }
  | { type: 'fields'; stage: 'resolve' | 'llm' | 'validate'; fields: Record<string, FieldValue>; unresolved: string[] }
  | { type: 'result'; result: ExtractionResult }
  | { type: 'error'; message: string };

/** Typed job payloads (JobStatus.result). */
export type MorningJob = JobStatus<MorningResult>;
export type LabCompareJob = JobStatus<LabCompareResult>;
export type EvalRunJob = JobStatus<RunStarted>;
export type DatasetBuildJob = JobStatus<EvalDatasetInfo>;
export type ReadinessJob = JobStatus<ReadinessReport>;
