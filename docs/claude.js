// Command Deck — Claude API client, for pulling releases out of a build email
// whose format nothing knows in advance.
//
// WHY THIS EXISTS
// ---------------
// The built-in parser in releases.js is tuned to one team's template. It is
// free, instant and offline, and it breaks the moment another team formats a
// build announcement differently. Writing a new regex parser per app would
// make somebody else a dependency for every app ever added. A model reads an
// unfamiliar email the way a person does.
//
// So: the template parser runs first and costs nothing. This runs only when
// the template parser finds nothing.
//
// ABOUT THE KEY
// -------------
// The key is NEVER in this repository. The repository is public, and a key
// committed to a public repo is a key in a scraper's hands within minutes.
// The key is pasted once by the person, encrypted under their vault
// passphrase, and decrypted only in their own browser.
//
// Even then, calling the API straight from a browser means the key sits in
// page memory while the vault is unlocked — which is why Anthropic's own
// opt-in header for this is named `anthropic-dangerous-direct-browser-access`.
// For a personal tool, with the owner's own key, in the owner's own browser,
// that is an acceptable trade and far better than the alternative of putting
// it in the bundle. For anything with more than one user it is not: that
// wants a proxy holding the key server-side.
//
// Pure apart from fetch, which is injectable, so docs/claude.test.js runs it
// with no network and no key.

export const API_BASE = 'https://api.anthropic.com';
export const API_VERSION = '2023-06-01';

export class ClaudeError extends Error {
  constructor(message, { status = 0, kind = 'unknown' } = {}) {
    super(message);
    this.name = 'ClaudeError';
    this.status = status;
    this.kind = kind;
  }
}

const headers = (key) => ({
  'content-type': 'application/json',
  'x-api-key': key,
  'anthropic-version': API_VERSION,
  // The opt-in Anthropic requires to answer a browser at all. Named to be
  // read, not pasted — see the note above.
  'anthropic-dangerous-direct-browser-access': 'true'
});

/** Turns a failed response into something a person can act on. */
async function toError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || '';
  } catch (_) { /* a non-JSON error body is not worth a second failure */ }

  if (res.status === 401) {
    return new ClaudeError('That API key was rejected. Check it in the Anthropic console.', { status: 401, kind: 'auth' });
  }
  if (res.status === 403) {
    return new ClaudeError('That key is not allowed to do this.', { status: 403, kind: 'auth' });
  }
  if (res.status === 429) {
    return new ClaudeError('Rate limited by the API — wait a moment and try again.', { status: 429, kind: 'rate' });
  }
  if (res.status === 400 && /credit|balance/i.test(detail)) {
    return new ClaudeError(
      'The API account has no credit. The Claude API is billed separately from a Pro subscription.',
      { status: 400, kind: 'billing' });
  }
  if (res.status >= 500) {
    return new ClaudeError('The API is having trouble. Try again shortly.', { status: res.status, kind: 'server' });
  }
  return new ClaudeError(detail || `Request failed (${res.status}).`, { status: res.status, kind: 'request' });
}

const looksLikeKey = (k) => /^sk-ant-/.test((k || '').trim());

export function validateKey(key) {
  const k = (key || '').trim();
  if (!k) return { ok: false, error: 'Paste your API key.' };
  if (!looksLikeKey(k)) {
    return { ok: false, error: 'That does not look like an Anthropic key — they start with "sk-ant-".' };
  }
  return { ok: true };
}

/* ---------- models ---------- */

/**
 * Asks the API which models exist, rather than hard-coding one.
 *
 * A model id baked into a static site outlives its deployment: the app keeps
 * working until the model retires, then fails with an error nobody can map
 * back to a line of code. Discovery costs one cheap request and never rots.
 */
