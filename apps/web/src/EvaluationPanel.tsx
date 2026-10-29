import { useEffect, useState } from 'react';
import { defaultVocabulary, FACETS } from '@design-index/shared/browser';
import type { AiStatus, EvaluationRun, EvaluationSample, Facet, LibraryItem, VocabularyState, VocabularyTerms } from '@design-index/shared/browser';
import { api } from './api';

const emptyLabels = (): VocabularyTerms => ({ style: [], color: [], layout: [], typography: [], motion: [], component: [] });
const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;

export function EvaluationPanel({ ai, vocabulary = defaultVocabulary() }: { ai: AiStatus | null; vocabulary: VocabularyState }) {
  const [samples, setSamples] = useState<EvaluationSample[]>([]), [items, setItems] = useState<LibraryItem[]>([]), [query, setQuery] = useState('');
  const [selected, setSelected] = useState<LibraryItem | null>(null), [labels, setLabels] = useState<VocabularyTerms>(emptyLabels), [facets, setFacets] = useState<Facet[]>([]), [note, setNote] = useState(''), [version, setVersion] = useState(0);
  const [runName, setRunName] = useState('Vision model comparison'), [models, setModels] = useState<string[]>([]), [sampleIds, setSampleIds] = useState<string[]>([]), [confirmed, setConfirmed] = useState(false);
  const [runs, setRuns] = useState<EvaluationRun[]>([]), [run, setRun] = useState<EvaluationRun | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  useEffect(() => { let cancelled = false; api.evaluationSamples().then((rows) => { if (!cancelled) { setSamples(rows); setSampleIds(rows.map((row) => row.itemId)); } }).catch((error) => { if (!cancelled) setError(error.message); }); return () => { cancelled = true; }; }, []);
  useEffect(() => { const abort = new AbortController(); const timer = window.setTimeout(() => { api.list(query, 0, abort.signal).then((page) => { if (!abort.signal.aborted) setItems(page.items); }).catch((error) => { if (!abort.signal.aborted) setError(error.message); }); }, 150); return () => { abort.abort(); window.clearTimeout(timer); }; }, [query]);
  useEffect(() => {
    let cancelled = false, polling = false;
    async function poll() { if (polling) return; polling = true; try { const rows = await api.evaluationRuns(); if (cancelled) return; setRuns(rows); if (run?.id) { const result = await api.evaluationRun(run.id); if (!cancelled) setRun(result); } } catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : 'Evaluation service unavailable.'); } finally { polling = false; } }
    void poll(); const timer = window.setInterval(() => void poll(), 2000); return () => { cancelled = true; window.clearInterval(timer); };
  }, [run?.id]);
  async function choose(id: string) {
    if (!id) { setSelected(null); return; }
    try { const item = items.find((item) => item.id === id) ?? await api.item(id), sample = samples.find((sample) => sample.itemId === id); setSelected(item); setLabels(sample ? structuredClone(sample.labels) : emptyLabels()); setFacets(sample ? [...sample.scoredFacets] : []); setNote(sample?.note ?? ''); setVersion(sample?.version ?? 0); setError(''); }
    catch (error) { setError(error instanceof Error ? error.message : 'Reference unavailable.'); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!selected) return; setBusy(true); setError('');
    try { const rows = await api.saveEvaluationSample(selected.id, labels, facets, note, version); setSamples(rows); setVersion(rows.find((row) => row.itemId === selected.id)!.version); setSampleIds((ids) => [...new Set([...ids, selected.id])]); setMessage('Hand labels saved locally. No model request was made.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not save hand labels.'); } finally { setBusy(false); }
  }
  async function remove(sample: EvaluationSample) {
    if (!window.confirm('Remove this entry from the evaluation set? The library reference and historical runs stay intact.')) return;
    try { await api.removeEvaluationSample(sample.itemId, sample.version); setSamples((rows) => rows.filter((row) => row.itemId !== sample.itemId)); setSampleIds((ids) => ids.filter((id) => id !== sample.itemId)); if (selected?.id === sample.itemId) setVersion(0); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not remove hand labels.'); }
  }
  async function start(event: React.FormEvent) {
    event.preventDefault(); if (!confirmed) return;
    if (!window.confirm(`Queue ${sampleIds.length * models.length} vision calls through Go? Hand labels are not sent. Results do not replace library analyses. Go account usage limits apply.`)) return;
    setBusy(true); setError('');
    try { setRun(await api.startEvaluation(runName, models, sampleIds)); setConfirmed(false); setMessage('Evaluation queued. Normal library analysis has priority.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not start evaluation.'); } finally { setBusy(false); }
  }
  const supported = ai?.models.filter((model) => model.vision) ?? [];
  return <section className="ai-settings evaluation-settings" aria-labelledby="evaluation-heading">
    <div className="section-heading"><h2 id="evaluation-heading">Evaluation lab</h2><span className="eyebrow">{samples.length} / 30 references</span></div>
    <p className="muted settings-description">Build a hand-labeled test set, then compare 2–4 vision models on identical frozen inputs. No AI suggestions are prefilled as ground truth. Select up to 10 labels per facet. Only explicitly checked facets are scored; an empty selection on a scored facet means no label applies.</p>
    <div className="evaluation-picker"><label>Find evaluation reference<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the library" /></label><label>Evaluation reference<select value={selected?.id ?? ''} onChange={(event) => void choose(event.target.value)}><option value="">Choose a reference</option>{selected && !items.some((item) => item.id === selected.id) && <option value={selected.id}>{selected.title}</option>}{items.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label></div>
    {selected && <form onSubmit={save} className="gold-form">
      <img className="evaluation-preview" src={selected.previewUrl} alt={selected.title} />
      <div className="gold-facets">{FACETS.map((facet) => <fieldset key={facet}>
        <legend>{facet}</legend>
        <label className="check-label"><input type="checkbox" checked={facets.includes(facet)} onChange={(event) => setFacets(event.target.checked ? [...facets, facet] : facets.filter((value) => value !== facet))} />Score {facet} facet</label>
        <div className="gold-labels">{[...new Set([...vocabulary.terms[facet], ...labels[facet]])].map((value) => {
          const retired = !vocabulary.terms[facet].includes(value);
          return <label key={value} className="check-label"><input type="checkbox" aria-label={`Ground truth ${facet}: ${value}`} checked={labels[facet].includes(value)} disabled={!labels[facet].includes(value) && (retired || labels[facet].length >= 10)} onChange={(event) => setLabels({ ...labels, [facet]: event.target.checked ? [...labels[facet], value] : labels[facet].filter((label) => label !== value) })} />{value}{retired ? ' (retired — remove or replace)' : ''}</label>;
        })}</div>
      </fieldset>)}</div>
      <label>Evaluation annotation<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} rows={2} placeholder="Private hand-labeling notes; never sent to the model" /></label>
      <button className="secondary-button" disabled={busy || !facets.length}>Save hand labels</button>
    </form>}
    <div className="evaluation-samples">{samples.map((sample) => <div key={sample.itemId}><label className="check-label"><input type="checkbox" aria-label={`Evaluate ${sample.title}`} checked={sampleIds.includes(sample.itemId)} onChange={(event) => setSampleIds(event.target.checked ? [...sampleIds, sample.itemId] : sampleIds.filter((id) => id !== sample.itemId))} />{sample.title} <small>{sample.scoredFacets.join(', ')} · v{sample.version}</small></label><div className="settings-actions"><button className="text-link" onClick={() => void choose(sample.itemId)}>Edit hand labels</button><button className="inline-link" onClick={() => void remove(sample)}>Remove evaluation entry</button></div></div>)}</div>
    <a className="text-link" href="/api/evaluation/samples/export" download>Export hand-label dataset JSON</a>
    <form onSubmit={start} className="evaluation-run-form"><h3>Model bake-off</h3><label>Evaluation run name<input value={runName} onChange={(event) => setRunName(event.target.value)} required maxLength={120} /></label><div className="evaluation-models">{supported.map((model) => <label key={model.id} className="check-label"><input type="checkbox" aria-label={`Evaluate model ${model.name}`} checked={models.includes(model.id)} disabled={!models.includes(model.id) && (models.length >= 4 || model.trainsOnData && !ai?.settings.allowModelTraining)} onChange={(event) => setModels(event.target.checked ? [...models, model.id] : models.filter((id) => id !== model.id))} />{model.name}{model.trainsOnData ? ' · training consent required' : ''}</label>)}</div><p className="muted settings-description">{sampleIds.length * models.length} single-call trials. Usage and billing are managed in your OpenCode Go account; DI imposes no local allowance limit. No automatic retry of failed or invalid evaluation output. Contributor models require separate training consent in AI settings.</p><label className="check-label"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I authorize these evaluation model calls and sharing of the selected previews.</label><button className="primary-button" disabled={busy || !confirmed || models.length < 2 || !sampleIds.length || !ai?.keyConfigured || !ai.settings.allowImageSharing}>Start evaluation</button>{!ai?.settings.allowImageSharing && <p className="muted settings-description">Approve image sharing in AI settings before starting a run.</p>}</form>
    {models.length > 0 && <div aria-label="Selected evaluation model privacy">{supported.filter((model) => models.includes(model.id)).map((model) => <p className="muted settings-description" key={model.id}><strong>{model.name}:</strong> {model.privacyNotice}</p>)}</div>}
    <div className="evaluation-runs"><h3>Saved evaluation runs</h3>{runs.map((row) => <button className="secondary-button" key={row.id} onClick={() => { void api.evaluationRun(row.id).then(setRun).catch((error) => setError(error.message)); }}>{row.name} · {row.status}</button>)}</div>
    {run && <section className="evaluation-results" aria-label="Evaluation results"><div className="section-heading"><h3>{run.name}</h3><span>{run.status}</span></div><p className="muted settings-description">{run.sampleCount}/30 reference target · vocabulary r{run.vocabularyRevision}. Partial/cancelled runs are not an acceptance benchmark. Label scores include failed/invalid finished trials as missing predictions; schema validity is shown against received responses separately. Undefined precision/recall/F1 is shown as —.</p><div className="evaluation-table"><table><thead><tr>{['Model', 'Finished', 'Schema valid / responses', 'Valid analyses', 'Precision', 'Recall', 'F1', 'Exact facets', 'Mean ms', 'Input / output tokens'].map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{run.summaries.map((summary) => <tr key={summary.modelId}><td>{summary.modelId}</td><td>{summary.finished}/{summary.trials}</td><td>{summary.schemaValid}/{summary.responses} ({summary.attempted} attempted)</td><td>{summary.valid}</td><td>{percent(summary.scores.precision)}</td><td>{percent(summary.scores.recall)}</td><td>{percent(summary.scores.f1)}</td><td>{percent(summary.scores.exactAgreement)}</td><td>{summary.averageLatencyMs === null ? '—' : Math.round(summary.averageLatencyMs)}</td><td>{summary.inputTokens.toLocaleString()} / {summary.outputTokens.toLocaleString()}</td></tr>)}</tbody></table></div><div className="settings-actions"><a className="text-link" href={`/api/evaluations/${run.id}/export?format=csv`} download>Export evaluation CSV</a><a className="text-link" href={`/api/evaluations/${run.id}/export`} download>Export evaluation JSON</a>{['queued', 'running'].includes(run.status) && <button className="secondary-button" onClick={() => { void api.cancelEvaluation(run.id).then(setRun).catch((error) => setError(error.message)); }}>Cancel evaluation</button>}</div><p className="muted settings-description">Shared worker: {ai?.message} Cancelling an in-flight call cannot undo transmission. Go manages any resulting usage and billing. Token totals include reported usage only. Results never replace active library labels or prompts.</p>{run.trials.map((trial) => <details className="evaluation-trial" key={trial.id}><summary>{trial.modelId} · {trial.title} · {trial.status}</summary>{trial.error && <p className="error-message">{trial.error}</p>}<pre>{trial.result ? JSON.stringify(trial.result, null, 2) : 'No usable analysis result.'}</pre></details>)}</section>}
    {error && <p className="error-message" role="alert">{error}</p>}<p className="copy-confirmation" role="status">{message}</p>
  </section>;
}
