import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { canonicalLabel, defaultVocabulary, FACETS, MAX_UPLOAD_BYTES, paletteToCss } from '@design-index/shared/browser';
import type { AiStatus, AssetKind, Facet, InboxStatus, LibraryItem, VocabularyState } from '@design-index/shared/browser';
import { api } from './api';
import { AiSettingsPanel } from './AiSettingsPanel';
import { IntelligencePanel } from './IntelligencePanel';
import { ThemeToggle } from './ThemeToggle';
import { VocabularyPanel } from './VocabularyPanel';
import { UrlCapturePanel } from './UrlCapturePanel';
import { EvaluationPanel } from './EvaluationPanel';
import { FolderInboxPanel } from './FolderInboxPanel';
import './styles.css';

function Icon({ name, size = 20 }: { name: 'grid' | 'plus' | 'search' | 'arrow' | 'close' | 'copy' | 'image' | 'upload' | 'check'; size?: number }) {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" /></>,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

function ItemDetail({ item, vocabulary, onClose, onUpdate, announce }: {
  item: LibraryItem; vocabulary: VocabularyState; onClose: () => void; onUpdate: (item: LibraryItem) => void; announce: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [view, setView] = useState<AssetKind>(item.type === 'url' ? 'viewport' : 'preview');
  const displayed = item.assets.find((asset) => asset.kind === view);
  const dirty = title !== item.title || note !== item.note;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  async function copy(text: string, message: string) {
    try { await navigator.clipboard.writeText(text); setConfirmation(message); announce(message); }
    catch { setError('Clipboard access was blocked. Use Download CSS, or select and copy a hex value.'); }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      const updated = await api.update(item.id, title, note);
      onUpdate(updated);
      setTitle(updated.title);
      setNote(updated.note);
      setConfirmation('Your notes are saved.');
      announce('Your notes are saved.');
    } catch (error) { setError(errorMessage(error)); }
    finally { setSaving(false); }
  }

  return <dialog ref={dialog} className="detail-dialog" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} aria-labelledby="detail-heading">
    <div className="detail-top"><span className="eyebrow">REFERENCE / {new Date(item.capturedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span><button className="icon-button" aria-label="Close reference" onClick={onClose}><Icon name="close" /></button></div>
    <div className="detail-grid">
      <div className="detail-art">
        {item.type === 'url' && <div className="capture-view-tabs" role="group" aria-label="Captured views">{(['viewport', 'full_page', 'mobile'] as const).map((kind) => <button className="secondary-button" key={kind} aria-pressed={view === kind} onClick={() => setView(kind)}>{kind === 'full_page' ? 'Full page' : kind === 'viewport' ? 'Desktop' : 'Mobile'}</button>)}</div>}
        <img src={displayed?.url ?? item.previewUrl} alt={item.title} />
        <a className="text-link" href={item.originalUrl} download>{item.type === 'url' ? 'Download full-page PNG' : 'Download untouched original'} <Icon name="arrow" size={16} /></a>
        <span className="muted text-xs">{(item.type === 'url' ? displayed?.width ?? item.width : item.width).toLocaleString()} × {(item.type === 'url' ? displayed?.height ?? item.height : item.height).toLocaleString()} px</span>
        {item.sourceUrl && <a className="text-link source-link" href={item.sourceUrl} target="_blank" rel="noreferrer">Open source page <Icon name="arrow" size={16} /></a>}
        {item.facts && <details className="page-facts"><summary>Captured page facts</summary><p>Fonts: {item.facts.fonts.join(', ') || 'not detected'}</p><p>{item.facts.styles.length} style samples · {item.facts.animations.length} CSS animation configurations · {item.facts.transitions.length} transitions</p>{item.facts.warnings.map((warning, index) => <p key={index}>{warning}</p>)}<details><summary>Measured style and motion samples</summary><pre>{JSON.stringify({ styles: item.facts.styles, animations: item.facts.animations, transitions: item.facts.transitions, libraries: item.facts.libraries }, null, 2)}</pre></details></details>}
      </div>
      <div className="detail-content">
        <h2 id="detail-heading">A closer look.</h2>
        <form onSubmit={save} className="detail-form">
          <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} required /></label>
          <label>Why you saved it<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} rows={3} placeholder="The detail you don’t want to forget…" /></label>
          <button className="secondary-button justify-self-start" type="submit" disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save notes'}</button>
        </form>
        <section className="palette-section" aria-labelledby="palette-heading">
          <div className="section-heading"><h3 id="palette-heading">Extracted palette</h3><span className="eyebrow">{item.facts ? 'CSS / pixels' : 'OKLab / pixels'}</span></div>
          <div className="detail-palette">{item.palette.map((color, index) => <button key={color.hex} className="color-tile" onClick={() => void copy(color.hex, `${color.hex} copied.`)} title={`Copy ${color.hex}`}>
            <span className="color-block" style={{ backgroundColor: color.hex }} /><span className="color-hex">{color.hex}</span><span className="muted text-xs">{Math.round(color.weight * 100)}% · color {index + 1}</span>
          </button>)}</div>
          <p className="muted text-xs leading-relaxed">{item.facts ? 'Colors come from opaque computed CSS first, with sampled pixels as a fallback.' : 'Colors come from sampled pixels.'} {item.intelligence.analysis ? 'Role assignments are model suggestions, restricted to these exact colors.' : 'Roles like “accent” stay unassigned until analysis.'}</p>
          <div className="flex flex-wrap gap-3 mt-4"><button className="secondary-button" onClick={() => void copy(paletteToCss(item.palette, item.intelligence.analysis?.palette_roles), 'Palette CSS copied.')}><Icon name="copy" size={15} /> Copy CSS</button><a className="text-link" href={`/api/items/${item.id}/palette.css`} download>Download CSS</a></div>
        </section>
        <IntelligencePanel item={item} vocabulary={vocabulary} onUpdate={onUpdate} confirm={(message) => { setConfirmation(message); announce(message); }} />
        {error && <p className="error-message" role="alert">{error}</p>}
        <p className="copy-confirmation" role="status">{confirmation}</p>
      </div>
    </div>
  </dialog>;
}

