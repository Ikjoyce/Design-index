import type { CaptureResult, LibraryItem, LibraryPage } from '@design-index/shared/browser';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { credentials: 'same-origin', ...options }); }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('Library not connected. Check that the local server is running, then reload.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `The library returned an error (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  connect: () => request<{ ready: boolean }>('/api/session'),
  list: (q: string, offset = 0, signal?: AbortSignal) => request<LibraryPage>(`/api/items?${new URLSearchParams({ q, offset: String(offset) })}`, { signal }),
  capture: (file: File, title: string, note: string) => {
    const body = new FormData();
    body.set('image', file);
    body.set('title', title);
    body.set('note', note);
    return request<CaptureResult>('/api/items', { method: 'POST', body });
  },
  update: (id: string, title: string, note: string) => request<LibraryItem>(`/api/items/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, note }),
  }),
};
