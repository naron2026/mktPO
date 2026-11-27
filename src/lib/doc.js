import { prepareEntries, headerOf, headerSet, statusOf } from '../../shared/po.js';
import { store } from './util.js';

// The open file. Entries are changed in place; the editor re-renders after.
export function makeDoc(entries, { path, name, mtime = null, dirty = false }) {
  const { lang, nplurals } = prepareEntries(entries);
  return {
    id: `${path}#${Date.now()}`,
    path, name: name || path.split('/').pop(),
    entries, dirty, lang, nplurals, mtime, savedAt: null
  };
}

export function stampHeader(doc) {
  const h = headerOf(doc.entries);
  const d = new Date(), z = -d.getTimezoneOffset(), pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}${z >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(z) / 60))}${pad(Math.abs(z) % 60)}`;
  headerSet(h, 'PO-Revision-Date', stamp);
  const me = store.get('poe.name', '');
  if (me) headerSet(h, 'Last-Translator', me);
  headerSet(h, 'X-Generator', 'PO Messages Editor');
}

// Finished single strings, as team memory items.
export const tmItems = (entries) => entries
  .filter((e) => e.editable && e.idPlural === null && statusOf(e) === 'done')
  .map((e) => ({ src: e.id, t: e.strs[0] }));
