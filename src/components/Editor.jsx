import { Fragment, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  countsOf, statusOf, warningsOf, placeholders, langName, langPlural, headerOf, headerGet, headerSet,
  npluralsOf, serializePO, entryLines, mergePot, parseQuoted
} from '../../shared/po.js';
import { api } from '../lib/api.js';
import { stampHeader, tmItems } from '../lib/doc.js';
import { store, debounce, timeText, download, saveDraftNow, clearDraft, aiReady, AI_PROVIDERS } from '../lib/util.js';
import { Icon, WarnIcon } from './Icons.jsx';
import StringList from './StringList.jsx';
import { PropsDialog, PotDialog, AiSettingsDialog } from './Dialogs.jsx';

const TABS = [['all', 'All'], ['empty', 'Untranslated'], ['review', 'Needs review'], ['warn', 'Warnings'], ['done', 'Done']];

function matches(e, filter, query) {
  if (!e.editable) return false;
  if (filter === 'warn' ? !e.warn.length : (filter !== 'all' && statusOf(e) !== filter)) return false;
  if (!query) return true;
  const q = query.toLowerCase();
  return e.id.toLowerCase().includes(q) || (e.idPlural || '').toLowerCase().includes(q) ||
    (e.ctx || '').toLowerCase().includes(q) || e.strs.some((s) => s.toLowerCase().includes(q));
}
function computeView(entries, filter, query) {
  const v = [];
  entries.forEach((e, i) => { if (matches(e, filter, query)) v.push(i); });
  return v;
}
function pluralLabels(n) {
  if (n === 1) return ['Translation (all counts)'];
  if (n === 2) return ['Singular (1)', 'Plural (2 or more)'];
  return Array.from({ length: n }, (_, i) => 'Form ' + (i + 1));
}

