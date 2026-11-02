/** Query keys and the shared read hooks (TanStack Query v5). Mutations live next to the pages that use them. */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  authApi,
  bundleApi,
  enginesApi,
  evalApi,
  isTerminalJob,
  jobsApi,
  readinessApi,
  sorApi,
  syncApi,
  systemApi,
  workOrdersApi,
} from '@/api/client';
import type { EvalDatasetInfo, JobStatus, RunSummary, SystemStatus } from '@/api/client';

export const qk = {
  status: ['system', 'status'] as const,
  hardware: ['system', 'hardware'] as const,
  workers: ['auth', 'workers'] as const,
  session: ['auth', 'session'] as const,
  bundle: ['bundle'] as const,
  readiness: ['readiness'] as const,
  workOrders: ['workorders'] as const,
  workOrder: (id: string) => ['workorders', id] as const,
  kb: (q: string, workOrderId: string | null) => ['kb', q, workOrderId] as const,
  outbox: ['sync', 'outbox'] as const,
  sor: ['sor', 'state'] as const,
  engines: ['engines'] as const,
  catalog: ['engines', 'catalog'] as const,
  samples: (formId: string | null, tag: string | null) => ['samples', formId, tag] as const,
  datasets: ['eval', 'datasets'] as const,
  datasetCases: (id: string, tag: string | null, split: string | null, offset: number) => ['eval', 'datasets', id, 'cases', tag, split, offset] as const,
  runs: ['eval', 'runs'] as const,
  run: (id: string) => ['eval', 'runs', id] as const,
  runCases: (id: string, configKey: string | null, onlyFailures: boolean, offset: number) =>
    ['eval', 'runs', id, 'cases', configKey, onlyFailures, offset] as const,
  decision: (id: string, gates: unknown) => ['eval', 'runs', id, 'decision', gates] as const,
  job: (id: string | null | undefined) => ['jobs', id] as const,
};

export const STATUS_POLL_MS = 3000;

export function useSystemStatus() {
  return useQuery({
    queryKey: qk.status,
    queryFn: systemApi.status,
    refetchInterval: STATUS_POLL_MS,
    staleTime: 1000,
    retry: false,
  });
}

/** Connectivity is the one flag every screen branches on; defaults to online until the first status arrives. */
export function useOnline(): boolean {
  const { data } = useSystemStatus();
  return data?.connectivity.online ?? true;
}

export function useRefreshStatus() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: qk.status });
}

export const refreshStatus = (qc: QueryClient) => qc.invalidateQueries({ queryKey: qk.status });

export function useWorkers() {
  return useQuery({ queryKey: qk.workers, queryFn: authApi.workers, staleTime: 60_000 });
}

export function useSession() {
  return useQuery({ queryKey: qk.session, queryFn: authApi.session, staleTime: 5_000 });
}

export function useBundle() {
  return useQuery({ queryKey: qk.bundle, queryFn: bundleApi.get, staleTime: 5_000 });
}

export function useReadiness() {
  return useQuery({ queryKey: qk.readiness, queryFn: readinessApi.get, staleTime: 5_000 });
}

export function useWorkOrders() {
  return useQuery({ queryKey: qk.workOrders, queryFn: workOrdersApi.list, staleTime: 2_000 });
}

export function useOutbox() {
  return useQuery({
    queryKey: qk.outbox,
    queryFn: syncApi.outbox,
    refetchInterval: (q) => (q.state.data?.some((i) => i.state === 'pending' || i.state === 'sending') ? 2000 : 4000),
  });
}

export function useSorState() {
  return useQuery({ queryKey: qk.sor, queryFn: sorApi.state, refetchInterval: 3000 });
}

export function useEngines(poll = false) {
  return useQuery({ queryKey: qk.engines, queryFn: enginesApi.list, staleTime: 3_000, refetchInterval: poll ? 5_000 : false });
}

export function useDatasets() {
  return useQuery<EvalDatasetInfo[]>({ queryKey: qk.datasets, queryFn: evalApi.datasets, staleTime: 5_000 });
}

export function useRuns() {
  return useQuery<RunSummary[]>({
    queryKey: qk.runs,
    queryFn: evalApi.runs,
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 2500 : false),
  });
}

/** Polls one job until it reaches a terminal state. */
export function useJob<R = unknown>(jobId: string | null | undefined, intervalMs = 700) {
  return useQuery<JobStatus<R>>({
    queryKey: qk.job(jobId),
    queryFn: () => jobsApi.get<R>(jobId as string),
    enabled: !!jobId,
    refetchInterval: (q) => (isTerminalJob(q.state.data) ? false : intervalMs),
    staleTime: 0,
    gcTime: 60_000,
    retry: 2,
  });
}

export function useSetConnectivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (online: boolean) => systemApi.setConnectivity(online),
    onMutate: async (online) => {
      await qc.cancelQueries({ queryKey: qk.status });
      const previous = qc.getQueryData<SystemStatus>(qk.status);
      if (previous) {
        qc.setQueryData<SystemStatus>(qk.status, { ...previous, connectivity: { online, since: new Date().toISOString() } });
      }
      return { previous };
    },
    onError: (_err, _online, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.status, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.status });
    },
  });
}

/** After anything that changes local state, make every dependent screen re-read it. */
export function invalidateLocalState(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: qk.status });
  void qc.invalidateQueries({ queryKey: qk.workOrders });
  void qc.invalidateQueries({ queryKey: qk.outbox });
}
