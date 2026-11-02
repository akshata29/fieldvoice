/** Axios adapter that answers every request from the in-memory mock backend (no network involved). */
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import './handlers';
import './handlersLab';
import { HttpError, matchRoute, sleep } from './router';

let latency: [number, number] = [35, 110];

/** Tests set (0, 0) to run instantly. */
export function setMockLatency(minMs: number, maxMs: number): void {
  latency = [minMs, maxMs];
}

function stripBase(url: string, baseURL: string | undefined): string {
  let path = url;
  if (baseURL && path.startsWith(baseURL)) path = path.slice(baseURL.length);
  const hash = path.indexOf('#');
  return hash >= 0 ? path.slice(0, hash) : path;
}

function splitQuery(url: string, params: unknown): { path: string; query: Record<string, string | undefined> } {
  const q = url.indexOf('?');
  const path = q >= 0 ? url.slice(0, q) : url;
  const query: Record<string, string | undefined> = {};
  if (q >= 0) new URLSearchParams(url.slice(q + 1)).forEach((v, k) => (query[k] = v));
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      query[k] = String(v);
    }
  }
  return { path, query };
}

function parseBody(data: unknown): { body: unknown; form: FormData | null } {
  if (data === undefined || data === null || data === '') return { body: undefined, form: null };
  if (typeof FormData !== 'undefined' && data instanceof FormData) return { body: undefined, form: data };
  if (typeof data === 'string') {
    try {
      return { body: JSON.parse(data), form: null };
    } catch {
      return { body: data, form: null };
    }
  }
  return { body: data, form: null };
}

function response(config: InternalAxiosRequestConfig, status: number, data: unknown, headers: Record<string, string> = {}): AxiosResponse {
  return { data, status, statusText: status < 300 ? 'OK' : 'Error', headers, config, request: {} };
}

export function createMockAdapter(): AxiosAdapter {
  return async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const method = (config.method ?? 'get').toUpperCase();
    const { path, query } = splitQuery(stripBase(config.url ?? '', config.baseURL), config.params);
    const { body, form } = parseBody(config.data);

    const [min, max] = latency;
    const quick = path.startsWith('/jobs') || path === '/system/status' || path === '/sync/outbox';
    if (max > 0) await sleep(quick ? Math.round(min / 3) : min + Math.random() * (max - min));

    const matched = matchRoute(method, path);
    if (!matched) {
      const res = response(config, 404, { detail: `No mock handler for ${method} ${path}` });
      throw new AxiosError(`Request failed with status code 404`, AxiosError.ERR_BAD_REQUEST, config, {}, res);
    }
    try {
      const result = await matched.handler({ params: matched.params, query, body, form });
      return response(config, result.status ?? 200, result.data, result.headers);
    } catch (error) {
      if (error instanceof HttpError) {
        const res = response(config, error.status, { detail: error.detail });
        throw new AxiosError(
          `Request failed with status code ${error.status}`,
          error.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
          config,
          {},
          res,
        );
      }
      throw error;
    }
  };
}
