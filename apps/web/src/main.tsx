import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MAX_UPLOAD_BYTES, paletteToCss } from '@design-index/shared/browser';
import type { LibraryItem } from '@design-index/shared/browser';
import { api } from './api';
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

function ItemDetail({ item, onClose, onUpdate, announce }: {
  item: LibraryItem; onClose: () => void; onUpdate: (item: LibraryItem) => void; announce: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');
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
      <div className="detail-art"><img src={item.previewUrl} alt={item.title} /><a className="text-link" href={item.originalUrl} download>Download untouched original <Icon name="arrow" size={16} /></a><span className="muted text-xs">{item.width.toLocaleString()} × {item.height.toLocaleString()} px</span></div>
      <div className="detail-content">
        <h2 id="detail-heading">A closer look.</h2>
        <form onSubmit={save} className="detail-form">
          <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} required /></label>
          <label>Why you saved it<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} rows={3} placeholder="The detail you don’t want to forget…" /></label>
          <button className="secondary-button justify-self-start" type="submit" disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save notes'}</button>
        </form>
        <section className="palette-section" aria-labelledby="palette-heading">
          <div className="section-heading"><h3 id="palette-heading">Extracted palette</h3><span className="eyebrow">OKLab / pixels</span></div>
          <div className="detail-palette">{item.palette.map((color, index) => <button key={color.hex} className="color-tile" onClick={() => void copy(color.hex, `${color.hex} copied.`)} title={`Copy ${color.hex}`}>
            <span className="color-block" style={{ backgroundColor: color.hex }} /><span className="color-hex">{color.hex}</span><span className="muted text-xs">{Math.round(color.weight * 100)}% · color {index + 1}</span>
          </button>)}</div>
          <p className="muted text-xs leading-relaxed">From a downsampled image, not an AI guess. Roles like “accent” are not assigned yet.</p>
          <div className="flex flex-wrap gap-3 mt-4"><button className="secondary-button" onClick={() => void copy(paletteToCss(item.palette), 'Palette CSS copied.')}><Icon name="copy" size={15} /> Copy CSS</button><a className="text-link" href={`/api/items/${item.id}/palette.css`} download>Download CSS</a></div>
        </section>
        <section className="analysis-note"><span className="status-dot" /><div><h3>Saved locally. AI comes next.</h3><p>Labels and a design-language prompt will appear here once analysis is connected. Your reference and palette are already usable.</p></div></section>
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

  useEffect(() => {
    let cancelled = false;
    api.connect().then(() => { if (!cancelled) setConnected(true); }).catch((error) => {
      if (!cancelled) { setError(errorMessage(error)); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    requestVersion.current++;
    setLoading(true);
    setLoadingMore(false);
    const timeout = window.setTimeout(() => {
      api.list(query, 0, controller.signal).then((page) => {
        if (!controller.signal.aborted) { setItems(page.items); setTotal(page.total); setLoading(false); }
      }).catch((error) => {
        if (!controller.signal.aborted) { setError(errorMessage(error)); setLoading(false); }
      });
    }, query ? 180 : 0);
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [connected, query, refresh]);

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
      const page = await api.list(query, items.length);
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

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Design Index home"><span className="brand-symbol">di<span>·</span></span><span>Design<br />Index</span></a>
      <div className="sidebar-label">YOUR LIBRARY</div>
      <button className="nav-item active" onClick={() => { setQuery(''); searchInput.current?.focus(); }}><Icon name="grid" size={17} /><span>All references</span></button>
      <div className="sidebar-card"><span className="index-mark">↳</span><p>Good design<br />is worth keeping.</p><span>A place for your<br />next starting point.</span></div>
      <div className="sidebar-bottom"><span className={`status-dot ${connected ? 'online' : ''}`} /><div>{connected ? 'On your machine' : 'Connecting…'}<small>Private by default</small></div></div>
    </aside>

    <main className="main-content">
      <header className="topbar"><span className="breadcrumb">Library <span>/</span> <strong>All references</strong></span><span className="edition">PERSONAL EDITION <span>01</span></span></header>
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

      {error && <div className="error-message error-banner" role="alert"><span>{error}</span><button className="inline-link" onClick={() => void reconnect()}>Retry</button></div>}

      <section className="library-section" aria-labelledby="library-heading" aria-busy={loading}>
        <div className="library-toolbar"><div className="library-title"><h2 id="library-heading">{query ? 'Found in your index' : 'The collection'}</h2><span className="count">{total}</span></div><label className="search-field"><Icon name="search" size={17} /><span className="sr-only">Search references by title or note</span><input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} maxLength={200} placeholder="Search titles and notes…" />{query && <button className="icon-button small" aria-label="Clear search" onClick={() => setQuery('')}><Icon name="close" size={15} /></button>}</label></div>
        <div className="library-meta"><span>{query ? 'Text search · all words · prefix matching' : 'A growing archive of things that make you look twice.'}</span><span>{query ? 'RELEVANCE / NEWEST' : 'NEWEST FIRST'}</span></div>
        {loading && !items.length ? <div className="empty-state"><span className="loading-ring" /><p>Opening your index…</p></div> : !items.length ? <div className="empty-state"><div className="empty-illustration"><div className="paper paper-back" /><div className="paper paper-front"><span /><span /><span /><i /></div><span className="empty-spark">✳</span></div><p className="eyebrow">{query ? 'NOT HERE. YET.' : 'EVERY COLLECTION STARTS WITH ONE.'}</p><h3>{query ? 'Nothing matches this search.' : 'What caught your eye today?'}</h3><p>{query ? 'Try a different word, or search something from your notes.' : 'Save your first reference above. Its colors will come with it.'}</p>{query ? <button className="secondary-button" onClick={() => setQuery('')}>Clear search</button> : <button className="text-link" onClick={() => fileInput.current?.click()} disabled={!connected || uploading}>Add your first reference <Icon name="arrow" size={17} /></button>}</div> : <>
          <div className={`gallery ${loading ? 'refreshing' : ''}`}>{items.map((item) => <button key={item.id} className="reference-card" onClick={() => setSelected(item)} aria-label={`Open ${item.title}`}><div className="reference-image"><img src={item.previewUrl} alt="" loading="lazy" style={{ aspectRatio: `${item.width} / ${item.height}` }} /><span className="image-open"><Icon name="arrow" size={18} /></span></div><div className="reference-body"><div className="reference-topline"><h3>{item.title}</h3><span className="reference-type">IMG</span></div>{item.note && <p className="reference-note">{item.note}</p>}<div className="card-footer"><span className="palette-strip" aria-label="Extracted colors">{item.palette.map((color) => <span key={color.hex} style={{ backgroundColor: color.hex }} />)}</span><span className="queued-label">AI queued</span></div></div></button>)}</div>
          {items.length < total && <div className="load-more"><button className="secondary-button" disabled={loadingMore || loading} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : `Load more (${total - items.length})`}</button></div>}
        </>}
      </section>
      <footer className="page-footer"><span>Less searching. More making.</span><span>Saved here. Not out there. <span className="footer-dot">●</span></span></footer>
    </main>
    <div className={`toast ${notice ? 'visible' : ''}`} role="status" aria-live="polite">{notice && <><Icon name="check" size={17} />{notice}</>}</div>
    {selected && <ItemDetail key={selected.id} item={selected} onClose={() => setSelected(null)} onUpdate={updateItem} announce={setNotice} />}
  </div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
