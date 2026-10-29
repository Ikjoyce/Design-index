import { useState } from 'react';
import { FACETS } from '@design-index/shared/browser';
import type { Facet, VocabularyState, VocabularyTerms } from '@design-index/shared/browser';
import { api } from './api';

const textFields = (state: VocabularyState) => Object.fromEntries(FACETS.map((facet) => [facet, state.terms[facet].join('\n')])) as Record<Facet, string>;

export function VocabularyPanel({ vocabulary, onChange }: { vocabulary: VocabularyState; onChange: (value: VocabularyState) => void }) {
  const [baseRevision, setBaseRevision] = useState(vocabulary.revision);
  const [fields, setFields] = useState(() => textFields(vocabulary));
  const [facet, setFacet] = useState<Facet>('style');
  const [from, setFrom] = useState(vocabulary.terms.style[0]!);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const dirty = FACETS.some((facet) => fields[facet] !== vocabulary.terms[facet].join('\n'));

  function apply(value: VocabularyState) {
    setBaseRevision(value.revision); setFields(textFields(value)); onChange(value);
    setFrom(value.terms[facet][0]!); setTo('');
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    const terms = Object.fromEntries(FACETS.map((facet) => [facet, fields[facet].split(/[\s,]+/).filter(Boolean)])) as VocabularyTerms;
    try { apply(await api.saveVocabulary(baseRevision, terms)); setMessage('Vocabulary saved. Existing analyses and manual decisions are preserved; no retagging was queued.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not save vocabulary.'); }
    finally { setBusy(false); }
  }
  async function rename(event: React.FormEvent) {
    event.preventDefault();
    if (!window.confirm(`Rename or merge ${facet}:${from} into ${to}? Existing effective labels and their search index will be updated locally. Saved analysis JSON and prompt text stay unchanged.`)) return;
    setBusy(true); setError(''); setMessage('');
    try { apply(await api.renameVocabulary(baseRevision, facet, from, to)); setMessage('Label renamed/merged. Manual accept/reject decisions were preserved.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not rename label.'); }
    finally { setBusy(false); }
  }
  async function reload() {
    if (dirty && !window.confirm('Discard unsaved vocabulary edits and reload the saved revision?')) return;
    setBusy(true); setError('');
    try { apply(await api.vocabulary()); setMessage('Saved vocabulary reloaded.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not reload vocabulary.'); }
    finally { setBusy(false); }
  }

  return <section className="ai-settings vocabulary-settings" aria-labelledby="vocabulary-heading">
    <div className="section-heading"><h2 id="vocabulary-heading">Controlled vocabulary</h2><span className="eyebrow">revision {baseRevision}</span></div>
    <p className="muted settings-description">One lowercase kebab-case label per line (commas also work). Keep 1–60 terms per facet and keep motion:unknown. New captures and explicit re-analysis use the saved revision. Saving does not spend Go allowance or queue a bulk retag.</p>
    <form onSubmit={save} className="vocabulary-form">
      {FACETS.map((facet) => <label key={facet}>{facet}<textarea aria-label={`${facet} vocabulary`} rows={6} value={fields[facet]} onChange={(event) => setFields({ ...fields, [facet]: event.target.value })} maxLength={10000} disabled={busy} />{vocabulary.retiredTerms[facet].length > 0 && <span className="muted">Retired but preserved on existing items: {vocabulary.retiredTerms[facet].join(', ')}</span>}</label>)}
      <div className="settings-actions"><button className="primary-button" disabled={busy || !dirty}>Save vocabulary</button><button type="button" className="secondary-button" onClick={() => void reload()} disabled={busy}>Reload saved vocabulary</button></div>
    </form>
    <p className="muted settings-description">Removing a term retires it; existing labels remain reviewable/searchable. To rename or merge without losing those references, use the action below. Conflicting manual decisions block a merge rather than being overwritten.</p>
    <form onSubmit={rename} className="vocabulary-rename">
      <label>Rename facet<select value={facet} onChange={(event) => { const next = event.target.value as Facet; setFacet(next); setFrom(vocabulary.terms[next][0]!); }}>{FACETS.map((facet) => <option key={facet}>{facet}</option>)}</select></label>
      <label>Source label<select value={from} onChange={(event) => setFrom(event.target.value)}>{vocabulary.terms[facet].map((term) => <option key={term}>{term}</option>)}</select></label>
      <label>Target label<input value={to} onChange={(event) => setTo(event.target.value)} maxLength={80} required placeholder="New or existing label" /></label>
      <button className="secondary-button" disabled={busy || dirty || !to.trim() || to === from}>Rename / merge label</button>
    </form>
    {dirty && <p className="muted settings-description">Save or reload your vocabulary edits before using rename/merge.</p>}
    {error && <p className="error-message" role="alert">{error}</p>}
    <p className="copy-confirmation" role="status">{message}</p>
  </section>;
}
