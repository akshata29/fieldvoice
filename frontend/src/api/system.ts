import { http } from './http';
import type {
  AuthSession,
  BundleSummary,
  ConnectivityRequest,
  ConnectivityState,
  HardwareInfo,
  JobStatus,
  LoginRequest,
  MorningJob,
  ReadinessJob,
  ReadinessReport,
  SystemStatus,
  Worker,
} from './types';

const data = <T>(r: { data: T }): T => r.data;

export const systemApi = {
  status: () => http.get<SystemStatus>('/system/status').then(data),
  /** Device airplane-mode switch. Only the device is affected; the dispatcher console stays reachable. */
  setConnectivity: (online: boolean) =>
    http.post<ConnectivityState>('/system/connectivity', { online } satisfies ConnectivityRequest).then(data),
  hardware: () => http.get<HardwareInfo>('/system/hardware').then(data),
};

export const jobsApi = {
  list: () => http.get<JobStatus[]>('/jobs').then(data),
  get: <R = unknown>(id: string) => http.get<JobStatus<R>>(`/jobs/${encodeURIComponent(id)}`).then(data),
  cancel: <R = unknown>(id: string) => http.post<JobStatus<R>>(`/jobs/${encodeURIComponent(id)}/cancel`).then(data),
};

export const isTerminalJob = (job: Pick<JobStatus, 'state'> | null | undefined): boolean =>
  job?.state === 'succeeded' || job?.state === 'failed' || job?.state === 'cancelled';

export const authApi = {
  workers: () => http.get<Worker[]>('/auth/workers').then(data),
  login: (body: LoginRequest) => http.post<AuthSession>('/auth/login', body).then(data),
  logout: () => http.post<void>('/auth/logout').then(() => undefined),
  session: () => http.get<AuthSession | null>('/auth/session').then(data),
};

export const morningApi = {
  /** Starts the five-step morning job; `result` is a MorningResult that fills in as the job runs. */
  start: () => http.post<MorningJob>('/morning/start').then(data),
};

export const bundleApi = {
  get: () => http.get<BundleSummary | null>('/bundle').then(data),
  sync: () => http.post<JobStatus<BundleSummary>>('/bundle/sync').then(data),
};

export const readinessApi = {
  get: () => http.get<ReadinessReport | null>('/readiness').then(data),
  run: () => http.post<ReadinessJob>('/readiness/run').then(data),
};
