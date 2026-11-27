import { useCallback, useEffect, useRef, useState } from 'react';
import { langName, parsePO, startFromPot } from '../../shared/po.js';
import { api } from '../lib/api.js';
import { timeText } from '../lib/util.js';
import { Icon } from './Icons.jsx';
import { NewLangDialog } from './Dialogs.jsx';

export default function StartScreen({ onOpen, toast, confirm, draft, onRestoreDraft, onDiscardDraft }) {
  const [files, setFiles] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [tm, setTm] = useState([]);
  const [loadErr, setLoadErr] = useState('');
  const [q, setQ] = useState('');
  const [over, setOver] = useState(false);
  const [newFrom, setNewFrom] = useState(null);   // { path, count, entries }
  const input = useRef(null);

  const load = useCallback(async () => {
    try {
      const [f, c, t] = await Promise.all([api.files(), api.config(), api.tmStats()]);
      setFiles(f.files); setCfg(c); setTm(t.langs); setLoadErr('');
    } catch (e) { setLoadErr(e.message); setFiles((x) => x || []); }
  }, []);
  useEffect(() => {
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  async function openPath(path) {
    try {
      const r = await api.read(path);
      const entries = parsePO(r.text);
      if (/\.pot$/i.test(path)) { setNewFrom({ path: r.path, entries, count: entries.filter((e) => e.editable).length }); return; }
      onOpen(entries, { path: r.path, name: r.name, mtime: r.mtime });
    } catch (e) { toast(`Could not open ${path}: ${e.message}`); }
  }

  // A file from this computer is copied into the workspace, then opened.
  async function importFile(file) {
    if (!file) return;
    if (!/\.pot?$/i.test(file.name)) { toast('Pick a .po or .pot file.'); return; }
    const text = await file.text();
    try { await api.save(file.name, text, null, false); }
    catch (e) {
      if (e.status !== 409) { toast('Could not import: ' + e.message); return; }
      if (!(await confirm(`Replace ${file.name}?`, `The workspace already has ${file.name}. Importing replaces it with the file you picked.`, 'Replace'))) return;
      try { await api.save(file.name, text, null, true); } catch (e2) { toast('Could not import: ' + e2.message); return; }
    }
    await load();
    openPath(file.name);
  }

  function createLang(lang, path) {
    const entries = startFromPot(newFrom.entries, lang);
    setNewFrom(null);
    onOpen(entries, { path, mtime: null, dirty: true });
    toast(`New ${langName(lang)} file made from the template. Save to create ${path}.`);
  }

  const shown = (files || []).filter((f) => !q || f.path.toLowerCase().includes(q.toLowerCase()) || langName(f.lang).toLowerCase().includes(q.toLowerCase()));

  return (
    <div id="start"
      onDragOver={(ev) => { ev.preventDefault(); setOver(true); }}
      onDragLeave={(ev) => { if (!ev.relatedTarget) setOver(false); }}
      onDrop={(ev) => { ev.preventDefault(); setOver(false); importFile(ev.dataTransfer.files[0]); }}>
      <header className="topbar">
        <div className="brand">po</div>
        <strong style={{ fontSize: 14 }}>PO Messages Editor</strong>
        {cfg && <span className="ws" title="Workspace folder on the server">{cfg.workspace}</span>}
      </header>
      <div className="start-wrap">
        {draft && (
          <div className="banner">
            <span>You have unsaved work on {draft.path} ({langName(draft.lang)}) from {timeText(draft.at)}.</span>
            <button type="button" className="btn" onClick={onDiscardDraft}>Discard</button>
            <button type="button" className="btn primary" onClick={onRestoreDraft}>Restore</button>
          </div>
        )}
        <div className="start-row">
          <section className="card recent-list" style={{ flex: '2 1 560px', display: 'flex', flexDirection: 'column' }} aria-label="Translation files">
            <div className="files-head" style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>
              <h2>Translation files</h2>
              <label className="search" style={{ flex: '0 1 220px' }}>
                <Icon name="search" />
                <span className="sr">Filter files</span>
                <input type="search" value={q} onChange={(ev) => setQ(ev.target.value)} placeholder="Filter by name or language" />
              </label>
              <button type="button" className="btn" onClick={load} title="Look for files again"><Icon name="refresh" />Refresh</button>
              <button type="button" className="btn primary" onClick={() => input.current.click()}><Icon name="upload" />Import file</button>
              <input type="file" ref={input} accept=".po,.pot" hidden onChange={(ev) => { const f = ev.target.files[0]; ev.target.value = ''; importFile(f); }} />
            </div>
            {loadErr && <p className="empty-list err" style={{ margin: 0 }}>Cannot reach the server: {loadErr}</p>}
            {files === null ? <p className="empty-list" style={{ margin: 0 }}>Loading…</p>
              : !shown.length ? (
                <div className={'drop' + (over ? ' over' : '')} style={{ margin: 12 }}>
                  <strong style={{ fontSize: 15 }}>{files.length ? 'No files match the filter.' : 'The workspace has no .po or .pot files yet.'}</strong>
                  <span style={{ color: 'var(--soft)' }}>Drop a file here or use <b>Import file</b>.</span>
                </div>
              ) : shown.map((f) => <FileRow key={f.path} f={f} onClick={() => openPath(f.path)} />)}
            {over && shown.length > 0 && <p className="empty-list" style={{ margin: 0, color: 'var(--blue)' }}>Drop to import into the workspace</p>}
          </section>
          <div className="side-cards">
            <div className="card">
              <h2>Start a new language</h2>
              <p>Click a <span className="tag">TEMPLATE</span> (.pot) in the list, pick the language and where the file goes. The plural rule is filled in for you.</p>
            </div>
            <div className="card">
              <h2>Update from a new .pot</h2>
              <p>Open your .po first, then use <b>Update from .pot</b>. New strings are added, removed ones are kept as old entries, and changed ones are marked for review.</p>
            </div>
            <div className="card">
              <h2>Team memory</h2>
              {tm.length
                ? <p>{tm.map((x) => `${langName(x.lang)}: ${x.count.toLocaleString()}`).join(' · ')}</p>
                : <p>Empty. Finished translations are added as anyone on the team works, and suggested for similar strings.</p>}
            </div>
          </div>
        </div>
      </div>
      {newFrom && <NewLangDialog pot={newFrom} existing={files || []} onCreate={createLang} onClose={() => setNewFrom(null)} />}
    </div>
  );
}

function FileRow({ f, onClick }) {
  const dir = f.path.slice(0, f.path.length - f.name.length);
  if (f.error) {
    return (
      <button type="button" className="file-row" onClick={onClick}>
        <span className="grow"><strong>{f.name}</strong><span className="sub">{dir}</span></span>
        <span className="err" style={{ gridColumn: 'span 3' }}>Could not read: {f.error}</span>
      </button>
    );
  }
  const pct = f.all ? Math.round(f.done / f.all * 100) : 0;
  const todo = [f.review && `${f.review} to review`, f.empty && `${f.empty} untranslated`, f.warn && `${f.warn} warnings`].filter(Boolean).join(' · ');
  return (
    <button type="button" className="file-row" onClick={onClick} title={f.kind === 'pot' ? 'Start a new language from this template' : 'Open ' + f.path}>
      <span className="grow">
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><strong>{f.name}</strong>{f.kind === 'pot' && <span className="tag">TEMPLATE</span>}</span>
        <span className="sub">{dir || 'workspace root'}{f.kind === 'po' && todo ? ' · ' + todo : ''}</span>
      </span>
      <span style={{ color: 'var(--soft)' }}>{f.kind === 'pot' ? `${f.all} strings` : (f.lang ? langName(f.lang) : 'Language not set')}</span>
      {f.kind === 'pot'
        ? <span style={{ color: 'var(--blue)', fontWeight: 600, fontSize: 12 }}>New language →</span>
        : (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="bar" style={{ flex: 1 }}>
              <span style={{ width: `${f.all ? f.done / f.all * 100 : 0}%`, background: 'var(--blue)' }} />
              <span style={{ width: `${f.all ? f.review / f.all * 100 : 0}%`, background: 'var(--orange)' }} />
            </span>
            <strong style={{ width: 36, textAlign: 'right', fontSize: 12 }}>{pct}%</strong>
          </span>
        )}
      <span style={{ fontSize: 12, color: 'var(--soft)', textAlign: 'right' }}>{timeText(f.mtime)}</span>
    </button>
  );
}
