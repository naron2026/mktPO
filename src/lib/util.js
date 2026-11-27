import { serializePO } from '../../shared/po.js';

export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
};

export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export function timeText(ts) {
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return 'Today ' + hm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday ' + hm;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* Drafts: unsaved work survives a closed tab */
export const DRAFT_KEY = 'poe.draft.v2';
export function saveDraftNow(doc, toast) {
  if (!doc || !doc.dirty) return;
  const ok = store.set(DRAFT_KEY, { path: doc.path, name: doc.name, lang: doc.lang, mtime: doc.mtime, at: Date.now(), text: serializePO(doc.entries) });
  if (!ok && toast) toast('This file is too big to keep a draft in the browser. Save often.');
}
export const clearDraft = () => store.del(DRAFT_KEY);

/* AI settings: provider, model and options are remembered; the API key is
   kept only in memory (see App.jsx) and never written anywhere. */
export const AI_KEY = 'poe.ai.v1';
export const AI_PROVIDERS = [
  ['anthropic', 'Anthropic (Claude)'],
  ['openai', 'OpenAI'],
  ['gemini', 'Google Gemini'],
  ['compatible', 'OpenAI-compatible (Ollama, OpenRouter, …)']
];
export const AI_DEFAULT_MODELS = { anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] };
export const aiReady = (ai) => !!(ai.provider && ai.model && (ai.apiKey || (ai.provider === 'compatible' && ai.baseURL)));
