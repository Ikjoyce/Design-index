import { useEffect, useRef, useState } from 'react';
import type { CaptureJob } from '@design-index/shared/browser';
import { api } from './api';

export function UrlCapturePanel({ onCaptured }: { onCaptured: (id: string) => void }) {
  const [url, setUrl] = useState(''), [title, setTitle] = useState(''), [note, setNote] = useState('');
  const [colorScheme, setColorScheme] = useState<'light' | 'dark'>('light');
  const [origins, setOrigins] = useState(''), [jobs, setJobs] = useState<CaptureJob[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const pending = useRef(new Set<string>()), loaded = useRef(false), callback = useRef(onCaptured);
  callback.current = onCaptured;
  useEffect(() => {
    let cancelled = false, polling = false;
    async function poll() {
      if (polling) return; polling = true;
      try {
        const status = await api.captures(); if (cancelled) return;
        if (!loaded.current) { setOrigins(status.settings.approvedLocalOrigins.join('\n')); status.jobs.filter((job) => ['queued', 'running'].includes(job.status)).forEach((job) => pending.current.add(job.id)); loaded.current = true; }
        setJobs(status.jobs);
        for (const job of status.jobs) if (pending.current.has(job.id) && ['completed', 'failed'].includes(job.status)) {
          pending.current.delete(job.id);
          if (job.itemId && job.status === 'completed') callback.current(job.itemId);
        }
      } catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : 'Capture service unavailable.'); }
      finally { polling = false; }
    }
    void poll(); const timer = window.setInterval(() => void poll(), 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  async function queue(event?: React.FormEvent, retry?: CaptureJob) {
    event?.preventDefault(); setBusy(true); setError(''); setMessage('');
    try { const job = await api.captureUrl(retry ? { url: retry.url, title: retry.title, note: retry.note, colorScheme: retry.colorScheme } : { url, title, note, colorScheme }); pending.current.add(job.id); setJobs((previous) => [job, ...previous].slice(0, 20)); setMessage('URL queued. Capture runs locally in the background.'); if (!retry) { setUrl(''); setTitle(''); setNote(''); } }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not queue URL.'); }
    finally { setBusy(false); }
  }
  async function saveOrigins() {
    setBusy(true); setError('');
    try { const saved = await api.saveCaptureSettings({ approvedLocalOrigins: origins.split(/\s+/).filter(Boolean) }); setOrigins(saved.approvedLocalOrigins.join('\n')); setMessage('Local-origin approvals saved. Other private/LAN destinations remain blocked.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not save capture permissions.'); }
    finally { setBusy(false); }
  }
  async function cancel(id: string) { try { await api.cancelCapture(id); pending.current.delete(id); setJobs((await api.captures()).jobs); } catch (error) { setError(error instanceof Error ? error.message : 'Could not cancel capture.'); } }

  return <section className="ai-settings url-capture-settings" aria-labelledby="url-capture-heading">
    <div className="section-heading"><h2 id="url-capture-heading">Capture a page</h2><span className="eyebrow">isolated browser</span></div>
    <p className="muted settings-description">Capture desktop, bounded full-page, and mobile views plus computed CSS facts. This visits the site and its resources, without your signed-in Chrome profile. Saved captures follow your existing AI settings; capture itself makes no Go calls.</p>
    <form className="url-capture-form" onSubmit={(event) => void queue(event)}>
      <label>Page URL<input type="url" required value={url} onChange={(event) => setUrl(event.target.value)} maxLength={2048} placeholder="https://example.com" /></label>
      <label>Capture title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} placeholder="Optional — defaults to page title" /></label>
      <label>Capture note<input value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} placeholder="Why this page caught your eye" /></label>
      <label>Site appearance<select value={colorScheme} onChange={(event) => setColorScheme(event.target.value as 'light' | 'dark')}><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <button className="primary-button" disabled={busy}>Capture URL</button>
    </form>
    <details className="capture-permissions"><summary>Local dev-server permissions</summary><p className="muted settings-description">Public HTTP/HTTPS sites use normal ports. Local capture needs an exact approved origin such as http://127.0.0.1:3000. No LAN/metadata access, library API/UI capture, or wildcard approvals. A public capture cannot use these local approvals.</p><label>Approved local origins<textarea rows={3} value={origins} onChange={(event) => setOrigins(event.target.value)} placeholder="One exact local origin per line" /></label><button className="secondary-button" disabled={busy} onClick={() => void saveOrigins()}>Save capture permissions</button></details>
    {jobs.length > 0 && <div className="capture-jobs" aria-label="Recent URL captures">{jobs.map((job) => <div key={job.id} className="capture-job"><div><strong>{job.title || new URL(job.url).hostname}</strong><span className="muted">{job.status}{job.deduplicated ? ' · already saved' : ''}</span>{job.error && <p className="error-message">{job.error}</p>}</div><div className="settings-actions">{job.itemId && <button className="text-link" onClick={() => callback.current(job.itemId!)}>Open capture result</button>}{['queued', 'running'].includes(job.status) && <button className="inline-link" onClick={() => void cancel(job.id)}>Cancel capture</button>}{job.status === 'failed' && <button className="inline-link" disabled={busy} onClick={() => void queue(undefined, job)}>Retry capture</button>}</div></div>)}</div>}
    {error && <p className="error-message" role="alert">{error}</p>}<p className="copy-confirmation" role="status">{message}</p>
  </section>;
}