export async function listModels(key, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${API_BASE}/v1/models?limit=100`, { headers: headers(key) });
  if (!res.ok) throw await toError(res);
  const body = await res.json();
  return Array.isArray(body?.data) ? body.data : [];
}

/**
 * Picks a model for extraction: the cheapest capable tier available.
 *
 * This is structured extraction from text, not reasoning — the mid tier does
 * it as well as the top one and costs a fraction. Preference order is by
 * family, falling back to whatever the account can actually see, because a
 * key with limited access should still work.
 */
export function pickModel(models) {
  const ids = models.map((m) => m.id).filter(Boolean);
  if (!ids.length) return '';
  const byNewest = (list) => list.sort((a, b) => b.localeCompare(a))[0];
  const family = (name) => byNewest(ids.filter((id) => id.includes(name)));
  return family('haiku') || family('sonnet') || family('opus') || ids[0];
}

/* ---------- extraction ---------- */

const TOOL = {
  name: 'record_releases',
  description: 'Record every software build or release announced in the text.',
  input_schema: {
    type: 'object',
    properties: {
      releases: {
        type: 'array',
        description: 'One entry per build announced. Empty if the text announces no builds.',
        items: {
          type: 'object',
          properties: {
            version: { type: 'string', description: 'Version string as written, e.g. "v1.3.2". Empty if not stated.' },
            build: { type: 'string', description: 'Build number as written, e.g. "189". Empty if not stated.' },
            env: { type: 'string', description: 'Environment, flavour, region or build variant, e.g. "California", "Production", "staging". Empty if not stated.' },
            changes: { type: 'string', description: 'What changed in this build, verbatim from the text, newline separated. Empty if not stated.' },
            sourceUrl: { type: 'string', description: 'Where the source code lives — a URL or a path such as \\\\fs04\\share. Empty if not stated.' },
            artifactUrl: { type: 'string', description: 'Where the built artifact lives — a URL or a path. Empty if not stated.' },
            buildDate: { type: 'string', description: 'Date of this build as yyyy-MM-dd, taken from the message that announced it. Empty if it cannot be determined.' },
            notes: { type: 'string', description: 'Other build details worth keeping: SDK levels, build type, signing. Empty if none.' }
          },
          required: ['version', 'build', 'env', 'changes', 'sourceUrl', 'artifactUrl', 'buildDate', 'notes']
        }
      }
    },
    required: ['releases']
  }
};

const SYSTEM = `You extract software release records from build announcement emails.

Rules, in order of importance:
1. Record only what the text states. Never infer, complete or tidy a value. An
   absent field is an empty string, which is always better than a plausible guess.
2. Never mark anything as released to production. An environment named
   "Production" is a build flavour, not evidence that it shipped. There is no
   field for it here and you must not encode it in another field.
3. One entry per build. A single announcement covering several build numbers
   with matching environments is several entries, paired in the order given.
   If the counts do not match, repeat the environment text as written.
4. Dates come from the message announcing that build — a forwarded thread has
   one per message. Use yyyy-MM-dd.
5. Copy changes verbatim. Do not summarise, reword or translate them.
6. If the text announces no builds, return an empty list rather than inventing one.`;

/**
 * A long thread is split on message boundaries rather than at a character
 * count, so a build announcement is never cut in half — half an announcement
 * produces a confidently wrong record, which is worse than a missing one.
 */
export function chunkThread(text, { maxChars = 40000, maxChunks = 8 } = {}) {
  const src = String(text || '');
  if (src.length <= maxChars) return [src];

  const pieces = src.split(/(?=\n\s*(?:_{5,}\s*\n)?\s*From:\s)/);
  const chunks = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length > maxChars) {
      chunks.push(current);
      current = piece;
      if (chunks.length >= maxChunks) break;
    } else {
      current += piece;
    }
  }
  if (current && chunks.length < maxChunks) chunks.push(current);
  return chunks.slice(0, maxChunks);
}

async function extractOne(key, text, model, fetchImpl, signal) {
  const res = await fetchImpl(`${API_BASE}/v1/messages`, {
    method: 'POST',
    headers: headers(key),
    signal,
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system: SYSTEM,
      tools: [TOOL],
      // Forced, so the answer arrives as data. Asking for "JSON only" in prose
      // and parsing the reply is how you end up stripping code fences and
      // apologies out of a result that was supposed to be structured.
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content: `Extract every build announced in this email thread.\n\n<email>\n${text}\n</email>` }]
    })
  });

  if (!res.ok) throw await toError(res);
  const body = await res.json();
  const use = (body?.content || []).find((c) => c.type === 'tool_use' && c.name === TOOL.name);
  const list = use?.input?.releases;
  return Array.isArray(list) ? list : [];
}

/**
 * Extracts releases from arbitrary email text.
 *
 * Returns { releases, model, calls, usage }. Partial success is still success:
 * if one chunk of a long thread fails, what the others found is returned with
 * the failure reported alongside, because half a backfill beats none.
 */
export async function extractReleases(key, text, {
  model = '', fetchImpl = fetch, signal, onProgress = () => {}
} = {}) {
  const check = validateKey(key);
  if (!check.ok) throw new ClaudeError(check.error, { kind: 'auth' });

  let chosen = model;
  if (!chosen) {
    const models = await listModels(key, { fetchImpl });
    chosen = pickModel(models);
    if (!chosen) throw new ClaudeError('That key cannot see any models.', { kind: 'auth' });
  }

  const chunks = chunkThread(text);
  const releases = [];
  const failures = [];

  for (let i = 0; i < chunks.length; i++) {
    onProgress({ done: i, total: chunks.length, model: chosen });
    try {
      releases.push(...await extractOne(key, chunks[i], chosen, fetchImpl, signal));
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      // An auth or billing failure will fail identically on every remaining
      // chunk; there is no point spending the attempts to prove it.
      if (err instanceof ClaudeError && ['auth', 'billing'].includes(err.kind)) throw err;
      failures.push(err?.message || String(err));
    }
  }
  onProgress({ done: chunks.length, total: chunks.length, model: chosen });

  if (!releases.length && failures.length) {
    throw new ClaudeError(failures[0], { kind: 'request' });
  }
  return { releases: releases.map(sanitise), model: chosen, calls: chunks.length, failures };
}

/**
 * Narrows a model's output to the known fields.
 *
 * Whatever comes back is data from outside the app and is treated that way: a
 * field that is not a string becomes an empty one, a date that is not a date
 * is dropped, and `production` is not accepted at all — the model is told not
 * to decide it and the code does not give it the option.
 */
export function sanitise(r) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const date = str(r?.buildDate);
  return {
    version: str(r?.version).slice(0, 80),
    build: str(r?.build).slice(0, 80),
    env: str(r?.env).slice(0, 120),
    changes: str(r?.changes).slice(0, 20000),
    sourceUrl: str(r?.sourceUrl).slice(0, 2000),
    artifactUrl: str(r?.artifactUrl).slice(0, 2000),
    buildDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    notes: str(r?.notes).slice(0, 20000),
    production: false,
    prodDate: ''
  };
}

/** Drops anything with nothing to identify it. */
export const usable = (r) => !!(r.version || r.build);
