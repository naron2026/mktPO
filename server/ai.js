// AI translation suggestions. The API key comes with each request from the
// browser, is used for that one call and is never stored or logged.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

export const PROVIDERS = ['anthropic', 'openai', 'gemini', 'compatible'];

export class AiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Claude models that take effort + JSON output, and those that take the
// server-side refusal fallback ("default" picks the fallback model).
const MODERN_CLAUDE = /^claude-(fable|mythos|opus-5|sonnet-5|haiku-5)/;
const FALLBACK_CLAUDE = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

const formsSchema = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { forms: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } },
        required: ['forms', 'note'],
        additionalProperties: false
      }
    }
  },
  required: ['suggestions'],
  additionalProperties: false
};

function prompts({ lang, langName, nforms, entry, examples }) {
  const formNames = nforms === 1 ? 'one form used for every count'
    : nforms === 2 ? 'singular (1), then plural (2 or more)'
      : `${nforms} plural forms in the order of the language's Plural-Forms rule`;
  const system = [
    `You translate user-interface strings of a software product (gettext .po files) from English into ${langName} (${lang}).`,
    'Rules:',
    '- Keep every placeholder exactly as written in the source, e.g. %(name)s, %s, %d, {name}. Do not translate or drop them.',
    '- Keep line breaks, and leading or trailing spaces and punctuation, as in the source.',
    '- Use the same terminology as the team\'s earlier translations listed under "Team translations". They show the product\'s required vocabulary.',
    '- Keep translations as short as the source; they appear in buttons, labels and messages.',
    `Reply with JSON only, in this shape: {"suggestions":[{"forms":["..."],"note":"..."}]}.`,
    `Give 1 or 2 translations, best first; add a third only if it is clearly different. "forms" has exactly ${nforms} string${nforms === 1 ? '' : 's'}: ${formNames}.`,
    '"note" is one short English sentence on a word choice the translator should know about, or "".'
  ].join('\n');
  const parts = [`Source text:\n${entry.id}`];
  if (entry.idPlural) parts.push(`Plural source text:\n${entry.idPlural}`);
  if (entry.ctx) parts.push(`Context (msgctxt): ${entry.ctx}`);
  if (entry.notes) parts.push(`Note from the developer: ${entry.notes}`);
  if (entry.comment) parts.push(`Comment from the translation team: ${entry.comment}`);
  if (examples.length) parts.push('Team translations:\n' + examples.map((x) => `- "${x.src}" → "${x.t}"`).join('\n'));
  return { system, user: parts.join('\n\n') };
}

// Models may wrap JSON in a code fence or add a sentence around it.
export function parseReply(text, nforms) {
  let data;
  try { data = JSON.parse(text); } catch {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    try { data = JSON.parse(text.slice(a, b + 1)); } catch { throw new AiError(502, 'The model did not answer in the expected format. Try again or pick another model.'); }
  }
  const list = Array.isArray(data?.suggestions) ? data.suggestions : [];
  const seen = new Set();
  return list
    .map((s) => {
      const forms = (Array.isArray(s?.forms) ? s.forms : [s?.forms]).filter((f) => typeof f === 'string');
      if (!forms.length || !forms[0]) return null;
      while (forms.length < nforms) forms.push(forms[forms.length - 1]);
      return { forms: forms.slice(0, nforms), note: typeof s.note === 'string' ? s.note : '' };
    })
    .filter((s) => s && !seen.has(s.forms.join('\0')) && seen.add(s.forms.join('\0')))
    .slice(0, 3);
}

function check(cfg) {
  if (!PROVIDERS.includes(cfg.provider)) throw new AiError(400, 'Pick an AI provider in AI settings.');
  if (!cfg.apiKey && cfg.provider !== 'compatible') throw new AiError(400, 'Enter your API key in AI settings.');
  if (cfg.provider === 'compatible' && !/^https?:\/\//.test(cfg.baseURL || '')) throw new AiError(400, 'Enter the server address (base URL) in AI settings.');
}

const TIMEOUT = 60000;

// Short UI strings need little reasoning, and reasoning is most of the wait on
// thinking models. Each provider gets a list of settings from fastest to none;
// a model that rejects one (HTTP 400) is retried with the next, and the step
// that worked is remembered per model.
const FAST = {
  gemini: [{ thinkingConfig: { thinkingLevel: 'LOW' } }, { thinkingConfig: { thinkingBudget: 0 } }, {}],
  openai: [{ reasoning_effort: 'low' }, {}],
  compatible: [{ reasoning_effort: 'low' }, {}]
};
const fastStep = new Map();   // provider|baseURL|model -> index into FAST[provider]

async function callOnce(cfg, system, user, fast) {
  const { provider, model, apiKey } = cfg;
  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey, maxRetries: 1, timeout: TIMEOUT });
    const modern = MODERN_CLAUDE.test(model);
    const fallback = FALLBACK_CLAUDE.has(model);
    const msg = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      ...(modern ? { output_config: { effort: 'low', format: { type: 'json_schema', schema: formsSchema } } } : {}),
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {})
    });
    if (msg.stop_reason === 'refusal') throw new AiError(422, 'The model declined to translate this string.');
    return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  if (provider === 'openai' || provider === 'compatible') {
    const client = new OpenAI({ apiKey: apiKey || 'none', baseURL: provider === 'compatible' ? cfg.baseURL : undefined, maxRetries: 1, timeout: TIMEOUT });
    const r = await client.chat.completions.create({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...fast
    });
    return r.choices[0]?.message?.content || '';
  }
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: TIMEOUT } });
  const r = await ai.models.generateContent({
    model,
    contents: user,
    config: { systemInstruction: system, responseMimeType: 'application/json', ...fast }
  });
  return r.text || '';
}

