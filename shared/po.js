// Gettext .po handling shared by the server and the browser: parsing,
// writing, checks, .pot merging and .mo compiling. No DOM or Node APIs.

/* ======================================================================
   Languages and plural rules
   ====================================================================== */
export const ONE = 'nplurals=1; plural=0;';
export const TWO = 'nplurals=2; plural=(n != 1);';
export const LANGS = [
  ['km', 'Khmer', ONE], ['ms', 'Malay', ONE], ['en', 'English', TWO], ['id', 'Indonesian', ONE],
  ['th', 'Thai', ONE], ['vi', 'Vietnamese', ONE], ['lo', 'Lao', ONE], ['my', 'Burmese', ONE],
  ['zh_CN', 'Chinese (Simplified)', ONE], ['zh_TW', 'Chinese (Traditional)', ONE], ['ja', 'Japanese', ONE], ['ko', 'Korean', ONE],
  ['fr', 'French', 'nplurals=2; plural=(n > 1);'], ['de', 'German', TWO], ['es', 'Spanish', TWO], ['pt', 'Portuguese', TWO],
  ['ar', 'Arabic', 'nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);']
];
const findLang = (code) => LANGS.find((x) => x[0] === code || x[0] === (code || '').split(/[_-]/)[0]);
export const langName = (code) => { const l = findLang(code); return l ? l[1] : (code || 'Unknown language'); };
export const langPlural = (code) => { const l = findLang(code); return l ? l[2] : TWO; };
export const pluralCount = (rule) => +((rule || '').match(/nplurals\s*=\s*(\d+)/) || [0, 2])[1];

/* ======================================================================
   PO parsing and writing
   Unchanged entries are written back exactly as they were read, so a save
   only changes the strings you touched (small, readable git diffs).
   ====================================================================== */
