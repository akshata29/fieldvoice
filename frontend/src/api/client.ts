/** Barrel for the typed API client. Each namespace maps 1:1 to a group of endpoints in docs/CONTRACT.md section 6. */
export { http } from './http';
export { ApiError, errorMessage, isApiError, isOfflineError, isUnauthenticated, isVersionConflict, toApiError } from './errors';
export { authApi, bundleApi, isTerminalJob, jobsApi, morningApi, readinessApi, systemApi } from './system';
export { kbApi, photoUrl, sorApi, syncApi, workOrdersApi } from './workorders';
export { enginesApi, evalApi, labApi, sampleAudioUrl, samplesApi, voiceApi } from './engines';
export type { DatasetCasesQuery, ExportFormat, ExtractAudioParams, RunCasesQuery, SampleQuery } from './engines';
export * from './types';
