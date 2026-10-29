import { useState } from 'react';
import type { AiStatus, InboxStatus } from '@design-index/shared/browser';
import { api } from './api';

export function FolderInboxPanel({ status, ai, onChange, onOpen }: { status: InboxStatus; ai: AiStatus | null; onChange: (status: InboxStatus) => void; onOpen: (id: string) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  async function retry() {
    setBusy(true); setError(''); setMessage('');
    try { onChange(await api.retryInbox()); setMessage('Failed imports will be checked again. Existing references are not re-analyzed.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not retry inbox imports.'); }
    finally { setBusy(false); }
  }
  async function copyPath() {
    try { await navigator.clipboard.writeText(status.directory!); setMessage('Inbox folder path copied.'); }
    catch { setError('Could not copy the path. Select and copy the folder path shown below.'); }
  }
  return <section className="folder-inbox" aria-label="Folder inbox"><details>
    <summary>Folder inbox <span className="muted">{!status.enabled ? 'disabled' : status.error ? 'needs attention' : `${status.pending} waiting · ${status.imported} imported · ${status.failed} failed`}</span></summary>
    {status.enabled ? <>
      <p className="muted settings-description">Drop PNG, JPEG, or WebP images directly into this folder. The app checks every 2 seconds and waits for files to stop changing. Sources stay untouched; exact duplicates reuse the existing reference.</p>
      <code className="inbox-path">{status.directory}</code>
      <div className="settings-actions"><button className="text-link" onClick={() => void copyPath()}>Copy inbox path</button><button className="secondary-button" disabled={busy || !status.failed} onClick={() => void retry()}>Retry failed imports</button></div>
      <p className="muted settings-description">{ai?.settings.allowImageSharing ? 'New references start AI analysis and coding-agent prompt generation automatically when the server key and model permissions are ready. Usage limits are managed in your OpenCode Go account.' : 'Image sharing is not approved. Images still import locally and stay queued. Approve sharing in AI settings to start automatic analysis and prompt generation.'} Subfolders, hidden files, temporary files, and symbolic links are ignored. Limits: 20 MiB and 40 megapixels per image.</p>
      {status.recent.length > 0 && <div className="inbox-history" aria-label="Recent folder imports">{status.recent.map((entry) => <div className="inbox-entry" key={entry.fileName}>
        <div><strong>{entry.fileName}</strong><span className="muted">{entry.status}{entry.deduplicated ? ' · already in library' : ''}{entry.retryAt ? ' · retry scheduled' : ''}</span></div>
        {entry.error && <p className="error-message">{entry.error}</p>}
        {entry.itemId && <button className="text-link" onClick={() => onOpen(entry.itemId!)}>Open imported reference</button>}
      </div>)}</div>}
    </> : <p className="muted settings-description">Folder watching is disabled for this server. Set DESIGN_INDEX_INBOX_DIR to an absolute folder and restart. The normal project entrypoint defaults to the project’s inbox/ folder.</p>}
    {(status.error || error) && <p className="error-message" role="alert">{error || status.error}</p>}
    <p className="copy-confirmation" role="status">{message}</p>
  </details></section>;
}
