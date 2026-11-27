import { useCallback, useEffect, useRef, useState } from 'react';
import { parsePO } from '../shared/po.js';
import { api } from './lib/api.js';
import { makeDoc, tmItems } from './lib/doc.js';
import { store, DRAFT_KEY, AI_KEY, clearDraft } from './lib/util.js';
import StartScreen from './components/StartScreen.jsx';
import Editor from './components/Editor.jsx';
import { ConfirmDialog } from './components/Dialogs.jsx';

export default function App() {
  const [doc, setDoc] = useState(null);
  const [draft, setDraft] = useState(() => store.get(DRAFT_KEY, null));
  const [toastMsg, setToastMsg] = useState(null);   // { msg, action }
  const [ask, setAsk] = useState(null);             // { title, text, okLabel, resolve }
  // AI settings. Only provider, model, base URL and the auto option are saved;
  // the API key lives in this state and is gone when the tab closes.
  const [ai, setAi] = useState(() => ({ ...store.get(AI_KEY, {}), apiKey: '' }));
  const updateAi = useCallback((next) => {
    const { apiKey, ...rest } = next;
    store.set(AI_KEY, rest);
    setAi({ ...rest, apiKey });
  }, []);
  const toastTimer = useRef(0);
  const docRef = useRef(null);
  docRef.current = doc;

  const toast = useCallback((msg, action) => {
    setToastMsg({ msg, action });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), action ? 7000 : 3500);
  }, []);
  const confirm = useCallback((title, text, okLabel) => new Promise((resolve) => setAsk({ title, text, okLabel, resolve })), []);

  useEffect(() => {
    const onUnload = (ev) => { if (docRef.current?.dirty) { ev.preventDefault(); ev.returnValue = ''; } };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);
  useEffect(() => { if (!doc) document.title = 'PO Messages Editor'; }, [doc]);

  const open = useCallback((entries, meta) => {
    const d = makeDoc(entries, meta);
    api.tmAdd(d.lang, d.path, tmItems(d.entries)).catch(() => {});
    setDoc(d);
  }, []);

  return (
    <>
      {doc
        ? <Editor key={doc.id} doc={doc} toast={toast} confirm={confirm} ai={ai} onAiChange={updateAi}
            onClose={() => { setDoc(null); setDraft(store.get(DRAFT_KEY, null)); }} />
        : <StartScreen onOpen={open} toast={toast} confirm={confirm} draft={draft}
            onRestoreDraft={() => {
              open(parsePO(draft.text), { path: draft.path, name: draft.name, mtime: draft.mtime, dirty: true });
              toast('Draft restored. Save to write it to the file.');
            }}
            onDiscardDraft={() => { clearDraft(); setDraft(null); }} />}
      {ask && (
        <ConfirmDialog title={ask.title} text={ask.text} okLabel={ask.okLabel}
          onDone={(yes) => { ask.resolve(yes); setAsk(null); }} />
      )}
      {toastMsg && (
        <div id="toast" role="status">
          <span>{toastMsg.msg}</span>
          {toastMsg.action && <button type="button" onClick={() => { toastMsg.action.onClick(); setToastMsg(null); }}>{toastMsg.action.label}</button>}
        </div>
      )}
    </>
  );
}