async function callModel(cfg, system, user) {
  const steps = FAST[cfg.provider] || [{}];
  const key = `${cfg.provider}|${cfg.baseURL || ''}|${cfg.model}`;
  for (let i = fastStep.get(key) || 0; ; i++) {
    try {
      const text = await callOnce(cfg, system, user, steps[i]);
      fastStep.set(key, i);
      return text;
    } catch (err) {
      const status = err.status || err.code;
      if (status !== 400 || i >= steps.length - 1 || /API_KEY_INVALID|API key not valid/i.test(err.message || '')) throw err;
    }
  }
}

// Recent answers, so a string asked again (another tab, a teammate, a reload)
// is answered at once. Keyed without the API key.
const CACHE_MAX = 2000;
const cache = new Map();
const cacheKey = (cfg, nforms, entry) => JSON.stringify([cfg.provider, cfg.baseURL || '', cfg.model, cfg.lang, nforms, entry.id, entry.idPlural || null, entry.ctx || null]);

// Errors from the provider SDKs carry an HTTP status; pass a readable message on.
function wrap(err) {
  if (err instanceof AiError) return err;
  const status = err.status || err.code;
  let message = String(err.message || '');
  try { message = JSON.parse(message).error.message || message; } catch { /* not JSON */ }   // Gemini puts JSON in the message
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid/i.test(err.message || '')) return new AiError(401, 'The provider rejected the API key.');
  if (status === 404) return new AiError(400, 'The provider does not know this model. Use Load models in AI settings.');
  if (status === 429) return new AiError(429, 'The provider is rate limiting or the account is out of credit. Try again shortly.');
  return new AiError(502, 'AI provider error: ' + (message || 'no answer'));
}

// examplesFor(lang, src) gives team translations to show the model, when
// the browser did not send any.
export async function aiSuggest(body, { examplesFor } = {}) {
  const cfg = body || {};
  check(cfg);
  if (!cfg.model) throw new AiError(400, 'Pick a model in AI settings.');
  const entry = cfg.entry || {};
  if (typeof entry.id !== 'string' || !entry.id) throw new AiError(400, 'There is no source text to translate.');
  const nforms = Math.min(6, Math.max(1, +cfg.nforms || 1));
  const key = cacheKey(cfg, nforms, entry);
  if (!cfg.fresh && cache.has(key)) return { suggestions: cache.get(key), ms: 0, cached: true };
  const given = Array.isArray(cfg.examples) ? cfg.examples : (examplesFor ? examplesFor(cfg.lang, entry.id) : []);
  const examples = given.filter((x) => x && typeof x.src === 'string' && typeof x.t === 'string').slice(0, 8);
  const { system, user } = prompts({ lang: String(cfg.lang || ''), langName: String(cfg.langName || cfg.lang || 'the target language'), nforms, entry, examples });
  const t0 = Date.now();
  let suggestions;
  try { suggestions = parseReply(await callModel(cfg, system, user), nforms); } catch (err) { throw wrap(err); }
  cache.delete(key);
  cache.set(key, suggestions);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return { suggestions, ms: Date.now() - t0 };
}

export async function aiModels(body) {
  const cfg = body || {};
  check(cfg);
  const ids = [];
  try {
    if (cfg.provider === 'anthropic') {
      for await (const m of new Anthropic({ apiKey: cfg.apiKey, maxRetries: 1 }).models.list()) ids.push(m.id);
    } else if (cfg.provider === 'gemini') {
      const pager = await new GoogleGenAI({ apiKey: cfg.apiKey }).models.list();
      for await (const m of pager) {
        if (!m.supportedActions || m.supportedActions.includes('generateContent')) ids.push(String(m.name).replace(/^models\//, ''));
      }
    } else {
      const client = new OpenAI({ apiKey: cfg.apiKey || 'none', baseURL: cfg.provider === 'compatible' ? cfg.baseURL : undefined, maxRetries: 1 });
      for await (const m of client.models.list()) ids.push(m.id);
    }
  } catch (err) { throw wrap(err); }
  return { models: ids };
}
