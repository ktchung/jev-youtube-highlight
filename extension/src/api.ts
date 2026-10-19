import type { Analysis, Health, Job, VideoMetadata } from './types';

export const HELPER_URL = 'http://127.0.0.1:8765';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${HELPER_URL}${path}`, {
      ...options,
      headers: { ...options?.headers, ...(options?.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('Cannot reach the local helper. Start it on 127.0.0.1:8765, then reconnect.');
  }
  if (!response.ok) {
    let message = `Helper returned ${response.status}.`;
    try {
      const body = await response.json();
      message = typeof body.detail === 'string' ? body.detail : typeof body.error === 'string' ? body.error : message;
    } catch { /* HTTP status remains available if response is not JSON. */ }
    throw new ApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<Health>('/health'),
  cached: (videoId: string) => request<Analysis>(`/api/videos/${encodeURIComponent(videoId)}/analysis`),
  analyze: (metadata: VideoMetadata, subject: string, force: boolean) => request<Job>('/api/analyses', {
    method: 'POST', body: JSON.stringify({ ...metadata, subject: subject.trim() || null, force }),
  }),
  job: (id: string) => request<Job>(`/api/analyses/${encodeURIComponent(id)}`),
};
