/** Build-time flags. `VITE_USE_MOCKS=true` (or `vite --mode mock`) swaps the network for in-memory fixtures. */
export const USE_MOCKS: boolean = import.meta.env.VITE_USE_MOCKS === 'true';

export const ROUTER_MODE: 'hash' | 'browser' = import.meta.env.VITE_ROUTER === 'browser' ? 'browser' : 'hash';

export const API_BASE_URL = '/api/v1';
