import type { AxiosInstance } from 'axios';
import { createMockAdapter } from './adapter';

/** Routes every request of the given axios instance to the in-memory mock backend. */
export function installMocks(http: AxiosInstance): void {
  http.defaults.adapter = createMockAdapter();
  console.info('[Field Voice] Mock mode: all data is simulated. Nothing is measured and no backend is contacted.');
}
