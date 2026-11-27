// Where the .po/.pot files and the team memory are kept: a folder on disk
// (local server), or Upstash Redis when its REST URL and token are set
// (Vercel, where functions have no lasting disk).
import fs from 'node:fs/promises';
import path from 'node:path';
import { parsePO, prepareEntries, countsOf } from '../shared/po.js';

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

export const isPo = (name) => /\.pot?$/i.test(name);
const TM_MAX = 50000;

// Language and progress of a file, shown on the start screen.
function infoOf(rel, text, mtime, size) {
  const name = path.posix.basename(rel);
  try {
    const entries = parsePO(text);
    const { lang, nplurals } = prepareEntries(entries);
    return { path: rel, name, kind: /\.pot$/i.test(rel) ? 'pot' : 'po', lang, nplurals, ...countsOf(entries), mtime, size };
  } catch (e) {
    return { path: rel, name, error: e.message };
  }
}

function checkConflict(cur, baseMtime, force) {
  if (cur === null || force) return;
  if (baseMtime === null) throw new HttpError(409, 'A file with that name already exists.', { reason: 'exists', mtime: cur });
  if (cur !== baseMtime) throw new HttpError(409, 'The file was changed by someone else since you opened it.', { reason: 'changed', mtime: cur });
}

export async function createStorage(opts) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return redisStorage(url, token);
  if (process.env.VERCEL) throw new Error('No storage: connect an Upstash Redis database to this Vercel project (Storage tab).');
  return diskStorage(opts);
}

/* ======================================================================
   Disk: files in a workspace folder, team memory in DATA_DIR/tm.json
   ====================================================================== */
async function diskStorage({ workspace, dataDir }) {
  const WORKSPACE = path.resolve(workspace);
  await fs.mkdir(WORKSPACE, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });

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
  const notFound = (e) => { throw e.code === 'ENOENT' ? new HttpError(404, 'File not found.') : e; };

  // Progress per file, worked out again only when the file changes.
  const infoCache = new Map();
  async function describe(abs) {
    const st = await fs.stat(abs);
    const hit = infoCache.get(abs);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.info;
    const info = infoOf(relOf(abs), await fs.readFile(abs, 'utf8'), st.mtimeMs, st.size);
    infoCache.set(abs, { mtime: st.mtimeMs, size: st.size, info });
    return info;
  }

  // Team memory: lang -> Map(source text -> { t, f }). Newest entries are
  // last; the oldest are dropped past TM_MAX per language.
  const TM_FILE = path.join(dataDir, 'tm.json');
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

  return {
    label: WORKSPACE,
    async list() {
      const out = [];
      for (const abs of await walk(WORKSPACE, 0, [])) {
        try { out.push(await describe(abs)); } catch (e) { out.push({ path: relOf(abs), name: path.basename(abs), error: e.message }); }
      }
      return out;
    },
    async read(rel) {
      const abs = resolvePath(rel);
      const [text, st] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]).catch(notFound);
      return { path: relOf(abs), text, mtime: st.mtimeMs };
    },
    async write(rel, text, baseMtime, force) {
      const abs = resolvePath(rel);
      const st = await fs.stat(abs).catch(() => null);
      checkConflict(st ? st.mtimeMs : null, baseMtime, force);
      await writeAtomic(abs, text);
      return { path: relOf(abs), mtime: (await fs.stat(abs)).mtimeMs };
    },
    // The .mo is written next to the .po.
    async writeMo(rel, bytes) {
      const abs = resolvePath(rel);
      await writeAtomic(abs, bytes);
      return relOf(abs);
    },
    async tmGet(lang) { return TM.get(lang) || new Map(); },
    async tmAdd(lang, file, items) {
      if (!TM.has(lang)) TM.set(lang, new Map());
      const m = TM.get(lang);
      let n = 0;
      for (const it of items) {
        if (m.get(it.src)?.t === it.t) continue;
        m.delete(it.src);
        m.set(it.src, { t: it.t, f: file });
        n++;
      }
      for (const k of m.keys()) { if (m.size <= TM_MAX) break; m.delete(k); }
      if (n) saveTM();
      return n;
    },
    async tmStats() { return [...TM].map(([lang, m]) => ({ lang, count: m.size })); }
  };
}

