import { http } from './http';
import type {
  CatalogModel,
  CaseResult,
  DatasetBuildJob,
  DatasetGenerateRequest,
  DecisionGates,
  DecisionReport,
  EngineInfo,
  EngineList,
  EvalCase,
  EvalDatasetInfo,
  EvalRunJob,
  ExtractRequest,
  ExtractionResult,
  JobStatus,
  LabCompareJob,
  LabCompareRequest,
  RunRequestInput,
  RunSummary,
  SampleInfo,
} from './types';
export { sampleAudioUrl } from './urls';

const data = <T>(r: { data: T }): T => r.data;

export const enginesApi = {
  list: () => http.get<EngineList>('/engines').then(data),
  catalog: () => http.get<CatalogModel[]>('/engines/catalog').then(data),
  /** Download + load; poll the returned job (progress 0..1). */
  prepare: (engineId: string) => http.post<JobStatus>(`/engines/${encodeURIComponent(engineId)}/prepare`).then(data),
  unload: (engineId: string) => http.post<EngineInfo>(`/engines/${encodeURIComponent(engineId)}/unload`).then(data),
};

export interface SampleQuery {
  form_id?: string;
  tag?: string;
  limit?: number;
}

export const samplesApi = {
  list: (query: SampleQuery = {}) => http.get<SampleInfo[]>('/samples', { params: query }).then(data),
};

export interface ExtractAudioParams {
  work_order_id?: string | null;
  form_id?: string | null;
  stt_engine_id: string;
  llm_engine_id: string;
  strategy_id: string;
}

export const voiceApi = {
  extract: (body: ExtractRequest) => http.post<ExtractionResult>('/voice/extract', body, { timeout: 120_000 }).then(data),
  /** Multipart: `audio` (WAV) + form fields. */
  extractAudio: (audio: Blob, params: ExtractAudioParams, filename = 'recording.wav') => {
    const body = new FormData();
    body.append('audio', audio, filename);
    if (params.work_order_id) body.append('work_order_id', params.work_order_id);
    if (params.form_id) body.append('form_id', params.form_id);
    body.append('stt_engine_id', params.stt_engine_id);
    body.append('llm_engine_id', params.llm_engine_id);
    body.append('strategy_id', params.strategy_id);
    return http.post<ExtractionResult>('/voice/extract-audio', body, { timeout: 180_000 }).then(data);
  },
};

export const labApi = {
  compare: (body: LabCompareRequest) => http.post<LabCompareJob>('/lab/compare', body).then(data),
};

export interface DatasetCasesQuery {
  offset?: number;
  limit?: number;
  tag?: string;
  split?: string;
}

export interface RunCasesQuery {
  config_key?: string;
  only_failures?: boolean;
  offset?: number;
  limit?: number;
}

export type ExportFormat = 'csv' | 'json';

export const evalApi = {
  datasets: () => http.get<EvalDatasetInfo[]>('/eval/datasets').then(data),
  datasetCases: (datasetId: string, query: DatasetCasesQuery = {}) =>
    http.get<EvalCase[]>(`/eval/datasets/${encodeURIComponent(datasetId)}/cases`, { params: query }).then(data),
  generateDataset: (body: DatasetGenerateRequest = {}) => http.post<DatasetBuildJob>('/eval/datasets/generate', body).then(data),

  runs: () => http.get<RunSummary[]>('/eval/runs').then(data),
  run: (runId: string) => http.get<RunSummary>(`/eval/runs/${encodeURIComponent(runId)}`).then(data),
  createRun: (body: RunRequestInput) => http.post<EvalRunJob>('/eval/runs', body).then(data),
  runCases: (runId: string, query: RunCasesQuery = {}) =>
    http.get<CaseResult[]>(`/eval/runs/${encodeURIComponent(runId)}/cases`, { params: query }).then(data),
  decision: (runId: string, gates: DecisionGates) =>
    http
      .get<DecisionReport>(`/eval/runs/${encodeURIComponent(runId)}/decision`, {
        params: {
          max_p95_ms: gates.max_p95_ms,
          min_id_field_accuracy: gates.min_id_field_accuracy,
          max_silent_wrong: gates.max_silent_wrong,
          max_peak_rss_mb: gates.max_peak_rss_mb ?? undefined,
          min_field_accuracy: gates.min_field_accuracy,
        },
      })
      .then(data),
  exportRun: async (runId: string, format: ExportFormat): Promise<{ blob: Blob; filename: string }> => {
    const response = await http.get<Blob>(`/eval/runs/${encodeURIComponent(runId)}/export`, {
      params: { format },
      responseType: 'blob',
    });
    const disposition = String(response.headers['content-disposition'] ?? '');
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    return { blob: response.data, filename: match?.[1] ?? `run-${runId}.${format}` };
  },
  deleteRun: (runId: string) => http.delete<void>(`/eval/runs/${encodeURIComponent(runId)}`).then(() => undefined),
};
