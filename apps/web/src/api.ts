import type { AiSettings, AiStatus, CaptureJob, CaptureResult, CaptureSettings, EvaluationRun, EvaluationSample, Facet, InboxStatus, LibraryItem, LibraryPage, PromptHistory, PromptVariant, UrlCaptureRequest, VocabularyState, VocabularyTerms } from '@design-index/shared/browser';

let sessionRefresh: Promise<unknown> | undefined;

async function request<T>(path: string, options?: RequestInit, retrySession = true): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { credentials: 'same-origin', ...options }); }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('Library not connected. Check that the local server is running, then reload.');
  }
  if (response.status === 401 && retrySession && path !== '/api/session') {
    // The server rotates its local session token on restart. A rejected request has not
    // reached its handler, so refresh the HttpOnly cookie and replay it at most once.
    await response.body?.cancel().catch(() => {});
    sessionRefresh ??= request('/api/session', undefined, false).finally(() => { sessionRefresh = undefined; });
    await sessionRefresh;
    return request<T>(path, options, false);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `The library returned an error (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  connect: () => request<{ ready: boolean }>('/api/session'),
  list: (q: string, offset = 0, signal?: AbortSignal, filter?: { facet: Facet; label: string }) => request<LibraryPage>(`/api/items?${new URLSearchParams({ q, offset: String(offset), ...filter })}`, { signal }),
  item: (id: string) => request<LibraryItem>(`/api/items/${id}`),
  ai: () => request<AiStatus>('/api/ai'),
  inbox: () => request<InboxStatus>('/api/inbox'),
  retryInbox: () => request<InboxStatus>('/api/inbox/retry', { method: 'POST' }),
  captures: () => request<{ settings: CaptureSettings; jobs: CaptureJob[] }>('/api/captures'),
  captureUrl: (body: UrlCaptureRequest) => request<CaptureJob>('/api/captures', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  saveCaptureSettings: (body: CaptureSettings) => request<CaptureSettings>('/api/captures/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  cancelCapture: (id: string) => request(`/api/captures/${id}/cancel`, { method: 'POST' }),
  evaluationSamples: () => request<EvaluationSample[]>('/api/evaluation/samples'),
  saveEvaluationSample: (id: string, labels: VocabularyTerms, scoredFacets: Facet[], note: string, baseVersion: number) => request<EvaluationSample[]>(`/api/evaluation/samples/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ labels, scoredFacets, note, baseVersion }) }),
  removeEvaluationSample: (id: string, version: number) => request(`/api/evaluation/samples/${id}?version=${version}`, { method: 'DELETE' }),
  evaluationRuns: () => request<EvaluationRun[]>('/api/evaluations'),
  evaluationRun: (id: string) => request<EvaluationRun>(`/api/evaluations/${id}`),
  startEvaluation: (name: string, modelIds: string[], sampleIds: string[]) => request<EvaluationRun>('/api/evaluations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, modelIds, sampleIds, confirmModelCalls: true }) }),
  cancelEvaluation: (id: string) => request<EvaluationRun>(`/api/evaluations/${id}/cancel`, { method: 'POST' }),
  vocabulary: () => request<VocabularyState>('/api/vocabulary'),
  saveVocabulary: (baseRevision: number, terms: VocabularyTerms) => request<VocabularyState>('/api/vocabulary', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseRevision, terms }) }),
  renameVocabulary: (baseRevision: number, facet: Facet, from: string, to: string) => request<VocabularyState>('/api/vocabulary/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseRevision, facet, from, to }) }),
  saveAi: (settings: AiSettings) => request<AiStatus>('/api/ai', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) }),
  refreshModels: () => request<AiStatus>('/api/ai/models/refresh', { method: 'POST' }),
  analyze: (id: string) => request<{ queued: boolean }>(`/api/items/${id}/analyze`, { method: 'POST' }),
  label: (id: string, facet: Facet, value: string, state: 'accepted' | 'rejected') => request<LibraryItem>(`/api/items/${id}/labels`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ facet, value, state }) }),
  prompt: (id: string, body: string, baseVersion: number, variant: PromptVariant = 'agent') => request<LibraryItem>(`/api/items/${id}/prompt`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, baseVersion, variant }) }),
  generatePrompt: (id: string, variant: PromptVariant) => request<{ queued: boolean }>(`/api/items/${id}/prompts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ variant }) }),
  promptHistory: (id: string, variant: PromptVariant, offset = 0, signal?: AbortSignal) => request<PromptHistory>(`/api/items/${id}/prompts?${new URLSearchParams({ variant, offset: String(offset) })}`, { signal }),
  restorePrompt: (id: string, revisionId: string, variant: PromptVariant, baseVersion: number) => request<LibraryItem>(`/api/items/${id}/prompts/${revisionId}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ variant, baseVersion }) }),
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