/* ======================================================================
   Upstash Redis
     po:file:<path>  file text
     po:meta         hash  path -> JSON infoOf(...)
     po:tm:<lang>    hash  source text -> JSON { t, f }
     po:tm:langs     set of languages in the team memory
   ====================================================================== */
async function redisStorage(url, token) {
  const { Redis } = await import('@upstash/redis');
  const redis = new Redis({ url, token, automaticDeserialization: false });

  function cleanPath(rel) {
    if (typeof rel !== 'string' || !rel.trim()) throw new HttpError(400, 'A file path is needed.');
    const p = path.posix.normalize(rel.replace(/\\/g, '/')).replace(/^\/+/, '');
    if (!p || p === '.' || p === '..' || p.startsWith('../')) throw new HttpError(400, 'That path is outside the workspace.');
    return p;
  }
  // HGETALL comes back as [field, value, field, value, ...].
  const hashOf = async (key) => {
    const flat = (await redis.hgetall(key)) || [];
    if (!Array.isArray(flat)) return Object.entries(flat);
    const out = [];
    for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
    return out;
  };
  const metaOf = async (p) => { const m = await redis.hget('po:meta', p); return m ? JSON.parse(m) : null; };

  // Each function instance keeps a copy of a language's memory for a short
  // while, so suggestions do not reload the whole hash for every string.
  const TM_TTL = 30000;
  const tmCache = new Map();

  return {
    label: 'Shared storage (Upstash Redis)',
    async list() {
      return (await hashOf('po:meta')).map(([, v]) => JSON.parse(v));
    },
    async read(rel) {
      const p = cleanPath(rel);
      const [text, meta] = await Promise.all([redis.get('po:file:' + p), metaOf(p)]);
      if (text === null || !meta) throw new HttpError(404, 'File not found.');
      return { path: p, text, mtime: meta.mtime };
    },
    async write(rel, text, baseMtime, force) {
      const p = cleanPath(rel);
      const meta = await metaOf(p);
      checkConflict(meta ? meta.mtime : null, baseMtime, force);
      const mtime = Math.max(Date.now(), meta ? meta.mtime + 1 : 0);
      const info = infoOf(p, text, mtime, Buffer.byteLength(text));
      await redis.multi().set('po:file:' + p, text).hset('po:meta', { [p]: JSON.stringify({ mtime, ...info }) }).exec();
      return { path: p, mtime };
    },
    // Nothing to keep: the .mo is compiled again when it is downloaded.
    async writeMo() { return null; },
    async tmGet(lang) {
      const hit = tmCache.get(lang);
      if (hit && Date.now() - hit.at < TM_TTL) return hit.m;
      const m = new Map((await hashOf('po:tm:' + lang)).map(([s, v]) => [s, JSON.parse(v)]));
      tmCache.set(lang, { at: Date.now(), m });
      return m;
    },
    async tmAdd(lang, file, items) {
      const m = await this.tmGet(lang);
      const changed = {};
      for (const it of items) {
        if (m.get(it.src)?.t === it.t) continue;
        m.set(it.src, { t: it.t, f: file });
        changed[it.src] = JSON.stringify({ t: it.t, f: file });
      }
      const n = Object.keys(changed).length;
      if (n) await redis.multi().hset('po:tm:' + lang, changed).sadd('po:tm:langs', lang).exec();
      return n;
    },
    async tmStats() {
      const langs = await redis.smembers('po:tm:langs');
      if (!langs.length) return [];
      const p = redis.pipeline();
      for (const lang of langs) p.hlen('po:tm:' + lang);
      const counts = await p.exec();
      return langs.map((lang, i) => ({ lang, count: +counts[i] }));
    }
  };
}
