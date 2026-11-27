// PO Messages Editor server: reads and writes .po/.pot files in a workspace
// folder, compiles .mo files and keeps the team memory shared by everyone.
import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePO, prepareEntries, countsOf, compileMO, similarity } from '../shared/po.js';
import { aiSuggest, aiModels } from './ai.js';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD = process.argv.includes('--prod') || process.env.NODE_ENV === 'production';
const PORT = +process.env.PORT || 5173;
const HOST = process.env.HOST || '127.0.0.1';
const WORKSPACE = path.resolve(process.env.PO_WORKSPACE || path.join(APP_DIR, 'workspace'));
const DATA_DIR = path.resolve(process.env.PO_DATA || path.join(APP_DIR, 'data'));
await fs.mkdir(WORKSPACE, { recursive: true });
await fs.mkdir(DATA_DIR, { recursive: true });

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

/* ======================================================================
   Files in the workspace
   ====================================================================== */
const isPo = (name) => /\.pot?$/i.test(name);
const relOf = (abs) => path.relative(WORKSPACE, abs).split(path.sep).join('/');
function resolvePath(rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw new HttpError(400, 'A file path is needed.');
  const abs = path.resolve(WORKSPACE, rel);
  if (!abs.startsWith(WORKSPACE + path.sep)) throw new HttpError(400, 'That path is outside the workspace.');
  return abs;
}
async function writeAtomic(abs, data) {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, abs);
}
async function walk(dir, depth, out) {
  if (depth > 8) return out;
  let items;
  try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of items) {
    if (d.name.startsWith('.') || d.name === 'node_modules') continue;
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) await walk(abs, depth + 1, out);
    else if (d.isFile() && isPo(d.name)) out.push(abs);
  }
  return out;
}

// Progress per file, worked out again only when the file changes.
const infoCache = new Map();
async function describe(abs) {
  const st = await fs.stat(abs);
  const hit = infoCache.get(abs);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.info;
  const entries = parsePO(await fs.readFile(abs, 'utf8'));
  const { lang, nplurals } = prepareEntries(entries);
  const info = { path: relOf(abs), name: path.basename(abs), kind: /\.pot$/i.test(abs) ? 'pot' : 'po', lang, nplurals, ...countsOf(entries), mtime: st.mtimeMs, size: st.size };
  infoCache.set(abs, { mtime: st.mtimeMs, size: st.size, info });
  return info;
}

/* ======================================================================
   Team memory: lang -> Map(source text -> { t, f })
   Newest entries are last; the oldest are dropped past TM_MAX per language.
   ====================================================================== */
const TM_FILE = path.join(DATA_DIR, 'tm.json');
const TM_MAX = 50000;
const TM = new Map();
try {
  const raw = JSON.parse(await fs.readFile(TM_FILE, 'utf8'));
  for (const [lang, items] of Object.entries(raw)) TM.set(lang, new Map(Object.entries(items)));
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('Team memory could not be read, starting empty:', e.message);
}
let tmTimer = null;
function saveTM() {
  clearTimeout(tmTimer);
  tmTimer = setTimeout(() => {
    const out = {};
    for (const [lang, m] of TM) out[lang] = Object.fromEntries(m);
    writeAtomic(TM_FILE, JSON.stringify(out)).catch((e) => console.error('Could not save the team memory:', e.message));
  }, 1000);
}
function tmAdd(lang, file, items) {
  if (!lang || !Array.isArray(items)) return 0;
  if (!TM.has(lang)) TM.set(lang, new Map());
  const m = TM.get(lang);
  let n = 0;
  for (const it of items) {
    if (!it || typeof it.src !== 'string' || typeof it.t !== 'string' || !it.src || !it.t) continue;
    const old = m.get(it.src);
    if (old && old.t === it.t) continue;
    m.delete(it.src);
    m.set(it.src, { t: it.t, f: String(file || '') });
    n++;
  }
  for (const k of m.keys()) { if (m.size <= TM_MAX) break; m.delete(k); }
  if (n) saveTM();
  return n;
}
function tmSuggest(lang, src, limit) {
  const m = TM.get(lang);
  if (!m || !src) return [];
  const len = src.length;
  const out = [];
  for (const [s, v] of m) {
    if (Math.abs(s.length - len) > Math.max(6, len * 0.6)) continue;
    const score = similarity(src, s);
    if (score >= 60) out.push({ src: s, t: v.t, from: v.f, score });
  }
  out.sort((a, b) => b.score - a.score);
  const seen = new Set();
  return out.filter((x) => (seen.has(x.t) ? false : seen.add(x.t))).slice(0, limit);
}