// Source text with placeholders and line breaks marked.
const SPLIT = /(%\([\w.]+\)[-#0 +]*\d*(?:\.\d+)?[a-zA-Z]|%[-#0 +]*\d*(?:\.\d+)?[sdifuxXeEgGcr]|\{[\w.]*(?::[^{}]*)?\}|\n)/;
function Marked({ text }) {
  return text.split(SPLIT).map((part, i) => {
    if (!part) return null;
    if (part === '\n') return <Fragment key={i}><span className="nl">↵</span>{'\n'}</Fragment>;
    if (/^(%|\{)/.test(part) && placeholders(part).length) return <span key={i} className="ph">{part}</span>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export default function Editor({ doc, onClose, toast, confirm, ai, onAiChange }) {
  const [, bump] = useReducer((x) => x + 1, 0);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [qInput, setQInput] = useState('');
  const [view, setView] = useState(() => computeView(doc.entries, 'all', ''));
  const [sel, setSel] = useState(() => {
    const i = doc.entries.findIndex((e) => e.editable && (statusOf(e) !== 'done' || e.warn.length));
    return i >= 0 ? i : (computeView(doc.entries, 'all', '')[0] ?? -1);
  });
  const [focusReq, setFocusReq] = useState(0);
  const [suggs, setSuggs] = useState([]);
  const [dialog, setDialog] = useState(null);   // 'props' | 'pot' | 'ai'
  const [aiRes, setAiRes] = useState(null);     // { e, status: 'loading' | 'done' | 'error', items, error, ms, cached, started }
  const [, setTick] = useState(0);              // redraws the seconds counter while the AI works
  const aiCache = useRef(new WeakMap());        // entry -> { promise, result } for asked and prefetched strings
  const [busy, setBusy] = useState('');
  const savingRef = useRef(false);
  const qRef = useRef(null);

  const saveDraft = useMemo(() => debounce(() => saveDraftNow(doc, toast), 1500), [doc, toast]);
  const c = countsOf(doc.entries);
  const cur = doc.entries[sel];
  const ok = !!(cur && cur.editable);

  /* ---------------- list and selection ---------------- */
  function rebuild(f, q, keepSel) {
    const v = computeView(doc.entries, f, q);
    setView(v);
    setSel(keepSel && v.includes(sel) ? sel : (v.length ? v[0] : -1));
    return v;
  }
  function select(i, focus = true) {
    setSel(i);
    if (focus) setFocusReq((n) => n + 1);
  }
  useEffect(() => { if (focusReq) document.getElementById('tr0')?.focus(); }, [focusReq]);
  function move(step) {
    if (!view.length) return;
    let p = view.indexOf(sel);
    p = p < 0 ? 0 : (p + step + view.length) % view.length;
    select(view[p]);
  }
  // The next string still to do after the selected one: one in the list
  // first, else any (the caller then shows All).
  function nextUnfinished() {
    const ed = doc.entries, inView = new Set(view);
    let any = -1;
    for (let k = 1; k < ed.length; k++) {
      const i = (sel + k) % ed.length, e = ed[i];
      if (!e.editable || (statusOf(e) === 'done' && !e.warn.length)) continue;
      if (inView.has(i)) return i;
      if (any < 0) any = i;
    }
    return any;
  }
  function changeFilter(f) { setFilter(f); rebuild(f, query, true); }
  useEffect(() => {
    const t = setTimeout(() => {
      const q = qInput.trim();
      if (q !== query) { setQuery(q); rebuild(filter, q, true); }
    }, 150);
    return () => clearTimeout(t);
  });

  /* ---------------- editing ---------------- */
  function touch(e) {
    e.dirty = true;
    doc.dirty = true;
    saveDraft();
    bump();
  }
  function setFuzzy(e, on) {
    const has = e.flags.includes('fuzzy');
    if (on === has) return;
    if (on) e.flags.unshift('fuzzy'); else { e.flags = e.flags.filter((f) => f !== 'fuzzy'); e.prev = []; }
    touch(e);
  }
  function editStr(i, value) {
    cur.strs[i] = value;
    cur.warn = warningsOf(cur);
    touch(cur);
  }
  function applyTranslation(text) {
    if (!ok) return;
    cur.strs = cur.strs.map((s, i) => (i === 0 || cur.idPlural !== null ? text : s));
    cur.warn = warningsOf(cur);
    touch(cur);
    setFocusReq((n) => n + 1);
  }
  // Use an AI suggestion: one text, or one per plural form.
  function applyForms(forms) {
    if (!ok) return;
    cur.strs = cur.idPlural !== null ? cur.strs.map((s, i) => forms[i] ?? forms[forms.length - 1]) : [forms[0]];
    cur.warn = warningsOf(cur);
    touch(cur);
    setFocusReq((n) => n + 1);
  }
  const copySource = () => { if (ok) applyTranslation(cur.idPlural !== null && doc.nplurals > 1 ? cur.idPlural : cur.id); };
  const toggleReview = () => { if (ok) setFuzzy(cur, !cur.flags.includes('fuzzy')); };
  function doneAndNext() {
    if (!ok) return;
    if (statusOf(cur) === 'empty') { toast('Type the translation first.'); return; }
    setFuzzy(cur, false);
    api.tmAdd(doc.lang, doc.path, tmItems([cur])).catch(() => {});
    const next = nextUnfinished();
    let f = filter;
    if (next >= 0 && !view.includes(next)) { f = 'all'; setFilter('all'); }
    rebuild(f, query, true);
    if (next >= 0) select(next);
    else toast('Everything is done. Save when you are ready.');
  }
  function setComment(text) {
    if (!ok) return;
    cur.comments = text ? text.split('\n') : [];
    touch(cur);
  }

  /* ---------------- suggestions from the team memory ---------------- */
  useEffect(() => {
    if (!cur || !cur.editable || !doc.lang) { setSuggs([]); return; }
    let live = true;
    api.suggest(doc.lang, cur.id).then((r) => { if (live) setSuggs(r.suggestions); }).catch(() => { if (live) setSuggs([]); });
    return () => { live = false; };
  }, [cur, doc.lang]);

  /* ---------------- AI suggestions ---------------- */
  const canAi = aiReady(ai);
  // One request per string: asking again while it runs, or after a prefetch,
  // reuses the same answer. The server adds team translations as examples.
  function fetchAi(e, fresh) {
    const hit = aiCache.current.get(e);
    if (hit && !fresh) return hit.promise;
    const promise = api.aiSuggest({
      provider: ai.provider, model: ai.model, apiKey: ai.apiKey, baseURL: ai.baseURL,
      lang: doc.lang, langName: langName(doc.lang),
      nforms: e.idPlural !== null ? doc.nplurals : 1,
      entry: { id: e.id, idPlural: e.idPlural, ctx: e.ctx, notes: e.extracted.join(' '), comment: e.comments.join(' ') },
      fresh: !!fresh
    }).then((r) => { const v = aiCache.current.get(e); if (v && v.promise === promise) v.result = r; return r; },
      (err) => { if (aiCache.current.get(e)?.promise === promise) aiCache.current.delete(e); throw err; });
    aiCache.current.set(e, { promise, result: null });
    return promise;
  }
  // With auto-ask on, prepare the next few strings to do while you work on this one.
  function prefetchNext() {
    const p = view.indexOf(sel);
    let n = 0;
    for (let k = 1; k < view.length && n < 2; k++) {
      const e = doc.entries[view[(p + k) % view.length]];
      if (statusOf(e) === 'done' && !e.warn.length) continue;
      n++;
      if (!aiCache.current.has(e)) fetchAi(e).catch(() => {});
    }
  }
  async function askAi(force) {
    const e = cur;
    if (!e || !e.editable) return;
    if (!canAi) { setDialog('ai'); return; }
    if (!doc.lang) { toast('Set the language in Properties first, so the AI knows what to translate into.'); return; }
    const hit = !force && aiCache.current.get(e);
    if (hit && hit.result) { setAiRes({ e, status: 'done', items: hit.result.suggestions, ms: hit.result.ms, cached: true }); return; }
    setAiRes({ e, status: 'loading', started: Date.now() });
    try {
      const r = await fetchAi(e, force);
      setAiRes((x) => (x && x.e === e ? { e, status: 'done', items: r.suggestions, ms: r.ms, cached: r.cached } : x));
      if (ai.auto) keys.current.prefetchNext();
    } catch (err) {
      setAiRes((x) => (x && x.e === e ? { e, status: 'error', error: err.message } : x));
    }
  }
  // Answers from another model are not reused.
  useEffect(() => { aiCache.current = new WeakMap(); setAiRes(null); }, [ai.provider, ai.model, ai.baseURL]);
  // Show what is known for the selected string, or ask by itself when that is on.
  useEffect(() => {
    if (!cur || !cur.editable) { setAiRes(null); return; }
    const hit = aiCache.current.get(cur);
    if (hit) { keys.current.askAi(false); return; }
    setAiRes(null);
    if (!ai.auto || !canAi || !doc.lang) return;
    const t = setTimeout(() => keys.current.askAi(false), 250);
    return () => clearTimeout(t);
  }, [cur, ai.auto, canAi, doc.lang]);
  const aiLoading = aiRes?.e === cur && aiRes.status === 'loading';
  useEffect(() => {
    if (!aiLoading) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [aiLoading]);

  /* ---------------- files ---------------- */
  async function write(force) {
    stampHeader(doc);
    const text = serializePO(doc.entries);
    let r;
    try { r = await api.save(doc.path, text, doc.mtime, force); }
    catch (err) {
      if (err.status !== 409) { toast('Could not save: ' + err.message); bump(); return false; }
      const exists = err.data.reason === 'exists';
      const yes = await confirm(
        exists ? `Replace ${doc.path}?` : `${doc.name} changed on disk`,
        exists ? 'A file with this name already exists in the workspace. Saving replaces it.'
          : `Someone else saved ${doc.path} after you opened it (${timeText(err.data.mtime)}). Saving now replaces their version with yours. To keep both, cancel and use Download .po.`,
        exists ? 'Replace' : 'Overwrite');
      return yes ? write(true) : false;
    }
    // What was written becomes the new "as read" text of every entry.
    for (const e of doc.entries) if (e.dirty && !e.obsolete) { e.raw = entryLines(e); e.dirty = false; }
    doc.dirty = serializePO(doc.entries) !== text;   // typed more while saving
    doc.mtime = r.mtime;
    doc.savedAt = Date.now();
    if (!doc.dirty) clearDraft();
    api.tmAdd(doc.lang, doc.path, tmItems(doc.entries)).catch(() => {});
    bump();
    toast('Saved ' + r.path);
    return true;
  }
  async function save() {
    if (savingRef.current) return false;
    savingRef.current = true; setBusy('save');
    try { return await write(false); } finally { savingRef.current = false; setBusy(''); }
  }
  async function buildMo() {
    if ((doc.dirty || doc.mtime === null) && !(await save())) return;
    setBusy('mo');
    try {
      const r = await api.buildMo(doc.path);
      const left = c.review + c.empty;
      toast(`Wrote ${r.path} with ${r.strings} strings.${left ? ` ${left} needing review or untranslated are left out.` : ''}`,
        { label: 'Download', onClick: () => { window.location.href = api.moUrl(doc.path); } });
    } catch (err) { toast('Could not build the .mo file: ' + err.message); }
    finally { setBusy(''); }
  }
  async function close() {
    if (doc.dirty && !(await confirm('Leave without saving?', `${doc.name} has changes that are not saved. They stay in this browser as a draft you can restore.`, 'Leave'))) return;
    saveDraftNow(doc, toast);
    onClose();
  }
  function validate() {
    changeFilter('warn');
    toast(c.warn ? `${c.warn} string${c.warn === 1 ? ' has' : 's have'} a warning.` : 'No warnings. Placeholders and line breaks all match.');
  }
  async function pretranslate() {
    const todo = doc.entries.filter((e) => e.editable && e.idPlural === null && statusOf(e) === 'empty');
    if (!todo.length) { toast('There are no untranslated single strings.'); return; }
    if (!doc.lang) { toast('Set the language in Properties first.'); return; }
    let ts;
    try { ({ ts } = await api.tmLookup(doc.lang, todo.map((e) => e.id))); }
    catch (err) { toast('Could not reach the team memory: ' + err.message); return; }
    let n = 0;
    todo.forEach((e, k) => {
      if (!ts[k]) return;
      e.strs = [ts[k]];
      if (!e.flags.includes('fuzzy')) e.flags.unshift('fuzzy');
      e.warn = warningsOf(e); e.dirty = true; n++;
    });
    if (!n) { toast('No exact matches in the team memory for the untranslated strings.'); return; }
    doc.dirty = true; saveDraft(); bump();
    setFilter('review'); rebuild('review', query, false);
    toast(`${n} string${n === 1 ? '' : 's'} filled from the team memory and marked for review.`);
  }
  async function updateFromPot(potEntries, potName) {
    setDialog(null);
    const r = mergePot(doc.entries, potEntries, doc.nplurals);
    const yes = await confirm('Update from ' + potName + '?',
      `${r.added} new string${r.added === 1 ? '' : 's'} will be added, ${r.changed} changed string${r.changed === 1 ? ' is' : 's are'} filled from the closest old one and marked for review, and ${r.removed} string${r.removed === 1 ? '' : 's'} no longer used will be kept at the end as old entries.`, 'Update');
    if (!yes) return;
    doc.entries = r.entries;
    doc.dirty = true; saveDraft(); bump();
    const f = r.changed ? 'review' : (r.added ? 'empty' : 'all');
    setFilter(f); rebuild(f, query, false);
  }
  function applyProps({ name, lang, plural }) {
    setDialog(null);
    store.set('poe.name', name);
    const h = headerOf(doc.entries);
    if (lang !== doc.lang || plural !== headerGet(h, 'Plural-Forms')) {
      headerSet(h, 'Language', lang);
      if (plural) headerSet(h, 'Plural-Forms', plural);
      doc.lang = lang;
      doc.nplurals = npluralsOf(h);
      doc.entries.forEach((e) => {
        if (!e.editable || e.idPlural === null || e.strs.length === doc.nplurals) return;
        e.strs = Array.from({ length: doc.nplurals }, (_, i) => e.strs[i] || ''); e.warn = warningsOf(e); e.dirty = true;
      });
      doc.dirty = true; saveDraft();
    }
    bump();
  }

  /* ---------------- keyboard ---------------- */
  const keys = useRef();
  keys.current = { save, doneAndNext, move, toggleReview, copySource, applyTranslation, suggs, askAi, prefetchNext };
  useEffect(() => {
    const onKey = (ev) => {
      if (document.querySelector('dialog[open]')) return;
      const k = keys.current, mod = ev.ctrlKey || ev.metaKey, key = ev.key.toLowerCase();
      if (mod && key === 's') { ev.preventDefault(); k.save(); }
      else if (mod && ev.key === 'Enter') { ev.preventDefault(); k.doneAndNext(); }
      else if (mod && key === 'f') { ev.preventDefault(); qRef.current.focus(); qRef.current.select(); }
      else if (mod && key === 'u') { ev.preventDefault(); k.toggleReview(); }
      else if (mod && key === 'b') { ev.preventDefault(); k.copySource(); }
      else if (mod && key === 'i') { ev.preventDefault(); k.askAi(true); }
      else if (mod && /^[1-4]$/.test(ev.key) && k.suggs[+ev.key - 1]) { ev.preventDefault(); k.applyTranslation(k.suggs[+ev.key - 1].t); }
      else if (ev.altKey && ev.key === 'ArrowDown') { ev.preventDefault(); k.move(1); }
      else if (ev.altKey && ev.key === 'ArrowUp') { ev.preventDefault(); k.move(-1); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /* ---------------- render ---------------- */
  const h = headerOf(doc.entries);
  const np = doc.nplurals;
  const lname = doc.lang ? langName(doc.lang) : 'translation';
  const pct = c.all ? Math.round(c.done / c.all * 100) : 0;
  const counts = { all: c.all, empty: c.empty, review: c.review, warn: c.warn, done: c.done };
  const editable = doc.entries.filter((x) => x.editable);
  const prevId = ok && cur.flags.includes('fuzzy') ? cur.prev.filter((l) => /^#\|\s*msgid /.test(l)).map((l) => parseQuoted(l.replace(/^#\|\s*msgid\s*/, ''))).join('') : '';
  const fmt = ok ? cur.flags.filter((f) => f !== 'fuzzy') : [];
  const last = headerGet(h, 'Last-Translator');
  const isNew = doc.mtime === null;
  const providerLabel = (AI_PROVIDERS.find((p) => p[0] === ai.provider) || [, 'the AI provider'])[1];
  document.title = (doc.dirty ? '• ' : '') + doc.name + ' · PO Messages Editor';

  return (
    <div id="editor">
      <header className="topbar">
        <div className="file-title">
          <div className="brand">po</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="name" title={doc.path}>{doc.name}</span>
              {doc.dirty
                ? <span className="pill" style={{ background: 'var(--orange-050)', color: 'var(--orange-ink)' }}>{isNew ? 'New file, not saved yet' : 'Unsaved changes'}</span>
                : <span className="pill" style={{ color: 'var(--soft)' }}>{doc.savedAt ? 'Saved ' + timeText(doc.savedAt).replace('Today ', '') : 'Saved'}</span>}
            </div>
            <div className="meta">{doc.path} · {doc.lang ? `${langName(doc.lang)} (${doc.lang})` : 'Language not set'} · {np} plural form{np === 1 ? '' : 's'}</div>
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={close} title="Back to the file list"><Icon name="open" />Files</button>
          <button type="button" className="btn" onClick={() => setDialog('pot')} title="Bring in new strings from a .pot template"><Icon name="update" />Update from .pot</button>
          <button type="button" className="btn" onClick={pretranslate} title="Fill empty strings with exact matches from the team memory"><Icon name="pretranslate" />Pre-translate</button>
          <button type="button" className="btn" onClick={validate} title="Show strings with warnings"><Icon name="validate" />Validate</button>
          <button type="button" className="btn" onClick={() => setDialog('props')} title="Language, plural rule and your name"><Icon name="props" />Properties</button>
          <button type="button" className="btn" onClick={() => setDialog('ai')} title="AI provider, model and API key"><Icon name="ai" />AI{canAi ? '' : ' (off)'}</button>
          <button type="button" className="btn" onClick={() => download(new Blob([serializePO(doc.entries)], { type: 'text/plain;charset=utf-8' }), doc.name)} title="Download a copy of the .po as it is now"><Icon name="download" />Download .po</button>
          <button type="button" className="btn" onClick={buildMo} disabled={!!busy} title="Compile the .mo file next to the .po on the server"><Icon name="build" />{busy === 'mo' ? 'Building…' : 'Build .mo'}</button>
          <button type="button" className="btn primary" onClick={save} disabled={!!busy} title="Save (Ctrl+S)"><Icon name="save" />{busy === 'save' ? 'Saving…' : 'Save'}</button>
        </div>
      </header>

      <div className="progress">
        <div className="nums">
          <strong style={{ fontSize: 13 }}>{pct}% translated</strong>
          <span style={{ color: 'var(--soft)' }}>{c.done} done</span>
          <span style={{ color: 'var(--orange-ink)' }}>{c.review} need review</span>
          <span style={{ color: 'var(--soft)' }}>{c.empty} untranslated</span>
          <span style={{ color: 'var(--red)' }}>{c.warn} with warnings</span>
        </div>
        <div className="bar" role="img" aria-label={`${pct}% translated, ${c.review} need review`}>
          <span style={{ width: `${c.all ? c.done / c.all * 100 : 0}%`, background: 'var(--blue)' }} />
          <span style={{ width: `${c.all ? c.review / c.all * 100 : 0}%`, background: 'var(--orange)' }} />
        </div>
      </div>

      <div className="body">
        <main className="main">
          <section className="card list-card" aria-label="Strings">
            <div className="list-tools">
              <div className="tabs" role="tablist" aria-label="Filter strings">
                {TABS.map(([k, l]) => (
                  <button type="button" key={k} className="tab" role="tab" aria-selected={filter === k} onClick={() => changeFilter(k)}>{l}<span className="n">{counts[k]}</span></button>
                ))}
              </div>
              <label className="search">
                <Icon name="search" />
                <span className="sr">Search strings</span>
                <input type="search" ref={qRef} value={qInput} onChange={(ev) => setQInput(ev.target.value)} placeholder="Search source or translation" title="Search (Ctrl+F)" />
              </label>
            </div>
            <div className="cols label"><span /><span>SOURCE TEXT</span><span>TRANSLATION · {doc.lang ? langName(doc.lang).toUpperCase() : 'NO LANGUAGE'}</span></div>
            <StringList entries={doc.entries} view={view} sel={sel} onSelect={(i) => select(i)} resetKey={filter}
              emptyText={query ? 'No strings match your search.' : 'Nothing here. Every string in this filter is done.'} />
          </section>

          <section className="card edit-card" aria-label="Translate the selected string">
            <div className="edit-head">
              <span className="label">SOURCE TEXT</span>
              <span className="hint">{ok ? `String ${editable.indexOf(cur) + 1} of ${editable.length}` : ''}</span>
            </div>
            <div className="src">{ok ? <Marked text={cur.id} /> : 'Pick a string from the list.'}</div>
            {ok && cur.idPlural !== null && (
              <div className="note">Plural: <span style={{ color: 'var(--ink)' }}><Marked text={cur.idPlural} /></span>
                {np === 1 && ` · ${langName(doc.lang)} uses one form for every count, so there is one box.`}</div>
            )}
            {ok && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {cur.strs.map((s, i) => {
                  const labels = cur.idPlural !== null ? pluralLabels(cur.strs.length) : ['Translation'];
                  return (
                    <div className="tr-box" key={sel + ':' + i}>
                      <label className="label" htmlFor={'tr' + i}>{labels[i].toUpperCase()} · {lname.toUpperCase()}</label>
                      <textarea id={'tr' + i} className="km" value={s} onChange={(ev) => editStr(i, ev.target.value)}
                        rows={Math.min(6, Math.max(2, Math.ceil((cur.id.length + 1) / 60)))} placeholder={`Type the ${lname} translation`} />
                    </div>
                  );
                })}
              </div>
            )}
            {ok && cur.warn.length > 0 && (
              <div className="warn" role="alert">
                <WarnIcon label="" />
                <ul>{cur.warn.map((w) => <li key={w}>{w}</li>)}</ul>
              </div>
            )}
            <div className="edit-actions">
              <button type="button" className="btn" id="btnReview" aria-pressed={ok && cur.flags.includes('fuzzy')} disabled={!ok} onClick={toggleReview} title="Needs review (Ctrl+U)">
                <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="#E08A3C" /></svg>Needs review</button>
              <button type="button" className="btn" disabled={!ok} onClick={copySource} title="Copy source text into the translation (Ctrl+B)">Copy source</button>
              <button type="button" className="btn" disabled={!ok} onClick={() => move(-1)} title="Previous (Alt+↑)">Previous</button>
              <button type="button" className="btn" disabled={!ok} onClick={() => move(1)} title="Next (Alt+↓)">Next</button>
              <span className="spacer" />
              <span className="hint">Ctrl + Enter: done, go to next unfinished</span>
              <button type="button" className="btn dark" disabled={!ok} onClick={doneAndNext}>Done and next</button>
            </div>
          </section>
        </main>

        <aside className="aside" aria-label="Help for this string">
          <section className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2>Suggestions</h2>
              <span className="hint">Team memory · Ctrl+1–4</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {suggs.length ? suggs.map((g, i) => (
                <button type="button" className="sugg" key={g.src + i} onClick={() => applyTranslation(g.t)} title={`Use this (Ctrl+${i + 1})`}>
                  <span className="top"><span className={'pill score' + (g.score === 100 ? ' full' : '')}>{g.score}%</span><span className="from">{g.from}</span><span className="use">Use</span></span>
                  <span className="t km">{g.t}</span>
                  <span className="s">for “{g.src}”</span>
                </button>
              )) : (
                <p style={{ margin: 0, color: 'var(--soft)', lineHeight: 1.4 }}>
                  {!ok ? '' : doc.lang ? 'No similar strings in the team memory yet. Finished translations are added as anyone on the team works.' : 'Set the language in Properties to get suggestions.'}
                </p>
              )}
            </div>
          </section>
          <section className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <h2>AI suggestion</h2>
              <span className="hint ws" title={canAi ? `${providerLabel} · ${ai.model}` : ''}>{canAi ? ai.model : 'Not set up'}</span>
            </div>
            {!canAi ? (
              <p style={{ margin: 0, color: 'var(--soft)', lineHeight: 1.4 }}>
                {ai.provider && ai.model ? 'Enter your API key to use AI suggestions. It is not saved, so you enter it again after a reload.' : 'Pick a provider and model, and enter your API key.'}
                {' '}<button type="button" className="btn" style={{ marginTop: 6 }} onClick={() => setDialog('ai')}>AI settings</button>
              </p>
            ) : (
              <>
                {aiRes && aiRes.e === cur && aiRes.status === 'done' && (aiRes.items.length ? aiRes.items.map((g, i) => {
                  const w = warningsOf({ ...cur, strs: cur.idPlural !== null ? g.forms : [g.forms[0]] });
                  return (
                    <button type="button" className="sugg" key={i} onClick={() => applyForms(g.forms)} title="Use this suggestion">
                      <span className="top"><span className="pill score">AI</span><span className="from">{w.length ? '' : (i === 0 ? 'Best match' : 'Alternative')}</span>
                        {w.length > 0 && <span className="from" style={{ color: 'var(--red)', display: 'flex', alignItems: 'center', gap: 4 }} title={w.join(' ')}><WarnIcon size={12} label="" />Check placeholders</span>}
                        <span className="use">Use</span></span>
                      {(cur.idPlural !== null ? g.forms : [g.forms[0]]).map((f, k) => <span className="t km" key={k}>{f}</span>)}
                      {g.note && <span className="s">{g.note}</span>}
                    </button>
                  );
                }) : <p style={{ margin: 0, color: 'var(--soft)' }}>The AI gave no suggestion for this string.</p>)}
                {aiRes && aiRes.e === cur && aiRes.status === 'error' && <p className="err" style={{ margin: 0, lineHeight: 1.4 }}>{aiRes.error}</p>}
                {aiRes && aiRes.e === cur && aiRes.status === 'done' && aiRes.items.length > 0 && (
                  <span className="hint">{aiRes.cached ? 'Ready in advance' : `Answered in ${(aiRes.ms / 1000).toFixed(1)}s`}</span>
                )}
                <button type="button" className="btn" disabled={!ok || aiLoading} onClick={() => askAi(aiRes?.e === cur && aiRes.status !== 'error')} style={{ justifyContent: 'center' }} title="Ask the AI (Ctrl+I)">
                  <Icon name="ai" />{aiLoading ? `Asking… ${Math.max(0, Math.floor((Date.now() - aiRes.started) / 1000))}s` : aiRes?.e === cur && aiRes.status === 'done' ? 'Ask again' : 'Suggest a translation'}
                </button>
                <span className="hint">Sent to {providerLabel}: this string, its notes and up to 8 team translations as examples.</span>
              </>
            )}
          </section>
          <section className="card">
            <h2>About this string</h2>
            {ok && cur.ctx !== null && <div className="kv"><span className="label">CONTEXT</span><span className="v">{cur.ctx}</span></div>}
            {ok && cur.extracted.length > 0 && <div className="kv"><span className="label">NOTE FROM THE DEVELOPER</span><span className="v">{cur.extracted.join('\n')}</span></div>}
            {prevId && <div className="kv"><span className="label">OLD SOURCE TEXT (BEFORE THE CHANGE)</span><span className="v" style={{ color: 'var(--soft)' }}>{prevId}</span></div>}
            {fmt.length > 0 && <div className="kv"><span className="label">FORMAT</span><span className="v">{fmt.join(', ')}</span></div>}
            {ok && cur.refs.length > 0 && (
              <div className="kv"><span className="label">USED IN</span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {cur.refs.slice(0, 12).map((r, i) => <span className="ref" key={r + i}>{r}</span>)}
                  {cur.refs.length > 12 && <span className="hint">and {cur.refs.length - 12} more</span>}
                </div>
              </div>
            )}
            <label className="kv"><span className="label">COMMENT FOR THE TEAM</span>
              <textarea rows={2} disabled={!ok} value={ok ? cur.comments.join('\n') : ''} onChange={(ev) => setComment(ev.target.value)} placeholder="e.g. Check this term with the Syariah team" /></label>
          </section>
        </aside>
      </div>

      <footer className="footer">
        <span>UTF-8 · Plural-Forms: {headerGet(h, 'Plural-Forms') || 'not set'}</span>
        {last && <span>Last translator: {last}</span>}
        <span>Showing {view.length} of {c.all} strings</span>
      </footer>

      {dialog === 'props' && (
        <PropsDialog name={store.get('poe.name', '')} lang={doc.lang} plural={headerGet(h, 'Plural-Forms') || langPlural(doc.lang)}
          onApply={applyProps} onClose={() => setDialog(null)} />
      )}
      {dialog === 'ai' && (
        <AiSettingsDialog ai={ai} lang={doc.lang} onClose={() => setDialog(null)}
          onApply={(next) => { setDialog(null); onAiChange(next); toast(aiReady(next) ? `AI suggestions on: ${next.model}.` : 'AI settings saved. Enter an API key to use them.'); }} />
      )}
      {dialog === 'pot' && <PotDialog onPick={updateFromPot} onClose={() => setDialog(null)} toast={toast} />}
    </div>
  );
}
