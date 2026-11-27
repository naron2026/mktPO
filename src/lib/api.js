async function req(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || `Request failed (${r.status})`);
    err.status = r.status; err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  config: () => req('GET', '/api/config'),
  files: () => req('GET', '/api/files'),
  read: (path) => req('GET', '/api/file?path=' + encodeURIComponent(path)),
  save: (path, text, baseMtime, force) => req('PUT', '/api/file', { path, text, baseMtime, force: !!force }),
  buildMo: (path) => req('POST', '/api/mo', { path }),
  moUrl: (path) => '/api/mo?path=' + encodeURIComponent(path),
  tmStats: () => req('GET', '/api/tm/stats'),
  suggest: (lang, src, limit = 4) => req('POST', '/api/tm/suggest', { lang, src, limit }),
  tmLookup: (lang, srcs) => req('POST', '/api/tm/lookup', { lang, srcs }),
  aiSuggest: (body) => req('POST', '/api/ai/suggest', body),
  aiModels: (cfg) => req('POST', '/api/ai/models', cfg),
  tmAdd: (lang, file, items) => (lang && items.length ? req('POST', '/api/tm/add', { lang, file, items }) : Promise.resolve({ added: 0 }))
};
