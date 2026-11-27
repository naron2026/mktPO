// PO Messages Editor API: reads and writes .po/.pot files, compiles .mo files
// and keeps the team memory shared by everyone. Used by the local server
// (server/index.js) and the Vercel function (api/index.js).
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { parsePO, compileMO, similarity } from '../shared/po.js';
import { aiSuggest, aiModels } from './ai.js';
import { createStorage, HttpError, isPo } from './storage.js';

export async function createApp({ workspace, dataDir, password = '' }) {
  const store = await createStorage({ workspace, dataDir });

  async function tmSuggest(lang, src, limit) {
    if (!lang || !src) return [];
    const m = await store.tmGet(lang);
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

  const app = express();
  app.get('/healthz', (req, res) => res.send('ok'));

  // With a password, every page and API call needs it (HTTP Basic auth; any
  // user name). The browser asks once and sends it with later requests.
  const digest = (s) => crypto.createHash('sha256').update(s).digest();
  if (password) {
    const want = digest(password);
    app.use((req, res, next) => {
      const [scheme, value] = (req.headers.authorization || '').split(' ');
      const given = scheme === 'Basic' && value ? Buffer.from(value, 'base64').toString().replace(/^[^:]*:/, '') : null;
      if (given !== null && crypto.timingSafeEqual(digest(given), want)) return next();
      res.set('WWW-Authenticate', 'Basic realm="PO Messages Editor", charset="UTF-8"').status(401).send('Password required.');
    });
  }

  app.use(express.json({ limit: '50mb' }));

  app.get('/api/config', (req, res) => res.json({ workspace: store.label }));

  app.get('/api/files', async (req, res) => {
    const files = await store.list();
    files.sort((a, b) => a.path.localeCompare(b.path));
    res.json({ files });
  });

  app.get('/api/file', async (req, res) => {
    const f = await store.read(req.query.path);
    res.json({ ...f, name: path.posix.basename(f.path) });
  });

  // Save a file. baseMtime is the file's time when it was opened (null for a
  // new file); if the stored file differs, answer 409 unless force is set.
  app.put('/api/file', async (req, res) => {
    const { path: rel, text, baseMtime = null, force = false } = req.body || {};
    if (typeof text !== 'string') throw new HttpError(400, 'The file text is missing.');
    if (!isPo(String(rel))) throw new HttpError(400, 'Only .po and .pot files can be saved.');
    res.json(await store.write(rel, text, baseMtime, force));
  });

  async function moOf(rel) {
    if (!/\.po$/i.test(String(rel))) throw new HttpError(400, 'Only .po files can be compiled.');
    const f = await store.read(rel);
    const { bytes, strings } = compileMO(parsePO(f.text));
    return { bytes, strings, moRel: f.path.replace(/\.po$/i, '.mo') };
  }
  app.get('/api/mo', async (req, res) => {
    const { bytes, moRel } = await moOf(req.query.path);
    res.attachment(path.posix.basename(moRel)).type('application/octet-stream').send(Buffer.from(bytes));
  });
  app.post('/api/mo', async (req, res) => {
    const { bytes, strings, moRel } = await moOf((req.body || {}).path);
    res.json({ path: (await store.writeMo(moRel, bytes)) || moRel, strings });
  });

  app.get('/api/tm/stats', async (req, res) => {
    res.json({ langs: (await store.tmStats()).filter((x) => x.count).sort((a, b) => b.count - a.count) });
  });
  app.post('/api/tm/suggest', async (req, res) => {
    const { lang, src, limit = 4 } = req.body || {};
    res.json({ suggestions: await tmSuggest(lang, src, Math.min(10, +limit || 4)) });
  });
  // Exact matches for many source texts at once (pre-translate).
  app.post('/api/tm/lookup', async (req, res) => {
    const { lang, srcs } = req.body || {};
    const m = lang ? await store.tmGet(lang) : new Map();
    res.json({ ts: Array.isArray(srcs) ? srcs.map((s) => m.get(s)?.t || null) : [] });
  });
  app.post('/api/tm/add', async (req, res) => {
    const { lang, file, items } = req.body || {};
    if (!lang || !Array.isArray(items)) return res.json({ added: 0 });
    const ok = items.filter((it) => it && typeof it.src === 'string' && typeof it.t === 'string' && it.src && it.t);
    res.json({ added: ok.length ? await store.tmAdd(lang, String(file || ''), ok) : 0 });
  });

  // AI suggestions. The API key in the body is used for this call only: it is
  // not stored, and AI errors are answered without logging the request.
  app.post('/api/ai/suggest', async (req, res) => res.json(await aiSuggest(req.body, { examplesFor: (lang, src) => tmSuggest(lang, src, 8) })));
  app.post('/api/ai/models', async (req, res) => res.json(await aiModels(req.body)));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route.' }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500 && !req.path.startsWith('/api/ai/')) console.error(err);
    res.status(status).json({ error: err.message, ...err.extra });
  });

  return app;
}
