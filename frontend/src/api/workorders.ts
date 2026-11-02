import { http } from './http';
import type {
  BumpRequest,
  FormDraft,
  KbHit,
  OutboxItem,
  PhotoRef,
  ResolveRequest,
  SorFaults,
  SorState,
  SyncSummary,
  WorkOrder,
  WorkOrderDetail,
  WorkOrderListItem,
} from './types';
export { photoUrl } from './urls';

const data = <T>(r: { data: T }): T => r.data;

export const workOrdersApi = {
  list: () => http.get<WorkOrderListItem[]>('/workorders').then(data),
  get: (id: string) => http.get<WorkOrderDetail>(`/workorders/${encodeURIComponent(id)}`).then(data),
  /** Autosave. The draft stays `draft` until approve. */
  saveDraft: (id: string, draft: FormDraft) =>
    http.put<FormDraft>(`/workorders/${encodeURIComponent(id)}/draft`, draft).then(data),
  /** Atomic approve + outbox rows. Works offline. */
  approve: (id: string) => http.post<FormDraft>(`/workorders/${encodeURIComponent(id)}/approve`).then(data),
  uploadPhoto: (id: string, file: File | Blob, filename?: string) => {
    const body = new FormData();
    body.append('file', file, filename ?? (file instanceof File ? file.name : 'photo.jpg'));
    return http.post<PhotoRef>(`/workorders/${encodeURIComponent(id)}/photos`, body, { timeout: 120_000 }).then(data);
  },
};

export const kbApi = {
  search: (q: string, workOrderId?: string | null, k = 5) =>
    http.get<KbHit[]>('/kb/search', { params: { q, work_order_id: workOrderId ?? undefined, k } }).then(data),
};

export const syncApi = {
  outbox: () => http.get<OutboxItem[]>('/sync/outbox').then(data),
  /** Needs connectivity (503 `offline` otherwise). */
  run: () => http.post<SyncSummary>('/sync/run', undefined, { timeout: 120_000 }).then(data),
  resolve: (body: ResolveRequest) => http.post<OutboxItem>('/sync/resolve', body).then(data),
};

/** The dispatcher console talks to the remote system of record; it is reachable regardless of the device switch. */
export const sorApi = {
  state: () => http.get<SorState>('/sor/state').then(data),
  bump: (workOrderId: string, body: BumpRequest = {}) =>
    http.post<WorkOrder>(`/sor/workorders/${encodeURIComponent(workOrderId)}/bump`, body).then(data),
  setFaults: (faults: SorFaults) => http.post<SorFaults>('/sor/faults', faults).then(data),
  /** `device: true` also wipes this device's local store (a clean demo take). */
  reset: (opts: { device?: boolean } = {}) =>
    http.post<void>('/sor/reset', undefined, { params: opts.device ? { device: true } : undefined }).then(() => undefined),
};
