import { useEffect, useRef, useState } from 'react';
import { LANGS, langName, langPlural, pluralCount, parsePO } from '../../shared/po.js';
import { api } from '../lib/api.js';
import { AI_PROVIDERS, AI_DEFAULT_MODELS } from '../lib/util.js';

// A native modal <dialog>, open while it is mounted. Esc calls onClose.
export function Modal({ onClose, children }) {
  const ref = useRef(null);
  useEffect(() => { const d = ref.current; if (!d.open) d.showModal(); }, []);
  return <dialog ref={ref} onCancel={(ev) => { ev.preventDefault(); onClose(); }}>{children}</dialog>;
}

export function ConfirmDialog({ title, text, okLabel, onDone }) {
  return (
    <Modal onClose={() => onDone(false)}>
      <form onSubmit={(ev) => { ev.preventDefault(); onDone(true); }}>
        <h2>{title}</h2>
        <p>{text}</p>
        <div className="row-btns">
          <button type="button" className="btn" onClick={() => onDone(false)}>Cancel</button>
          <button type="submit" className="btn primary" autoFocus>{okLabel || 'Continue'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function LangSelect({ value, onChange, id }) {
  const known = LANGS.some((l) => l[0] === value);
  return (
    <select className="field" id={id} value={value} onChange={(ev) => onChange(ev.target.value)}>
      {value && !known && <option value={value}>{value}</option>}
      {LANGS.map(([c, n, p]) => {
        const k = pluralCount(p);
        return <option key={c} value={c}>{n} ({c}) · {k} plural form{k === 1 ? '' : 's'}</option>;
      })}
    </select>
  );
}

export function PropsDialog({ name, lang, plural, onApply, onClose }) {
  const [n, setN] = useState(name);
  const [l, setL] = useState(lang || 'km');
  const [p, setP] = useState(plural || langPlural(lang));
  return (
    <Modal onClose={onClose}>
      <form onSubmit={(ev) => { ev.preventDefault(); onApply({ name: n.trim(), lang: l, plural: p.trim() }); }}>
        <h2>Properties</h2>
        <label><span className="label">YOUR NAME (SAVED AS LAST TRANSLATOR)</span>
          <input className="field" value={n} onChange={(ev) => setN(ev.target.value)} placeholder="Name <email>" /></label>
        <label><span className="label">LANGUAGE</span>
          <LangSelect value={l} onChange={(v) => { setL(v); setP(langPlural(v)); }} /></label>
        <label><span className="label">PLURAL RULE</span>
          <input className="field mono" value={p} onChange={(ev) => setP(ev.target.value)} style={{ fontSize: 12 }} /></label>
        <p>Changing the language fills in its usual plural rule. Change the rule only if you know the file needs another one.</p>
        <div className="row-btns">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary">Apply</button>
        </div>
      </form>
    </Modal>
  );
}

export function AiSettingsDialog({ ai, lang, onApply, onClose }) {
  const [provider, setProvider] = useState(ai.provider || 'anthropic');
  const [model, setModel] = useState(ai.model || (ai.provider ? '' : AI_DEFAULT_MODELS.anthropic[0]));
  const [baseURL, setBaseURL] = useState(ai.baseURL || '');
  const [apiKey, setApiKey] = useState(ai.apiKey || '');
  const [auto, setAuto] = useState(!!ai.auto);
  const [models, setModels] = useState(null);
  const [status, setStatus] = useState(null);   // { text, error }
  const [busy, setBusy] = useState(false);
  const compatible = provider === 'compatible';
  const options = models || AI_DEFAULT_MODELS[provider] || [];

  function changeProvider(p) {
    setProvider(p); setModels(null); setStatus(null);
    setModel(AI_DEFAULT_MODELS[p]?.[0] || '');
  }
  async function loadModels() {
    setBusy(true); setStatus({ text: 'Checking the key and loading models…' });
    try {
      const r = await api.aiModels({ provider, apiKey: apiKey.trim(), baseURL: baseURL.trim() });
      const list = r.models.slice().sort();
      setModels(list);
      setStatus({ text: `Key works. ${list.length} model${list.length === 1 ? '' : 's'} available.` });
      if (!model && list.length) setModel(list[0]);
    } catch (e) { setStatus({ text: e.message, error: true }); }
    finally { setBusy(false); }
  }
  // A real (small, paid) request with these settings: translate one short string.
  async function test() {
    const target = lang || 'km';
    const m = model.trim();
    setBusy(true); setStatus({ text: `Asking ${m} to translate "Save changes" into ${langName(target)}…` });
    const t0 = performance.now();
    try {
      const r = await api.aiSuggest({
        provider, model: m, apiKey: apiKey.trim(), baseURL: baseURL.trim(),
        lang: target, langName: langName(target), nforms: 1, entry: { id: 'Save changes' }, examples: [], fresh: true
      });
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      if (!r.suggestions.length) setStatus({ text: `${m} answered in ${secs}s but gave no translation. Try another model.`, error: true });
      else setStatus({ text: `Works. ${m} answered in ${secs}s: "Save changes" → "${r.suggestions[0].forms[0]}"` });
    } catch (e) { setStatus({ text: 'Test failed: ' + e.message, error: true }); }
    finally { setBusy(false); }
  }
  const canTest = !!model.trim() && (apiKey.trim() || (compatible && baseURL.trim()));
  return (
    <Modal onClose={onClose}>
      <form autoComplete="off" onSubmit={(ev) => { ev.preventDefault(); onApply({ provider, model: model.trim(), baseURL: baseURL.trim(), apiKey: apiKey.trim(), auto }); }}>
        <h2>AI suggestions</h2>
        <label><span className="label">PROVIDER</span>
          <select className="field" value={provider} onChange={(ev) => changeProvider(ev.target.value)}>
            {AI_PROVIDERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></label>
        {compatible && (
          <label><span className="label">SERVER ADDRESS (BASE URL)</span>
            <input className="field mono" value={baseURL} onChange={(ev) => setBaseURL(ev.target.value)} placeholder="http://localhost:11434/v1" style={{ fontSize: 12 }} /></label>
        )}
        <label><span className="label">API KEY{compatible ? ' (IF THE SERVER NEEDS ONE)' : ''}</span>
          <input className="field mono" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(ev) => setApiKey(ev.target.value)} style={{ fontSize: 12 }} /></label>
        <p>The key is kept only in this tab's memory and sent to the editor's server with each AI request, which passes it to the provider. It is never saved. Reloading the page clears it.</p>
        <label><span className="label">MODEL</span>
          <span style={{ display: 'flex', gap: 6 }}>
            <input className="field mono" list="ai-models" value={model} onChange={(ev) => setModel(ev.target.value)} placeholder="Model ID" style={{ fontSize: 12, flex: 1, minWidth: 0 }} />
            <button type="button" className="btn" onClick={loadModels} disabled={busy || (!apiKey && !compatible)}>Load models</button>
            <button type="button" className="btn" onClick={test} disabled={busy || !canTest} title="Send one short test translation with these settings">Test AI</button>
          </span>
          <datalist id="ai-models">{options.map((m) => <option key={m} value={m} />)}</datalist></label>
        {status && <p className={status.error ? 'err' : ''} role="status" style={status.error ? null : { color: 'var(--ink)' }}>{status.text}</p>}
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={auto} onChange={(ev) => setAuto(ev.target.checked)} />
          <span>Ask the AI automatically when I open a string (each one is a paid request)</span></label>
        <div className="row-btns">
          {ai.apiKey && <button type="button" className="btn" onClick={() => onApply({ provider, model: model.trim(), baseURL: baseURL.trim(), apiKey: '', auto })}>Forget key</button>}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!model.trim()}>Apply</button>
        </div>
      </form>
    </Modal>
  );
}

// Where a new language file made from a template goes by default.
const defaultPath = (potPath, lang) => potPath.replace(/[^/]*$/, '') + lang + '.po';

export function NewLangDialog({ pot, existing, onCreate, onClose }) {
  const [lang, setLang] = useState('km');
  const [path, setPath] = useState(defaultPath(pot.path, 'km'));
  const [edited, setEdited] = useState(false);
  const p = path.trim();
  const valid = /\.po$/i.test(p) && !p.startsWith('/') && !p.split('/').includes('..');
  const exists = existing.some((f) => f.path === p);
  return (
    <Modal onClose={onClose}>
      <form onSubmit={(ev) => { ev.preventDefault(); if (valid) onCreate(lang, p); }}>
        <h2>New language from {pot.path}</h2>
        <p>The template's {pot.count} strings are copied into a new file. The plural rule is filled in for you.</p>
        <label><span className="label">LANGUAGE</span>
          <LangSelect value={lang} onChange={(v) => { setLang(v); if (!edited) setPath(defaultPath(pot.path, v)); }} /></label>
        <label><span className="label">FILE IN THE WORKSPACE</span>
          <input className="field mono" value={path} onChange={(ev) => { setPath(ev.target.value); setEdited(true); }} style={{ fontSize: 12 }} /></label>
        {!valid && <p className="err">Use a relative path that ends in .po.</p>}
        {valid && exists && <p className="err">{p} already exists. Saving will ask before replacing it.</p>}
        <div className="row-btns">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!valid}>Create {langName(lang)} file</button>
        </div>
      </form>
    </Modal>
  );
}

// Pick the template for "Update from .pot": one in the workspace, or a file
// from this computer.
export function PotDialog({ onPick, onClose, toast }) {
  const [pots, setPots] = useState(null);
  const input = useRef(null);
  useEffect(() => {
    api.files().then((r) => setPots(r.files.filter((f) => f.kind === 'pot'))).catch((e) => { setPots([]); toast('Could not list templates: ' + e.message); });
  }, [toast]);
  async function fromWorkspace(path) {
    try { const r = await api.read(path); onPick(parsePO(r.text), r.path); } catch (e) { toast('Could not open ' + path + ': ' + e.message); }
  }
  async function fromComputer(ev) {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (f) onPick(parsePO(await f.text()), f.name);
  }
  return (
    <Modal onClose={onClose}>
      <form onSubmit={(ev) => ev.preventDefault()}>
        <h2>Update from a .pot template</h2>
        <p>New strings are added, removed ones are kept as old entries, and changed ones are marked for review.</p>
        {pots === null ? <p>Looking for templates…</p> : pots.length ? (
          <div className="pot-pick">
            {pots.map((f) => (
              <button type="button" key={f.path} onClick={() => fromWorkspace(f.path)}>
                <strong>{f.path}</strong> <span className="hint">· {f.all} strings</span>
              </button>
            ))}
          </div>
        ) : <p>No .pot files in the workspace.</p>}
        <input type="file" ref={input} accept=".pot,.po" hidden onChange={fromComputer} />
        <div className="row-btns">
          <button type="button" className="btn" onClick={() => input.current.click()}>Choose from this computer…</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
