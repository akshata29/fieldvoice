/** Normalised API errors. FastAPI sends `{detail: string | {code, message, ...} | [{loc, msg, type}]}`. */
import { isAxiosError } from 'axios';

export type KnownErrorCode = 'offline' | 'unauthenticated' | 'version_conflict';
export type ApiErrorCode = KnownErrorCode | 'network' | 'timeout' | 'validation' | 'not_found' | 'server' | 'unknown';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: ApiErrorCode | string,
    readonly status: number | null,
    readonly detail: unknown = null,
    readonly serverVersion: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface DetailObject {
  code?: string;
  message?: string;
  server_version?: number;
}

function isDetailObject(v: unknown): v is DetailObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validationMessage(detail: unknown[]): string {
  return detail
    .map((d) => {
      if (isDetailObject(d)) {
        const rec = d as unknown as { loc?: unknown[]; msg?: string };
        const where = Array.isArray(rec.loc) ? rec.loc.filter((p) => p !== 'body').join('.') : '';
        return where ? `${where}: ${rec.msg ?? 'invalid'}` : (rec.msg ?? 'invalid');
      }
      return String(d);
    })
    .join('; ');
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (isAxiosError(error)) {
    const status = error.response?.status ?? null;
    if (!error.response) {
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        return new ApiError('The request timed out.', 'timeout', null);
      }
      return new ApiError('Cannot reach the backend. Is it running?', 'network', null);
    }
    const body: unknown = error.response.data;
    const detail = isDetailObject(body) && 'detail' in body ? (body as { detail: unknown }).detail : body;
    if (typeof detail === 'string') {
      return new ApiError(detail, status === 404 ? 'not_found' : 'server', status, detail);
    }
    if (Array.isArray(detail)) return new ApiError(validationMessage(detail), 'validation', status, detail);
    if (isDetailObject(detail)) {
      const code = detail.code ?? (status === 404 ? 'not_found' : 'server');
      return new ApiError(detail.message ?? `Request failed (${status})`, code, status, detail, detail.server_version ?? null);
    }
    return new ApiError(`Request failed (${status})`, status === 404 ? 'not_found' : 'server', status, body);
  }
  if (error instanceof Error) return new ApiError(error.message, 'unknown', null);
  return new ApiError(String(error), 'unknown', null);
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
export const isOfflineError = (e: unknown): boolean => isApiError(e) && e.code === 'offline';
export const isUnauthenticated = (e: unknown): boolean => isApiError(e) && e.code === 'unauthenticated';
export const isVersionConflict = (e: unknown): boolean => isApiError(e) && e.code === 'version_conflict';

export function errorMessage(e: unknown): string {
  return toApiError(e).message;
}
