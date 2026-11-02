/** Tiny route table for the mock backend: `route('GET', '/workorders/:id', handler)`. Paths are relative to /api/v1. */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(typeof detail === 'string' ? detail : ((detail as { message?: string } | null)?.message ?? `HTTP ${status}`));
    this.name = 'HttpError';
  }
}

export const offlineError = (message: string): HttpError => new HttpError(503, { code: 'offline', message });
export const unauthenticatedError = (): HttpError => new HttpError(401, { code: 'unauthenticated', message: 'Not signed in. Sign in on the Morning screen first.' });
export const notFound = (what: string): HttpError => new HttpError(404, `${what} not found`);
export const badRequest = (message: string): HttpError => new HttpError(422, message);

export interface RouteContext {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  /** Parsed JSON body (or undefined). */
  body: unknown;
  /** Multipart body, when the request was a FormData upload. */
  form: FormData | null;
}

export interface RouteResult {
  status?: number;
  data?: unknown;
  headers?: Record<string, string>;
}

export type RouteHandler = (ctx: RouteContext) => RouteResult | Promise<RouteResult>;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

export function route(method: string, pattern: string, handler: RouteHandler): void {
  routes.push({ method: method.toUpperCase(), segments: pattern.split('/').filter(Boolean), handler });
}

export function matchRoute(method: string, path: string): { handler: RouteHandler; params: Record<string, string> } | null {
  const parts = path.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method || r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const seg = r.segments[i] as string;
      const part = parts[i] as string;
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(part);
      else if (seg !== part) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

export const json = (data: unknown, status = 200): RouteResult => ({ status, data });
export const noContent = (): RouteResult => ({ status: 204, data: '' });
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const intParam = (v: string | undefined, fallback: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

let sleepScale = 1;
/** Tests set 0 so simulated server-side waits (sync latency, extraction time) resolve immediately. */
export function setMockSleepScale(scale: number): void {
  sleepScale = scale;
}
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms * sleepScale)));
