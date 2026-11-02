/**
 * URL helpers for binary resources that the browser fetches directly (<img src>, <audio src>).
 * In mock mode the adapter registers blob/data URLs here because the dev server has no such routes.
 */
import { API_BASE_URL } from '@/lib/env';

const overrides = new Map<string, string>();

export function registerResourceUrl(path: string, url: string): void {
  overrides.set(path, url);
}

export function resourceUrl(path: string): string {
  return overrides.get(path) ?? `${API_BASE_URL}${path}`;
}

export const photoUrl = (photoId: string): string => resourceUrl(`/photos/${encodeURIComponent(photoId)}`);
export const sampleAudioUrl = (sampleId: string): string => resourceUrl(`/samples/${encodeURIComponent(sampleId)}/audio`);