const UNESC = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' };
const unescapePO = (s) => s.replace(/\\(.)/g, (m, c) => (c in UNESC ? UNESC[c] : c));
export const escapePO = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
export function parseQuoted(s) {
  s = s.trim();
  if (s[0] !== '"') return '';
  return unescapePO(s.slice(1, s.lastIndexOf('"')));
}
export function newEntry() {
  return { ctx: null, id: null, idPlural: null, strs: [], comments: [], extracted: [], refs: [], refsRaw: [], flags: [], prev: [], obsolete: false, raw: [], dirty: false, warn: [] };
}
export function parsePO(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const out = [];
  let e = null, field = null;
  const flush = () => { if (e && (e.id !== null || e.raw.length)) out.push(e); e = null; field = null; };
  for (const line of lines) {
    if (line.trim() === '') { flush(); continue; }
    if (line.startsWith('#~')) {
      if (e && !e.obsolete && e.id !== null) flush();
      if (!e) e = newEntry();
      e.obsolete = true; e.raw.push(line);
      continue;
    }
    if (line[0] === '#') {
      if (e && (e.id !== null || e.obsolete)) flush();
      if (!e) e = newEntry();
      e.raw.push(line);
      const k = line[1];
      if (k === ',') e.flags.push(...line.slice(2).split(',').map((s) => s.trim()).filter(Boolean));
      else if (k === '.') e.extracted.push(line.slice(2).replace(/^ /, ''));
      else if (k === ':') { e.refsRaw.push(line); e.refs.push(...line.slice(2).trim().split(/\s+/).filter(Boolean)); }
      else if (k === '|') e.prev.push(line);
      else e.comments.push(line.slice(1).replace(/^ /, ''));
      continue;
    }
    const m = line.match(/^(msgctxt|msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s+(".*")\s*$/);
    if (m) {
      const key = m[1];
      if (e && (e.obsolete || ((key === 'msgctxt' || key === 'msgid') && e.id !== null))) flush();
      if (!e) e = newEntry();
      e.raw.push(line);
      const val = parseQuoted(m[3]);
      if (key === 'msgctxt') { e.ctx = val; field = ['ctx']; }
      else if (key === 'msgid') { e.id = val; field = ['id']; }
      else if (key === 'msgid_plural') { e.idPlural = val; field = ['idPlural']; }
      else { const i = m[2] !== undefined ? +m[2] : 0; e.strs[i] = val; field = ['strs', i]; }
      continue;
    }
    if (line.trim()[0] === '"' && e && field) {
      e.raw.push(line);
      const v = parseQuoted(line);
      if (field[0] === 'strs') e.strs[field[1]] += v; else e[field[0]] += v;
      continue;
    }
    if (!e) e = newEntry();
    e.raw.push(line);   // unknown line: keep it as it is
  }
  flush();
  for (const x of out) {
    for (let i = 0; i < x.strs.length; i++) if (x.strs[i] === undefined) x.strs[i] = '';
    if (x.id !== null && !x.strs.length) x.strs = [''];
    x.isHeader = x.id === '' && x.ctx === null && !x.obsolete;
    x.editable = !x.obsolete && x.id !== null && !x.isHeader;
  }
  return out;
}
function wrapText(t, w) {
  if (t.length <= w) return [t];
  const res = [];
  let cur = '';
  for (const tok of t.split(/(?<= )/)) {
    if (cur && (cur + tok).length > w) { res.push(cur); cur = tok; } else cur += tok;
  }
  if (cur) res.push(cur);
  return res;
}
function fmtStr(key, s) {
  const e = escapePO(s);
  const inner = s.indexOf('\n');
  if ((inner === -1 || inner === s.length - 1) && key.length + e.length + 3 <= 80) return [`${key} "${e}"`];
  const out = [`${key} ""`];
  for (const part of s.split(/(?<=\n)/)) for (const c of wrapText(escapePO(part), 76)) out.push(`"${c}"`);
  return out;
}
export function entryLines(e) {
  const L = [];
  e.comments.forEach((c) => L.push(c ? '# ' + c : '#'));
  e.extracted.forEach((c) => L.push('#. ' + c));
  e.refsRaw.forEach((r) => L.push(r));
  if (e.flags.length) L.push('#, ' + e.flags.join(', '));
  if (e.flags.includes('fuzzy')) e.prev.forEach((p) => L.push(p));
  if (e.ctx !== null) L.push(...fmtStr('msgctxt', e.ctx));
  L.push(...fmtStr('msgid', e.id));
  if (e.idPlural !== null) {
    L.push(...fmtStr('msgid_plural', e.idPlural));
    e.strs.forEach((s, i) => L.push(...fmtStr(`msgstr[${i}]`, s)));
  } else L.push(...fmtStr('msgstr', e.strs[0] || ''));
  return L;
}
const serializeEntry = (e) => (e.dirty && !e.obsolete ? entryLines(e) : e.raw).join('\n');
export const serializePO = (entries) => entries.map(serializeEntry).join('\n\n') + '\n';

/* Header (the entry with an empty msgid) */
export const headerOf = (entries) => entries.find((e) => e.isHeader);
export function headerGet(h, key) {
  if (!h) return '';
  const m = (h.strs[0] || '').match(new RegExp('^' + key + ':[ \\t]*(.*)$', 'mi'));
  return m ? m[1].trim() : '';
}
export function headerSet(h, key, val) {
  let s = h.strs[0] || '';
  const re = new RegExp('^' + key + ':.*$', 'mi');
  if (re.test(s)) s = s.replace(re, `${key}: ${val}`);
  else s += (s && !s.endsWith('\n') ? '\n' : '') + `${key}: ${val}\n`;
  if (s !== h.strs[0]) { h.strs[0] = s; h.dirty = true; }
}
export function makeHeader() {
  const h = newEntry();
  h.id = ''; h.strs = ['Content-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: 8bit\n'];
  h.isHeader = true; h.editable = false; h.dirty = true;
  return h;
}
export const npluralsOf = (h) => { const m = headerGet(h, 'Plural-Forms').match(/nplurals\s*=\s*(\d+)/); return m ? Math.max(1, +m[1]) : 2; };

// Make sure there is a header, give plural strings one slot per plural form
// and work out the warnings. Returns the file's language and plural count.
export function prepareEntries(entries) {
  let h = headerOf(entries);
  if (!h) { h = makeHeader(); entries.unshift(h); }
  const lang = headerGet(h, 'Language') || '';
  const nplurals = npluralsOf(h);
  for (const e of entries) {
    if (!e.editable) continue;
    if (e.idPlural !== null) while (e.strs.length < nplurals) e.strs.push('');
    e.warn = warningsOf(e);
  }
  return { lang, nplurals };
}

/* ======================================================================
   Checks
   ====================================================================== */
export const PH_RE = /%\([\w.]+\)[-#0 +]*\d*(?:\.\d+)?[a-zA-Z]|%[-#0 +]*\d*(?:\.\d+)?[sdifuxXeEgGcr]|\{[\w.]*(?::[^{}]*)?\}/g;
const isPositional = (p) => /^%[^(]/.test(p);
export const placeholders = (s) => (s.replace(/%%/g, '').match(PH_RE) || []);
export function warningsOf(e) {
  if (!e.editable) return [];
  const w = [];
  const src = placeholders(e.id);
  const named = new Set(src.concat(e.idPlural !== null ? placeholders(e.idPlural) : []).filter((p) => !isPositional(p)));
  const pos = src.filter(isPositional).length;
  e.strs.forEach((t, i) => {
    if (!t) return;
    const tp = placeholders(t);
    const form = e.strs.length > 1 ? ` (form ${i + 1})` : '';
    const mustAll = e.idPlural === null || i === e.strs.length - 1;
    const missing = mustAll ? [...named].filter((p) => !tp.includes(p)) : [];
    if (missing.length) w.push(`Missing placeholder ${missing.join(', ')}${form}. The app shows a raw code or fails if it is left out.`);
    const extra = [...new Set(tp.filter((p) => !isPositional(p) && !named.has(p)))];
    if (extra.length) w.push(`Placeholder ${extra.join(', ')} is not in the source text${form}.`);
    const tpos = tp.filter(isPositional).length;
    if (e.idPlural === null && tpos !== pos) w.push(`The source has ${pos} %-placeholder${pos === 1 ? '' : 's'} (like %s), the translation has ${tpos}.`);
    if (e.id.endsWith('\n') !== t.endsWith('\n')) w.push(`Line break at the end does not match the source${form}.`);
  });
  return w;
}
export function statusOf(e) {
  if (!e.strs.every((s) => s)) return 'empty';
  return e.flags.includes('fuzzy') ? 'review' : 'done';
}
export function countsOf(entries) {
  const c = { all: 0, done: 0, review: 0, empty: 0, warn: 0 };
  for (const e of entries) {
    if (!e.editable) continue;
    c.all++; c[statusOf(e)]++;
    if (e.warn.length) c.warn++;
  }
  return c;
}

/* ======================================================================
   Similarity (for team memory suggestions and .pot merging)
   ====================================================================== */
const gramCache = new Map();
function grams(s) {
  let g = gramCache.get(s);
  if (g) return g;
  const t = ' ' + s.toLowerCase().replace(/\s+/g, ' ') + ' ';
  g = new Set();
  for (let i = 0; i < t.length - 1; i++) g.add(t.substr(i, 2));
  if (gramCache.size > 50000) gramCache.clear();
  gramCache.set(s, g);
  return g;
}
export function similarity(a, b) {
  if (a === b) return 100;
  const A = grams(a), B = grams(b);
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return Math.min(99, Math.round((2 * n / (A.size + B.size)) * 100));
}

/* ======================================================================
   Compile .mo (GNU gettext binary, little endian, no hash table)
   Fuzzy and unfinished strings are left out, as msgfmt does.
   ====================================================================== */
export function compileMO(entries) {
  const enc = new TextEncoder();
  const items = [];
  for (const e of entries) {
    if (e.obsolete || e.id === null) continue;
    if (!e.isHeader && e.flags.includes('fuzzy')) continue;
    if (!e.strs.length || e.strs.some((s) => !s)) continue;
    let k = (e.ctx !== null ? e.ctx + '\x04' : '') + e.id;
    if (e.idPlural !== null) k += '\0' + e.idPlural;
    let v = e.idPlural !== null ? e.strs.join('\0') : e.strs[0];
    if (e.isHeader) v = v.replace(/charset=utf-8/i, 'charset=UTF-8').replace(/^POT-Creation-Date:.*\n/m, '');   // as msgfmt writes it
    items.push([enc.encode(k), enc.encode(v)]);
  }
  items.sort((a, b) => {
    const n = Math.min(a[0].length, b[0].length);
    for (let i = 0; i < n; i++) if (a[0][i] !== b[0][i]) return a[0][i] - b[0][i];
    return a[0].length - b[0].length;
  });
  const N = items.length, O = 28, T = O + N * 8, H = T + N * 8;
  let size = H;
  items.forEach(([k, v]) => { size += k.length + 1 + v.length + 1; });
  const buf = new ArrayBuffer(size), dv = new DataView(buf), u8 = new Uint8Array(buf);
  [0x950412de, 0, N, O, T, 0, H].forEach((x, i) => dv.setUint32(i * 4, x, true));
  let off = H;
  items.forEach(([k], i) => { dv.setUint32(O + i * 8, k.length, true); dv.setUint32(O + i * 8 + 4, off, true); u8.set(k, off); off += k.length + 1; });
  items.forEach(([, v], i) => { dv.setUint32(T + i * 8, v.length, true); dv.setUint32(T + i * 8 + 4, off, true); u8.set(v, off); off += v.length + 1; });
  const strings = items.length - (entries.some((e) => e.isHeader && e.strs[0]) ? 1 : 0);
  return { bytes: u8, strings };
}

/* ======================================================================
   Merge a new .pot into an open file
   ====================================================================== */
export function mergePot(oldEntries, potEntries, nplurals) {
  const key = (e) => (e.ctx === null ? '' : e.ctx) + '\x04' + e.id;
  const live = oldEntries.filter((e) => e.editable);
  const byKey = new Map(live.map((e) => [key(e), e]));
  const used = new Set();
  const result = [];
  let added = 0, changed = 0;
  for (const p of potEntries) {
    if (!p.editable) continue;
    const o = byKey.get(key(p));
    const ne = newEntry();
    Object.assign(ne, { ctx: p.ctx, id: p.id, idPlural: p.idPlural, extracted: p.extracted.slice(), refs: p.refs.slice(), refsRaw: p.refsRaw.slice(), flags: p.flags.filter((f) => f !== 'fuzzy'), dirty: true, editable: true, isHeader: false });
    const forms = p.idPlural !== null ? nplurals : 1;
    ne.strs = Array(forms).fill('');
    if (o) {
      used.add(o);
      ne.comments = o.comments.slice();
      o.strs.slice(0, forms).forEach((s, i) => { ne.strs[i] = s; });
      if (o.flags.includes('fuzzy')) { ne.flags.push('fuzzy'); ne.prev = o.prev.slice(); }
    } else {
      let best = null, bestScore = 0;
      for (const c of live) {
        if (used.has(c) || statusOf(c) === 'empty' || (c.idPlural === null) !== (p.idPlural === null)) continue;
        const sc = similarity(p.id, c.id);
        if (sc > bestScore) { best = c; bestScore = sc; }
      }
      if (best && bestScore >= 80) {
        used.add(best);
        ne.comments = best.comments.slice();
        best.strs.slice(0, forms).forEach((s, i) => { ne.strs[i] = s; });
        ne.flags.push('fuzzy');
        ne.prev = (best.ctx !== null ? [`#| msgctxt "${escapePO(best.ctx)}"`] : []).concat([`#| msgid "${escapePO(best.id)}"`]);
        changed++;
      } else added++;
    }
    ne.warn = warningsOf(ne);
    result.push(ne);
  }
  // Strings no longer in the template are kept at the end as old (#~) entries.
  const gone = live.filter((e) => !used.has(e) && statusOf(e) !== 'empty').map((e) => {
    const lines = entryLines(Object.assign({}, e, { extracted: [], refsRaw: [], prev: [] }));
    const o = newEntry();
    o.obsolete = true;
    o.raw = lines.map((l) => (l.startsWith('# ') || l === '#' || l.startsWith('#,') ? l : '#~ ' + l));
    return o;
  });
  const header = headerOf(oldEntries) || makeHeader();
  const keepOld = oldEntries.filter((e) => e.obsolete);
  return { entries: [header].concat(result, gone, keepOld), added, changed, removed: gone.length };
}

/* Start a new language file from a parsed .pot (changes the entries in place). */
export function startFromPot(entries, lang) {
  let h = headerOf(entries);
  if (!h) { h = makeHeader(); entries.unshift(h); }
  h.flags = h.flags.filter((f) => f !== 'fuzzy');
  headerSet(h, 'Language', lang);
  headerSet(h, 'Plural-Forms', langPlural(lang));
  headerSet(h, 'Content-Type', 'text/plain; charset=UTF-8');
  h.dirty = true;
  const np = npluralsOf(h);
  entries.forEach((e) => { if (e.editable) { e.strs = Array(e.idPlural !== null ? np : 1).fill(''); e.flags = e.flags.filter((f) => f !== 'fuzzy'); e.dirty = true; } });
  return entries;
}
