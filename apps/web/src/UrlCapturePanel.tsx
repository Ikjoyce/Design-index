import { useEffect, useRef, useState } from 'react';
import type { CaptureJob } from '@design-index/shared/browser';
import { api } from './api';

export function UrlCapturePanel({ connected, onCaptured }: { connected: boolean; onCaptured: (id: string) => void }) {
  const [url, setUrl] = useState(''), [title, setTitle] = useState(''), [note, setNote] = useState('');
  const [colorScheme, setColorScheme] = useState<'light' | 'dark'>('light');
  const [origins, setOrigins] = useState(''), [jobs, setJobs] = useState<CaptureJob[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const pending = useRef(new Set<string>()), loaded = useRef(false), callback = useRef(onCaptured);
  callback.current = onCaptured;
  useEffect(() => {
    if (!connected) return;
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
  }, [connected]);
  async function queue(event?: React.FormEvent, retry?: CaptureJob) {
    event?.preventDefault(); if (!connected || busy) return; setBusy(true); setError(''); setMessage('');
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

  return <section className="url-capture-settings" aria-labelledby="url-capture-heading">
    <div className="capture-method-heading"><div className="capture-icon"><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z" /></svg></div><div className="capture-copy"><span className="method-eyebrow">FROM THE WEB</span><h2 id="url-capture-heading">Capture a page</h2></div></div>
    <p className="capture-description">Save desktop, full-page, and mobile views from a URL.</p>
    <form className="url-capture-form" onSubmit={(event) => void queue(event)}>
      <div className="url-entry"><label htmlFor="capture-page-url">Page URL</label><div className="url-submit-row"><input id="capture-page-url" type="url" inputMode="url" autoComplete="url" spellCheck={false} required value={url} onChange={(event) => setUrl(event.target.value)} maxLength={2048} placeholder="https://example.com" disabled={!connected || busy} /><button type="submit" className="primary-button" disabled={!connected || busy || !url.trim()}>{busy ? 'Queueing…' : 'Capture URL'}</button></div></div>
      <div className="capture-fields"><label><span>Capture title <span className="optional">/ optional</span></span><input aria-label="Capture title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} placeholder="Use the page title" disabled={!connected || busy} /></label><label><span>Capture note <span className="optional">/ optional</span></span><input aria-label="Capture note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} placeholder="Why this caught your eye…" disabled={!connected || busy} /></label></div>
      <details className="capture-options"><summary>Capture options</summary><label>Site appearance<select value={colorScheme} onChange={(event) => setColorScheme(event.target.value as 'light' | 'dark')} disabled={!connected || busy}><option value="light">Light</option><option value="dark">Dark</option></select></label><p className="muted settings-description">The site and its resources load in an isolated browser, without your signed-in Chrome profile. Capture itself makes no Go calls; saved references follow your AI settings.</p><details className="capture-permissions"><summary>Local dev-server permissions</summary><p className="muted settings-description">Public HTTP/HTTPS sites use normal ports. Local capture needs an exact approved origin such as http://127.0.0.1:3000. No LAN/metadata access, library API/UI capture, or wildcard approvals. A public capture cannot use these local approvals.</p><label>Approved local origins<textarea rows={3} value={origins} onChange={(event) => setOrigins(event.target.value)} placeholder="One exact local origin per line" disabled={!connected || busy} /></label><button type="button" className="secondary-button" disabled={!connected || busy} onClick={() => void saveOrigins()}>Save capture permissions</button></details></details>
    </form>
    {jobs.length > 0 && <details className="capture-history"><summary>Recent URL captures <span className="muted">{jobs.filter((job) => ['queued', 'running'].includes(job.status)).length} active · {jobs.length} recent</span></summary><div className="capture-jobs" aria-label="Recent URL captures">{jobs.map((job) => <div key={job.id} className="capture-job"><div><strong>{job.title || new URL(job.url).hostname}</strong><span className="muted">{job.status}{job.deduplicated ? ' · already saved' : ''}</span>{job.error && <p className="error-message">{job.error}</p>}</div><div className="settings-actions">{job.itemId && <button className="text-link" onClick={() => callback.current(job.itemId!)}>Open capture result</button>}{['queued', 'running'].includes(job.status) && <button className="inline-link" onClick={() => void cancel(job.id)}>Cancel capture</button>}{job.status === 'failed' && <button className="inline-link" disabled={!connected || busy} onClick={() => void queue(undefined, job)}>Retry capture</button>}</div></div>)}</div></details>}
    {error && <p className="error-message" role="alert">{error}</p>}<p className="copy-confirmation" role="status">{message}</p>
  </section>;
}
