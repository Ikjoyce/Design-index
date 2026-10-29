import { useEffect, useState } from 'react';
import { FACETS } from '@design-index/shared/browser';
import type { Facet, LibraryItem, VocabularyState } from '@design-index/shared/browser';
import { api } from './api';
import { PromptPanel } from './PromptPanel';

export function IntelligencePanel({ item, vocabulary, onUpdate, confirm }: { item: LibraryItem; vocabulary: VocabularyState; onUpdate: (item: LibraryItem) => void; confirm: (message: string) => void }) {
  const info = item.intelligence;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [facet, setFacet] = useState<Facet>('style');
  const [label, setLabel] = useState(vocabulary.terms.style[0]!);
  useEffect(() => {
    if (!vocabulary.terms[facet].includes(label)) setLabel(vocabulary.terms[facet][0]!);
  }, [vocabulary, facet, label]);

  async function decide(facet: Facet, value: string, state: 'accepted' | 'rejected') {
    setBusy(true); setError('');
    try { onUpdate(await api.label(item.id, facet, value, state)); confirm('Label decision saved.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not save label.'); }
    finally { setBusy(false); }
  }
  async function retry() {
    if (!window.confirm('Queue analysis through OpenCode Go? This may consume included usage and sends the reference if image sharing is enabled. Unchanged successful results may be reused from cache.')) return;
    setBusy(true); setError('');
    try { await api.analyze(item.id); onUpdate(await api.item(item.id)); confirm('Reference queued for analysis.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not queue analysis.'); }
    finally { setBusy(false); }
  }

  return <section className="intelligence-panel" aria-label="Design intelligence">
    <div className="section-heading"><h3>Design intelligence</h3><span className="eyebrow">{item.status.replaceAll('_', ' ')}</span></div>
    {info.analysis ? <><p className="analysis-summary">{info.analysis.summary}</p><p className="muted settings-description">{info.analysis.type_notes}</p><p className="muted settings-description">{info.analysis.motion_notes}</p><p className="provenance">{info.analysis.modelId} · vocabulary r{info.analysis.vocabularyRevision} · {new Date(info.analysis.createdAt).toLocaleDateString()}</p>{info.analysis.review.needs_review && <p className="review-reasons">Review: {info.analysis.review.reasons.join(' ') || 'The model marked this reference for review.'}</p>}</> : <p className="muted settings-description">Saved locally. AI is optional: open AI settings to enable Go with image-sharing consent. Until then, your image and palette stay usable without a model call.</p>}
    {info.analysisError && <p className="error-message">{info.analysisError}</p>}
    <div className="label-review">{FACETS.map((facet) => {
      const labels = info.labels.filter((label) => label.facet === facet);
      return labels.length ? <div key={facet}><h4>{facet}</h4><div className="label-chips">{labels.map((label) => <span key={label.value} className={`label-chip ${label.state}`}><span>{label.value} <small>{label.origin === 'user' ? 'yours' : `${Math.round(label.confidence * 100)}%`}{vocabulary.terms[facet].includes(label.value) ? '' : ' · retired'}</small></span><button disabled={busy || label.state === 'accepted'} title={`Accept ${label.value}`} aria-label={`Accept ${label.value}`} onClick={() => void decide(facet, label.value, 'accepted')}>✓</button><button disabled={busy || label.state === 'rejected'} title={`Reject ${label.value}`} aria-label={`Reject ${label.value}`} onClick={() => void decide(facet, label.value, 'rejected')}>×</button></span>)}</div></div> : null;
    })}</div>
    <form className="manual-label-form" onSubmit={(event) => { event.preventDefault(); void decide(facet, label, 'accepted'); }}>
      <label><span className="sr-only">Manual label facet</span><select value={facet} onChange={(event) => { const next = event.target.value as Facet; setFacet(next); setLabel(vocabulary.terms[next][0]!); }}>{FACETS.map((facet) => <option key={facet}>{facet}</option>)}</select></label>
      <label><span className="sr-only">Manual label value</span><select value={label} onChange={(event) => setLabel(event.target.value)}>{vocabulary.terms[facet].map((value) => <option key={value}>{value}</option>)}</select></label>
      <button className="secondary-button" disabled={busy}>Add label</button>
    </form>

    <PromptPanel item={item} onUpdate={onUpdate} confirm={confirm} />
    <button className="secondary-button" disabled={busy || item.status === 'analyzing' || item.status === 'writing_prompt'} onClick={() => void retry()}>Re-analyze reference</button>
    {error && <p className="error-message" role="alert">{error}</p>}
  </section>;
}
