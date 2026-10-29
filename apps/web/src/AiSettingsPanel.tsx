import { useState } from 'react';
import type { AiSettings, AiStatus } from '@design-index/shared/browser';
import { activationBlockers } from '@design-index/shared/browser';
import { api } from './api';

export function AiSettingsPanel({ status, onChange }: { status: AiStatus; onChange: (status: AiStatus) => void }) {
  const [draft, setDraft] = useState<AiSettings>(status.settings);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const models = status.models.filter((model) => model.vision);
  const selected = models.filter((model) => model.id === draft.analyzeModel || model.id === draft.promptModel);
  const contributorSelected = selected.some((model) => model.trainsOnData);
  const blockers = activationBlockers(draft, status.keyConfigured, models);

  async function save(event: React.FormEvent) {
    event.preventDefault(); setError(''); setMessage('');
    if (draft.allowImageSharing && blockers.length) { setError(blockers.join(' ')); return; }
    setBusy(true);
    try { const saved = await api.saveAi(draft); setDraft(saved.settings); onChange(saved); setMessage('AI settings saved.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not save settings.'); }
    finally { setBusy(false); }
  }
  async function refresh() {
    setBusy(true); setError('');
    try { onChange(await api.refreshModels()); setMessage('Go inventory and image-input capabilities refreshed. This does not verify model access or consume a model request.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not refresh models.'); }
    finally { setBusy(false); }
  }
  return <section className="ai-settings" aria-labelledby="ai-settings-heading">
    <div className="section-heading"><h2 id="ai-settings-heading">OpenCode Go</h2><span className="eyebrow">{status.keyConfigured ? 'SERVER KEY FOUND' : 'SERVER KEY NEEDED'}</span></div>
    <p className="muted settings-description">{status.message}</p>
    <div className="activation-checklist" aria-label="AI activation requirements">
      <strong>{status.keyConfigured ? 'Your .env key is already loaded by the server.' : 'The server has not loaded a provider key yet.'}</strong>
      <p>You do not need to paste a key into this page. The local server makes authenticated Go requests on your behalf.</p>
      {blockers.length ? <><p>Before automatic processing can start:</p><ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></> : <p>New inspiration starts automatically. Save to apply model or consent changes.</p>}
    </div>
    <p className="muted settings-description">Showing {models.length} confirmed image-input models for both roles. Text-only and unknown-capability models are hidden. Availability is checked against Go; capability metadata comes from models.dev.</p>
    <form onSubmit={save} className="ai-settings-form">
      <label>Analyze model<select value={draft.analyzeModel} onChange={(event) => setDraft({ ...draft, analyzeModel: event.target.value })}>{!models.some((model) => model.id === draft.analyzeModel) && <option value={draft.analyzeModel} disabled>Previous model unavailable — choose a vision model</option>}{models.map((model) => <option key={model.id} value={model.id}>{model.name}{model.trainsOnData ? ' (training consent required)' : ''}</option>)}</select></label>
      <label>Write-prompt model<select value={draft.promptModel} onChange={(event) => setDraft({ ...draft, promptModel: event.target.value })}>{!models.some((model) => model.id === draft.promptModel) && <option value={draft.promptModel} disabled>Previous model unavailable — choose a vision model</option>}{models.map((model) => <option key={model.id} value={model.id}>{model.name}{model.trainsOnData ? ' (training consent required)' : ''}</option>)}</select></label>
      <div className="ai-consent">
        <label><input type="checkbox" checked={draft.allowImageSharing} onChange={(event) => setDraft({ ...draft, allowImageSharing: event.target.checked })} />I allow normalized screenshots, titles, and notes to be sent to OpenCode Go.</label>
        {selected.map((model) => <p key={model.id}><strong>{model.name}:</strong> {model.privacyNotice}</p>)}
        {(contributorSelected || models.some((model) => model.trainsOnData)) && <label><input type="checkbox" checked={draft.allowModelTraining ?? false} onChange={(event) => setDraft({ ...draft, allowModelTraining: event.target.checked })} />I explicitly allow provider training on content sent to Contributor models, including evaluation runs. I understand separate Console privacy permission is also required.</label>}
        <p>Review model-specific privacy terms before sending private designs. Go is intended for coding-agent-style workloads; Design Index identifies itself honestly. A catalog entry does not guarantee that your workspace enables that model.</p>
        <p>Analysis and coding-agent prompts start automatically for queued and newly loaded inspiration. Uncheck image sharing to keep new captures local. DI does not change your Go account settings or switch providers.</p>
      </div>
      <div className="settings-actions"><button className="primary-button" disabled={busy || !models.length}>{busy ? 'Working…' : 'Save AI settings'}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void refresh()}>Refresh Go models</button></div>
    </form>
    <div className="usage-summary"><span>{status.queued} queued · {status.failed} failed</span><span>{status.usage.month} · {status.usage.calls} calls</span><span>{status.usage.inputTokens.toLocaleString()} input / {status.usage.outputTokens.toLocaleString()} output tokens reported</span></div>
    <p className="muted settings-description">Usage limits, billing, and Extra Usage are managed directly in your <a className="text-link" href="https://opencode.ai/console" target="_blank" rel="noreferrer">OpenCode Go account</a>. DI has no local allowance settings or spending cap. {status.usage.uncertainCalls} requests have incomplete usage information; reported token totals are not an account allowance meter.</p>
    {error && <p className="error-message" role="alert">{error}</p>}
    <p className="copy-confirmation" role="status">{message}</p>
  </section>;
}
