import { useEffect, useState } from 'react';
import { PROMPT_VARIANTS, PROMPT_VARIANT_NAMES } from '@design-index/shared/browser';
import type { LibraryItem, PromptHistory, PromptVariant } from '@design-index/shared/browser';
import { api } from './api';

export function PromptPanel({ item, onUpdate, confirm }: { item: LibraryItem; onUpdate: (item: LibraryItem) => void; confirm: (message: string) => void }) {
  const [variant, setVariant] = useState<PromptVariant>('agent');
  const [drafts, setDrafts] = useState<Partial<Record<PromptVariant, { body: string; baseVersion: number }>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<PromptHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const saved = item.intelligence.prompts[variant];
  const draft = drafts[variant];
  const job = item.intelligence.promptJobs[variant];
  const pending = job?.status === 'queued' || job?.status === 'running';
  const name = PROMPT_VARIANT_NAMES[variant];

  useEffect(() => {
    if (!showHistory) return;
    const abort = new AbortController();
    setHistoryLoading(true); setHistory(null);
    api.promptHistory(item.id, variant, 0, abort.signal).then((value) => { if (!abort.signal.aborted) setHistory(value); }).catch((error) => { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load history.'); }).finally(() => { if (!abort.signal.aborted) setHistoryLoading(false); });
    return () => abort.abort();
  }, [showHistory, item.id, variant, saved?.id, job?.status]);

  function discard() { setDrafts((value) => { const next = { ...value }; delete next[variant]; return next; }); }
  async function copy() {
    if (!saved) return;
    try { await navigator.clipboard.writeText(saved.body); confirm('Saved prompt copied.'); }
    catch { setError('Clipboard access was blocked. Select the saved prompt text and copy it manually.'); }
  }
  async function save() {
    if (!draft) return;
    setBusy(true); setError('');
    try { onUpdate(await api.prompt(item.id, draft.body, draft.baseVersion, variant)); discard(); confirm('New prompt revision saved.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not save prompt.'); }
    finally { setBusy(false); }
  }
  async function generate() {
    if (!window.confirm(`Generate the ${name.toLowerCase()} variant through OpenCode Go? This uses allowance unless an unchanged result is cached. Existing manual revisions remain selected.`)) return;
    setBusy(true); setError('');
    try { await api.generatePrompt(item.id, variant); onUpdate(await api.item(item.id)); confirm('Prompt variant queued.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not queue prompt variant.'); }
    finally { setBusy(false); }
  }
  async function restore(revisionId: string) {
    setBusy(true); setError('');
    try { onUpdate(await api.restorePrompt(item.id, revisionId, variant, saved?.version ?? 0)); confirm('Prompt revision restored as a new saved version.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not restore prompt revision.'); }
    finally { setBusy(false); }
  }
  async function moreHistory() {
    if (!history) return;
    setHistoryLoading(true); setError('');
    try {
      const next = await api.promptHistory(item.id, variant, history.versions.length);
      setHistory((previous) => previous?.variant === next.variant ? { ...next, versions: [...new Map([...previous.versions, ...next.versions].map((version) => [version.id, version])).values()] } : previous);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not load older revisions.'); }
    finally { setHistoryLoading(false); }
  }
  function tabKey(event: React.KeyboardEvent, current: PromptVariant) {
    const index = PROMPT_VARIANTS.indexOf(current);
    const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
    if (next < 0) return;
    event.preventDefault(); const target = PROMPT_VARIANTS[next]!; setVariant(target); document.getElementById(`prompt-tab-${item.id}-${target}`)?.focus();
  }

  return <div className="prompt-section">
    <div className="section-heading"><h3>Design-language prompt</h3>{saved && <span className="eyebrow">v{saved.version}{saved.editedByUser ? ' / edited by you' : ''}</span>}</div>
    <div className="prompt-tabs" role="tablist" aria-label="Prompt variants">{PROMPT_VARIANTS.map((value) => <button key={value} type="button" role="tab" id={`prompt-tab-${item.id}-${value}`} aria-controls={`prompt-panel-${item.id}-${value}`} aria-selected={variant === value} tabIndex={variant === value ? 0 : -1} onClick={() => { setVariant(value); setError(''); }} onKeyDown={(event) => tabKey(event, value)}>{PROMPT_VARIANT_NAMES[value]}{drafts[value] ? ' *' : ''}</button>)}</div>
    <div role="tabpanel" id={`prompt-panel-${item.id}-${variant}`} aria-labelledby={`prompt-tab-${item.id}-${variant}`}>
      {saved ? <><textarea aria-label="Design-language prompt" className="prompt-body" rows={12} readOnly={!draft} value={draft?.body ?? saved.body} onChange={(event) => { if (draft) setDrafts({ ...drafts, [variant]: { body: event.target.value, baseVersion: draft.baseVersion } }); }} maxLength={20000} /><div className="settings-actions"><button className="primary-button" onClick={() => void copy()}>Copy prompt</button>{draft ? <><button className="secondary-button" disabled={busy || !draft.body.trim()} onClick={() => void save()}>Save prompt revision</button><button className="inline-link" onClick={discard}>Discard draft</button></> : <button className="secondary-button" onClick={() => setDrafts({ ...drafts, [variant]: { body: saved.body, baseVersion: saved.version } })}>Edit prompt</button>}</div><p className="muted settings-description">Copy always uses the saved version, not an unsaved draft. Drafts are kept when switching tabs. Manual revisions survive re-analysis. Review reference-derived prompts before using them.</p>{saved.editedByUser && saved.analysisId !== item.intelligence.analysis?.id && <p className="review-reasons">This preserved manual revision is based on an earlier analysis.</p>}{saved.assumptions.length > 0 && <details className="prompt-assumptions"><summary>Inferred, not measured</summary><ul>{saved.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul></details>}</> : <p className="muted settings-description">{variant === 'agent' ? 'The coding-agent prompt is written automatically after analysis.' : `Generate the ${name.toLowerCase()} variant on demand from the saved analysis.`} {variant === 'vibe' ? 'Generated vibe summaries stay under 80 words and contain no code.' : ''}</p>}
      {pending && <p className="muted settings-description">{name} prompt: {job.status.replace('_', ' ')}…</p>}
      {job?.status === 'failed' && <p className="error-message">{job.error}</p>}
      <div className="settings-actions"><button className="secondary-button" disabled={busy || pending || !item.intelligence.analysis} onClick={() => void generate()}>{saved ? `Refresh ${name.toLowerCase()} prompt (Go)` : `Generate ${name.toLowerCase()} prompt (Go)`}</button><button className="text-link" aria-expanded={showHistory} onClick={() => setShowHistory((value) => !value)}>{showHistory ? 'Hide version history' : 'Version history'}</button></div>
      {showHistory && <section className="prompt-history" aria-label={`${name} version history`}><p className="muted settings-description">Restore creates a new manual revision; the original versions remain unchanged. Viewing/restoring history is local and uses no Go allowance.</p>{historyLoading && !history && <p className="muted">Loading history…</p>}{history?.versions.map((revision) => <details key={revision.id}><summary>v{revision.version} · {revision.editedByUser ? 'manual' : revision.modelId} · {new Date(revision.createdAt).toLocaleString()}{saved?.id === revision.id ? ' · saved' : ''}</summary><textarea className="prompt-body" aria-label={`Prompt revision ${variant} v${revision.version}`} readOnly rows={6} value={revision.body} /><button className="secondary-button" disabled={busy || !!draft} onClick={() => void restore(revision.id)}>Restore {variant} revision v{revision.version}</button></details>)}{history?.total === 0 && <p className="muted">No saved revisions for this variant yet.</p>}{history && history.versions.length < history.total && <button className="secondary-button" disabled={historyLoading} onClick={() => void moreHistory()}>Load older prompt revisions</button>}</section>}
    </div>
    {error && <p className="error-message" role="alert">{error}</p>}
  </div>;
}
