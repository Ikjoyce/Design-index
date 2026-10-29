import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../apps/web/src/api.js';

afterEach(() => vi.unstubAllGlobals());

it('refreshes an expired local session and replays a settings save once, without asking for the provider key', async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    if (calls.length === 1) return Response.json({ error: 'Local authentication required.' }, { status: 401 });
    if (url === '/api/session') return Response.json({ ready: true });
    return Response.json({ id: 'saved-item', title: 'Updated', note: 'Preserve this draft' });
  });
  const saved = await api.update('saved-item', 'Updated', 'Preserve this draft');
  expect(saved.note).toBe('Preserve this draft');
  expect(calls.map((call) => call.url)).toEqual(['/api/items/saved-item', '/api/session', '/api/items/saved-item']);
  expect(calls[2]?.options?.body).toBe(calls[0]?.options?.body);
  expect(calls.every((call) => call.options?.credentials === 'same-origin')).toBe(true);
  expect(calls.every((call) => !new Headers(call.options?.headers).has('authorization'))).toBe(true);
});

it('shares one session refresh for simultaneous expired-session requests', async () => {
  let ready = false;
  let refreshes = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === '/api/session') { refreshes++; await Promise.resolve(); ready = true; return Response.json({ ready: true }); }
    return ready ? Response.json({ models: [] }) : Response.json({ error: 'Local authentication required.' }, { status: 401 });
  });
  await Promise.all([api.ai(), api.ai()]);
  expect(refreshes).toBe(1);
});

it('does not loop forever if a fresh session is still unauthorized', async () => {
  let requests = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    requests++;
    return url === '/api/session' ? Response.json({ ready: true }) : Response.json({ error: 'Still unauthorized.' }, { status: 401 });
  });
  await expect(api.ai()).rejects.toThrow('Still unauthorized.');
  expect(requests).toBe(3);
});

it('never turns a forbidden origin or failed bootstrap into repeated requests', async () => {
  let requests = 0;
  vi.stubGlobal('fetch', async () => { requests++; return Response.json({ error: 'Forbidden.' }, { status: 403 }); });
  await expect(api.ai()).rejects.toThrow('Forbidden.');
  expect(requests).toBe(1);
  requests = 0;
  vi.stubGlobal('fetch', async () => { requests++; return Response.json({ error: 'Unauthorized bootstrap.' }, { status: 401 }); });
  await expect(api.connect()).rejects.toThrow('Unauthorized bootstrap.');
  expect(requests).toBe(1);
});