/* ======================================================================
   API
   ====================================================================== */
const app = express();
app.use(express.json({ limit: '50mb' }));

app.get('/api/config', (req, res) => res.json({ workspace: WORKSPACE }));

app.get('/api/files', async (req, res) => {
  const files = await walk(WORKSPACE, 0, []);
  const out = [];
  for (const abs of files) {
    try { out.push(await describe(abs)); } catch (e) { out.push({ path: relOf(abs), name: path.basename(abs), error: e.message }); }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  res.json({ files: out });
});

app.get('/api/file', async (req, res) => {
  const abs = resolvePath(req.query.path);
  const [text, st] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
  res.json({ path: relOf(abs), name: path.basename(abs), text, mtime: st.mtimeMs });
});

// Save a file. baseMtime is the file's time when it was opened (null for a
// new file); if the file on disk differs, answer 409 unless force is set.
app.put('/api/file', async (req, res) => {
  const { path: rel, text, baseMtime = null, force = false } = req.body || {};
  if (typeof text !== 'string') throw new HttpError(400, 'The file text is missing.');
  if (!isPo(String(rel))) throw new HttpError(400, 'Only .po and .pot files can be saved.');
  const abs = resolvePath(rel);
  const st = await fs.stat(abs).catch(() => null);
  if (st && !force) {
    if (baseMtime === null) throw new HttpError(409, 'A file with that name already exists.', { reason: 'exists', mtime: st.mtimeMs });
    if (st.mtimeMs !== baseMtime) throw new HttpError(409, 'The file was changed by someone else since you opened it.', { reason: 'changed', mtime: st.mtimeMs });
  }
  await writeAtomic(abs, text);
  const ns = await fs.stat(abs);
  res.json({ path: relOf(abs), mtime: ns.mtimeMs });
});

async function moOf(rel) {
  const abs = resolvePath(rel);
  if (!/\.po$/i.test(abs)) throw new HttpError(400, 'Only .po files can be compiled.');
  const { bytes, strings } = compileMO(parsePO(await fs.readFile(abs, 'utf8')));
  return { abs, bytes, strings, moAbs: abs.replace(/\.po$/i, '.mo') };
}
app.get('/api/mo', async (req, res) => {
  const { bytes, moAbs } = await moOf(req.query.path);
  res.attachment(path.basename(moAbs)).type('application/octet-stream').send(Buffer.from(bytes));
});
app.post('/api/mo', async (req, res) => {
  const { bytes, strings, moAbs } = await moOf((req.body || {}).path);
  await writeAtomic(moAbs, bytes);
  res.json({ path: relOf(moAbs), strings });
});

app.get('/api/tm/stats', (req, res) => {
  res.json({ langs: [...TM].map(([lang, m]) => ({ lang, count: m.size })).filter((x) => x.count).sort((a, b) => b.count - a.count) });
});
app.post('/api/tm/suggest', (req, res) => {
  const { lang, src, limit = 4 } = req.body || {};
  res.json({ suggestions: tmSuggest(lang, src, Math.min(10, +limit || 4)) });
});
// Exact matches for many source texts at once (pre-translate).
app.post('/api/tm/lookup', (req, res) => {
  const { lang, srcs } = req.body || {};
  const m = TM.get(lang);
  res.json({ ts: Array.isArray(srcs) ? srcs.map((s) => (m && m.get(s)?.t) || null) : [] });
});
app.post('/api/tm/add', (req, res) => {
  const { lang, file, items } = req.body || {};
  res.json({ added: tmAdd(lang, file, items) });
});

// AI suggestions. The API key in the body is used for this call only: it is
// not stored, and AI errors are answered without logging the request.
app.post('/api/ai/suggest', async (req, res) => res.json(await aiSuggest(req.body, { examplesFor: (lang, src) => tmSuggest(lang, src, 8) })));
app.post('/api/ai/models', async (req, res) => res.json(await aiModels(req.body)));

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route.' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || (err.code === 'ENOENT' ? 404 : 500);
  const message = err.code === 'ENOENT' ? 'File not found.' : err.message;
  if (status >= 500 && !req.path.startsWith('/api/ai/')) console.error(err);
  res.status(status).json({ error: message, ...err.extra });
});

/* ======================================================================
   The React app: Vite in development, the built files in production
   ====================================================================== */
const server = http.createServer(app);
if (PROD) {
  const dist = path.join(APP_DIR, 'dist');
  app.use(express.static(dist));
  app.get(/.*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: APP_DIR, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  app.use(vite.middlewares);
}

server.listen(PORT, HOST, () => {
  console.log(`PO Messages Editor: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Workspace: ${WORKSPACE}`);
});