function App() {
  const [connected, setConnected] = useState(false);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [filterFacet, setFilterFacet] = useState<Facet>('style');
  const [filterLabel, setFilterLabel] = useState('');
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [inbox, setInbox] = useState<InboxStatus | null>(null);
  const inboxRevision = useRef<string | null>(null);
  const aiRevision = useRef<string | null>(null);
  const [showAi, setShowAi] = useState(false);
  const [vocabulary, setVocabulary] = useState<VocabularyState>(() => defaultVocabulary());
  const [showVocabulary, setShowVocabulary] = useState(false);
  const [showCapture, setShowCapture] = useState(false);
  const [showEvaluation, setShowEvaluation] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadLock = useRef(false);
  const requestVersion = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const visibleItems = useRef(items);
  visibleItems.current = items;
  const workWasActive = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api.connect().then(() => { if (!cancelled) setConnected(true); }).catch((error) => {
      if (!cancelled) { setError(errorMessage(error)); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    api.vocabulary().then((value) => { if (!cancelled) setVocabulary(value); }).catch((error) => { if (!cancelled) setError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [connected]);

  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    requestVersion.current++;
    setLoading(true);
    setLoadingMore(false);
    const timeout = window.setTimeout(() => {
      api.list(query, 0, controller.signal, filterLabel ? { facet: filterFacet, label: filterLabel } : undefined).then((page) => {
        if (!controller.signal.aborted) { setItems(page.items); setTotal(page.total); setLoading(false); }
      }).catch((error) => {
        if (!controller.signal.aborted) { setError(errorMessage(error)); setLoading(false); }
      });
    }, query ? 180 : 0);
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [connected, query, refresh, filterFacet, filterLabel]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    let polling = false;
    async function poll() {
      if (polling) return;
      polling = true;
      const version = requestVersion.current;
      try {
        const [status, folder] = await Promise.all([api.ai(), api.inbox()]);
        if (cancelled) return;
        setAi(status);
        const progress = JSON.stringify([status.analysis, status.queued, status.running, status.failed, status.usage]);
        const aiChanged = aiRevision.current !== progress;
        setInbox(folder);
        const revision = `${folder.directory ?? ''}:${folder.revision}`;
        const inboxChanged = folder.enabled && inboxRevision.current !== revision;
        if (!inboxChanged) inboxRevision.current = revision;
        const workActive = status.analysis === 'running' && status.queued + status.running > 0;
        if (workActive || workWasActive.current || inboxChanged || aiChanged) {
          const pages = await Promise.all(Array.from({ length: Math.max(1, Math.ceil(visibleItems.current.length / 50)) }, (_, index) => api.list(query, index * 50, undefined, filterLabel ? { facet: filterFacet, label: filterLabel } : undefined)));
          if (!cancelled && version === requestVersion.current) {
            setItems([...new Map(pages.flatMap((page) => page.items).map((item) => [item.id, item])).values()]);
            setTotal(pages[0]!.total);
            inboxRevision.current = revision;
            aiRevision.current = progress;
          }
        }
        if (!cancelled) workWasActive.current = workActive;
        if (selected) {
          const item = await api.item(selected.id);
          if (!cancelled) setSelected((current) => current?.id === item.id ? item : current);
        }
      } catch (error) { if (!cancelled) setError(errorMessage(error)); }
      finally { polling = false; }
    }
    void poll();
    const interval = window.setInterval(() => void poll(), 2000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [connected, query, filterFacet, filterLabel, selected?.id]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 4000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const capture = useCallback(async (files: FileList | File[]) => {
    if (uploadLock.current || !files.length || !connected) return;
    if (files.length > 1) { setError('Save one reference at a time for now.'); return; }
    const file = files[0]!;
    if (file.size > MAX_UPLOAD_BYTES) { setError('Choose an image under 20 MB.'); return; }
    uploadLock.current = true;
    setUploading(true); setError('');
    try {
      const result = await api.capture(file, title || file.name.replace(/\.[^.]+$/, '').slice(0, 160), note);
      setNotice(result.deduplicated ? 'Already in your index. Your original notes are unchanged.' : 'Reference saved. Palette extracted.');
      setTitle(''); setNote(''); setQuery(''); setRefresh((value) => value + 1);
      setSelected(result.item);
    } catch (error) { setError(errorMessage(error)); }
    finally { setUploading(false); uploadLock.current = false; if (fileInput.current) fileInput.current.value = ''; }
  }, [connected, title, note]);

  useEffect(() => {
    function paste(event: ClipboardEvent) {
      const target = event.target;
      if (target instanceof HTMLElement && (target.closest('input, textarea, [contenteditable="true"]') || selected)) return;
      const files = event.clipboardData?.files;
      if (files?.length) { event.preventDefault(); void capture(files); }
    }
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [capture, selected]);

  async function loadMore() {
    const version = requestVersion.current;
    setLoadingMore(true);
    try {
      const page = await api.list(query, items.length, undefined, filterLabel ? { facet: filterFacet, label: filterLabel } : undefined);
      if (version === requestVersion.current) {
        setItems((existing) => [...existing, ...page.items]); setTotal(page.total);
      }
    } catch (error) { if (version === requestVersion.current) setError(errorMessage(error)); }
    finally { if (version === requestVersion.current) setLoadingMore(false); }
  }

  function updateItem(item: LibraryItem) {
    setSelected(item);
    setItems((items) => items.map((existing) => existing.id === item.id ? item : existing));
    setRefresh((value) => value + 1);
  }

  async function reconnect() {
    setError('');
    try { await api.connect(); setConnected(true); setRefresh((value) => value + 1); }
    catch (error) { setError(errorMessage(error)); }
  }

  function updateVocabulary(value: VocabularyState) {
    setVocabulary(value);
    if (filterLabel) setFilterLabel(canonicalLabel(value, filterFacet, filterLabel));
    setRefresh((value) => value + 1);
  }
  async function toggleVocabulary() {
    if (showVocabulary) { setShowVocabulary(false); return; }
    try { updateVocabulary(await api.vocabulary()); setShowVocabulary(true); }
    catch (error) { setError(errorMessage(error)); }
  }
  async function captured(id: string) {
    setRefresh((value) => value + 1);
    try { const item = await api.item(id); setSelected((current) => current ?? item); setNotice('URL capture saved locally.'); }
    catch (error) { setError(errorMessage(error)); }
  }
  async function openInboxItem(id: string) {
    try { setSelected(await api.item(id)); }
    catch (error) { setError(errorMessage(error)); }
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Design Index home"><span className="brand-symbol">di<span>·</span></span><span>Design<br />Index</span></a>
      <div className="sidebar-label">YOUR LIBRARY</div>
      <button className="nav-item active" onClick={() => { setQuery(''); searchInput.current?.focus(); }}><Icon name="grid" size={17} /><span>All references</span></button>
      <div className="sidebar-card"><span className="index-mark">↳</span><p>Good design<br />is worth keeping.</p><span>A place for your<br />next starting point.</span></div>
      <div className="sidebar-bottom"><span className={`status-dot ${connected ? 'online' : ''}`} /><div>{connected ? 'On your machine' : 'Connecting…'}<small>Private by default</small></div></div>
    </aside>

    <main className="main-content">
      <header className="topbar"><span className="breadcrumb">Library <span>/</span> <strong>All references</strong></span><div className="topbar-actions"><span className="edition">PERSONAL EDITION <span>01</span></span><ThemeToggle /></div></header>
      <section className="page-heading"><div><p className="eyebrow">YOUR EYE, COLLECTED.</p><h1>A little inspiration.<br /><em>A lot of possibility.</em></h1><p className="intro">Keep the details that caught your eye.<br className="mobile-break" /> Make them the start of something new.</p></div><button className="primary-button header-add" onClick={() => fileInput.current?.click()} disabled={!connected || uploading}><Icon name="plus" size={18} /> Add reference</button></section>

      <section className={`capture-panel ${dragging ? 'dragging' : ''}`} aria-labelledby="capture-heading"
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); void capture(event.dataTransfer.files); }}>
        <div className="capture-icon"><Icon name={uploading ? 'upload' : 'image'} size={25} /></div>
        <div className="capture-copy"><h2 id="capture-heading">{uploading ? 'Finding the colors in your reference…' : dragging ? 'A good find. Drop it here.' : 'Found something worth saving?'}</h2><p>Drop an image, paste a screenshot, or <button className="inline-link" onClick={() => fileInput.current?.click()} disabled={!connected || uploading}>browse files</button>.<span className="file-hint"> PNG, JPG, WebP · up to 20 MB</span></p></div>
        <span className="capture-local">LOCAL FIRST <span>↙</span></span>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Choose reference image" tabIndex={-1} disabled={!connected || uploading} onChange={(event) => { if (event.target.files) void capture(event.target.files); }} />
        <div className="capture-fields"><label><span>Title <span className="optional">/ optional</span></span><input value={title} maxLength={160} placeholder="Give your find a name" onChange={(event) => setTitle(event.target.value)} disabled={uploading} /></label><label><span>Why I saved this <span className="optional">/ optional</span></span><input value={note} maxLength={2000} placeholder="The type, the palette, that one lovely detail…" onChange={(event) => setNote(event.target.value)} disabled={uploading} /></label></div>
      </section>

      {inbox && <FolderInboxPanel status={inbox} ai={ai} onChange={setInbox} onOpen={(id) => void openInboxItem(id)} />}
      <div className="ai-toolbar"><span className="muted">{ai ? `OpenCode Go · ${ai.analysis.replaceAll('_', ' ')} · ${ai.queued} queued` : 'Loading AI status…'}</span><div className="library-settings-actions"><button className="text-link" aria-expanded={showCapture} disabled={!connected} onClick={() => setShowCapture((value) => !value)}>{showCapture ? 'Close browser capture' : 'Browser capture'}</button><button className="text-link" aria-expanded={showEvaluation} disabled={!connected} onClick={() => setShowEvaluation((value) => !value)}>{showEvaluation ? 'Close evaluation lab' : 'Evaluation tools'}</button><button className="text-link" aria-expanded={showVocabulary} disabled={!connected} onClick={() => void toggleVocabulary()}>{showVocabulary ? 'Close vocabulary' : 'Vocabulary'}</button><button className="text-link" aria-expanded={showAi} onClick={() => setShowAi((value) => !value)}>{showAi ? 'Close AI settings' : 'AI settings'}</button></div></div>
      {showAi && ai && <AiSettingsPanel status={ai} onChange={setAi} />}
      {showVocabulary && <VocabularyPanel vocabulary={vocabulary} onChange={updateVocabulary} />}
      {showCapture && <UrlCapturePanel onCaptured={(id) => void captured(id)} />}
      {showEvaluation && <EvaluationPanel ai={ai} vocabulary={vocabulary} />}

      {error && <div className="error-message error-banner" role="alert"><span>{error}</span><button className="inline-link" onClick={() => void reconnect()}>Retry</button></div>}

      <section className="library-section" aria-labelledby="library-heading" aria-busy={loading}>
        <div className="library-toolbar"><div className="library-title"><h2 id="library-heading">{query ? 'Found in your index' : 'The collection'}</h2><span className="count">{total}</span></div><label className="search-field"><Icon name="search" size={17} /><span className="sr-only">Search references by title or note</span><input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} maxLength={200} placeholder="Search titles and notes…" />{query && <button className="icon-button small" aria-label="Clear search" onClick={() => setQuery('')}><Icon name="close" size={15} /></button>}</label></div>
        <div className="library-meta"><span>{query ? 'Text search · all words · prefix matching' : 'A growing archive of things that make you look twice.'}</span><span>{query ? 'RELEVANCE / NEWEST' : 'NEWEST FIRST'}</span></div>
        <div className="facet-filters"><label><span className="sr-only">Filter facet</span><select value={filterFacet} onChange={(event) => { setFilterFacet(event.target.value as Facet); setFilterLabel(''); }}>{FACETS.map((facet) => <option key={facet}>{facet}</option>)}</select></label><label><span className="sr-only">Filter label</span><select value={filterLabel} onChange={(event) => setFilterLabel(event.target.value)}><option value="">All labels</option>{[...new Set([...vocabulary.terms[filterFacet], ...vocabulary.retiredTerms[filterFacet]])].map((value) => <option key={value} value={value}>{value}{vocabulary.terms[filterFacet].includes(value) ? '' : ' (retired)'}</option>)}</select></label>{filterLabel && <button className="inline-link" onClick={() => setFilterLabel('')}>Clear label filter</button>}</div>
        {loading && !items.length ? <div className="empty-state"><span className="loading-ring" /><p>Opening your index…</p></div> : !items.length ? <div className="empty-state"><div className="empty-illustration"><div className="paper paper-back" /><div className="paper paper-front"><span /><span /><span /><i /></div><span className="empty-spark">✳</span></div><p className="eyebrow">{query ? 'NOT HERE. YET.' : 'EVERY COLLECTION STARTS WITH ONE.'}</p><h3>{query ? 'Nothing matches this search.' : 'What caught your eye today?'}</h3><p>{query ? 'Try a different word, or search something from your notes.' : 'Save your first reference above. Its colors will come with it.'}</p>{query ? <button className="secondary-button" onClick={() => setQuery('')}>Clear search</button> : <button className="text-link" onClick={() => fileInput.current?.click()} disabled={!connected || uploading}>Add your first reference <Icon name="arrow" size={17} /></button>}</div> : <>
          <div className={`gallery ${loading ? 'refreshing' : ''}`}>{items.map((item) => <button key={item.id} className="reference-card" onClick={() => setSelected(item)} aria-label={`Open ${item.title}`}><div className="reference-image"><img src={item.previewUrl} alt="" loading="lazy" style={{ aspectRatio: `${item.width} / ${item.height}` }} /><span className="image-open"><Icon name="arrow" size={18} /></span></div><div className="reference-body"><div className="reference-topline"><h3>{item.title}</h3><span className="reference-type">{item.type === 'url' ? 'URL' : 'IMG'}</span></div>{item.note && <p className="reference-note">{item.note}</p>}<div className="card-footer"><span className="palette-strip" aria-label="Extracted colors">{item.palette.map((color) => <span key={color.hex} style={{ backgroundColor: color.hex }} />)}</span><span className="queued-label">{item.status.replaceAll('_', ' ')}</span></div></div></button>)}</div>
          {items.length < total && <div className="load-more"><button className="secondary-button" disabled={loadingMore || loading} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : `Load more (${total - items.length})`}</button></div>}
        </>}
      </section>
      <footer className="page-footer"><span>Less searching. More making.</span><span>Saved here. Not out there. <span className="footer-dot">●</span></span></footer>
    </main>
    <div className={`toast ${notice ? 'visible' : ''}`} role="status" aria-live="polite">{notice && <><Icon name="check" size={17} />{notice}</>}</div>
    {selected && <ItemDetail key={selected.id} item={selected} vocabulary={vocabulary} onClose={() => setSelected(null)} onUpdate={updateItem} announce={setNotice} />}
  </div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
