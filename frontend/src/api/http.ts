import axios from 'axios';
import { API_BASE_URL } from '@/lib/env';
import { toApiError } from './errors';

/** The one axios instance. Mock mode swaps `http.defaults.adapter` (see src/mocks/install.ts). */
export const http = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30_000,
  headers: { Accept: 'application/json' },
});

http.interceptors.response.use(
  (response) => response,
  (error: unknown) => Promise.reject(toApiError(error)),
);
