// Command Deck — release management: the model, and a parser for build emails.
//
// What shipped, what version, from which branch, built for which environment,
// and whether it reached production. The questions that get asked months later
// — "which build did the client actually get in June?" — and that nobody can
// answer from a chat thread.
//
// Plaintext, like the timeline and unlike the vault. See docs/timeline.js for
// what that means; the same reasoning applies.
//
// Pure: no DOM, no Firebase. docs/releases.test.js runs it under node --test.

/* ------------------------------------------------------------------ *
 * SCHEMA
 *
 *   users/{uid}/apps/{appId}
 *     name, platform, repoUrl, artifactUrl, color, notes, createdAt
 *
 *   users/{uid}/releases/{releaseId}
 *     appId      string
 *     version    string  'v1.3.2'
 *     build      string  '189' — kept as a string: build numbers are labels,
 *                        and '007' and '1.2-rc' both turn up in the wild
 *     env        string  'California', 'Production', 'Ohio' — free text,
 *                        because a build flavour is whatever the team calls it
 *     changes    string
 *     sourceUrl  string  a URL or a UNC path
 *     artifactUrl string
 *     buildDate  string  'yyyy-MM-dd'
 *     production bool
 *     prodDate   string  'yyyy-MM-dd' | ''
 *     notes      string
 *     createdAt, updatedAt
 * ------------------------------------------------------------------ */

import { isDayString, todayDay } from './timeline.js';

export const PLATFORMS = [
  { key: 'android', label: 'Android' },
  { key: 'ios', label: 'iOS' },
  { key: 'web', label: 'Web' },
  { key: 'backend', label: 'Backend' },
  { key: 'other', label: 'Other' }
];

export const APP_PALETTE = [
  '#5EE6C5', '#7C89F0', '#F0B45E', '#FF6B54',
  '#58C4F0', '#C98BF0', '#8FD35A', '#F07EA8'
];

export const platformLabel = (k) => PLATFORMS.find((p) => p.key === k)?.label || 'Other';

/* ---------- apps ---------- */

export function blankApp(existingCount = 0) {
  return {
    name: '', platform: 'android', repoUrl: '', artifactUrl: '', notes: '',
    color: APP_PALETTE[existingCount % APP_PALETTE.length]
  };
}

export function normaliseApp(id, d = {}) {
  let color = typeof d.color === 'string' ? d.color : '';
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) color = APP_PALETTE[0];
  return {
    id,
    name: typeof d.name === 'string' ? d.name : '',
    platform: PLATFORMS.some((p) => p.key === d.platform) ? d.platform : 'other',
    repoUrl: typeof d.repoUrl === 'string' ? d.repoUrl : '',
    artifactUrl: typeof d.artifactUrl === 'string' ? d.artifactUrl : '',
    notes: typeof d.notes === 'string' ? d.notes : '',
    color,
    createdAt: typeof d.createdAt === 'string' ? d.createdAt : ''
  };
}

export const appBody = (a) => ({
  name: (a?.name || '').trim(),
  platform: PLATFORMS.some((p) => p.key === a?.platform) ? a.platform : 'other',
  repoUrl: (a?.repoUrl || '').trim(),
  artifactUrl: (a?.artifactUrl || '').trim(),
  notes: typeof a?.notes === 'string' ? a.notes : '',
  color: /^#[0-9A-Fa-f]{6}$/.test(a?.color || '') ? a.color : APP_PALETTE[0]
});

export function validateApp(app, existing = [], selfId = null) {
  const name = (app?.name || '').trim();
  if (!name) return { ok: false, error: 'Give the app a name.' };
  if (name.length > 80) return { ok: false, error: 'That name is too long (80 characters max).' };
  if (existing.some((a) => a.id !== selfId && (a.name || '').trim().toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: 'You already have an app with that name.' };
  }
  return { ok: true };
}

export const appOrder = (a, b) =>
  (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });

export const appById = (apps, id) => apps.find((a) => a.id === id) || null;

/* ---------- releases ---------- */

export function blankRelease(appId = '', today = todayDay()) {
  return {
    appId, version: '', build: '', env: '', changes: '',
    sourceUrl: '', artifactUrl: '', buildDate: today,
    production: false, prodDate: '', notes: ''
  };
}

export function normaliseRelease(id, d = {}) {
  const str = (v) => (typeof v === 'string' ? v : '');
  return {
    id,
    appId: str(d.appId),
    version: str(d.version),
    build: str(d.build),
    env: str(d.env),
    changes: str(d.changes),
    sourceUrl: str(d.sourceUrl),
    artifactUrl: str(d.artifactUrl),
    buildDate: isDayString(d.buildDate) ? d.buildDate : '',
    production: d.production === true,
    // A production date without the flag would render as shipped; a flag
    // without a date is merely incomplete. Only the pair means shipped.
    prodDate: d.production === true && isDayString(d.prodDate) ? d.prodDate : '',
    notes: str(d.notes),
    createdAt: str(d.createdAt),
    updatedAt: str(d.updatedAt)
  };
}

export function releaseBody(r) {
  const n = normaliseRelease('x', r);
  const { id, createdAt, updatedAt, ...body } = n;
  return body;
}

export function validateRelease(r) {
  if (!(r?.appId || '').trim()) return { ok: false, error: 'Pick which app this is.' };
  if (!(r?.version || '').trim() && !(r?.build || '').trim()) {
    return { ok: false, error: 'Give it a version or a build number.' };
  }
  if (!isDayString(r?.buildDate)) return { ok: false, error: 'Pick the build date.' };
  if (r?.production && !isDayString(r?.prodDate)) {
    return { ok: false, error: 'A release marked as in production needs the date it went out.' };
  }
  if ((r?.changes || '').length > 20000) return { ok: false, error: 'That is too long (20,000 characters max).' };
  return { ok: true };
}

/** Human label for a release: "v1.3.2 (189)". */
export function releaseLabel(r) {
  const v = (r?.version || '').trim();
  const b = (r?.build || '').trim();
  if (v && b) return `${v} (${b})`;
  return v || (b ? `build ${b}` : 'untitled');
}

/**
 * Newest first, by build date, then by build number.
 *
 * Build numbers compare numerically when both are numeric and
 * lexicographically otherwise — '1.2-rc' and '007' both exist, and
 * Number('1.2-rc') is NaN, which would sort it randomly against its peers.
 */
export const releaseOrder = (a, b) => {
  const byDate = String(b.buildDate || '').localeCompare(String(a.buildDate || ''));
  if (byDate) return byDate;
  const na = Number(a.build); const nb = Number(b.build);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return nb - na;
  return String(b.build || '').localeCompare(String(a.build || ''), undefined, { numeric: true });
};

export function filterReleases(releases, { appId = '', env = '', prodOnly = false, query = '' } = {}) {
  const q = query.trim().toLowerCase();
  return releases.filter((r) => {
    if (appId && r.appId !== appId) return false;
    if (env && (r.env || '').toLowerCase() !== env.toLowerCase()) return false;
    if (prodOnly && !r.production) return false;
    if (q && !['version', 'build', 'env', 'changes', 'notes']
      .some((f) => (r[f] || '').toLowerCase().includes(q))) return false;
    return true;
  });
}

/** The distinct environments in use, so the filter offers real values. */
export function environments(releases) {
  const seen = new Map();
  for (const r of releases) {
    const e = (r.env || '').trim();
    if (e && !seen.has(e.toLowerCase())) seen.set(e.toLowerCase(), e);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** The newest release of each app that actually reached production. */
export function latestInProduction(releases, appId) {
  return releases
    .filter((r) => r.appId === appId && r.production)
    .sort((a, b) => String(b.prodDate || '').localeCompare(String(a.prodDate || '')))[0] || null;
}

export function appSummary(releases, appId) {
  const mine = releases.filter((r) => r.appId === appId);
  const prod = latestInProduction(releases, appId);
  const latest = [...mine].sort(releaseOrder)[0] || null;
  return {
    total: mine.length,
    latest,
    production: prod,
    // Worth surfacing: builds made since the last one that shipped. A big
    // number here is the honest answer to "how far has the branch drifted".
    sinceProduction: prod ? mine.filter((r) => String(r.buildDate || '') > String(prod.prodDate || '')).length : mine.length
  };
}

/* ---------- locations ---------- *
 *
 * A source or artifact location is a URL or a UNC path — \\fs04\Integra\... is
 * as common in this world as https:// and is not a link. A browser will not
 * open a file:// or UNC target from an https page, so rendering one as a
 * hyperlink produces a control that silently does nothing. These are
 * classified so the UI can offer the right affordance: open a URL, copy a path.
 */

export function locationKind(s) {
  const v = (s || '').trim();
  if (!v) return 'empty';
  if (/^https?:\/\//i.test(v)) return 'url';
  if (/^\\\\/.test(v)) return 'unc';
  if (/^(file|smb|ftp|sftp):\/\//i.test(v)) return 'uri';
  if (/^[a-zA-Z]:\\/.test(v)) return 'path';
  if (/^[~/]/.test(v)) return 'path';
  return 'text';
}

export const isOpenable = (s) => locationKind(s) === 'url';

/** A short label for a long location, keeping the end that identifies it. */
export function shortLocation(s, max = 52) {
  const v = (s || '').trim();
  if (v.length <= max) return v;
  // Elide the middle, not the front. Cutting the front turns
  // \\fs04\Integra\...\Regal VA into "…s04\Integra\...", which looks like a
  // broken string rather than a shortened one. The server and the leaf are
  // what identify a path; the middle is what can go.
  const head = Math.max(8, Math.floor((max - 1) * 0.35));
  const tail = max - 1 - head;
  return `${v.slice(0, head)}…${v.slice(-tail)}`;
}

/* ---------- tidying what comes out of an email ---------- *
 *
 * "SCOPE OF THIS RELEASE" is a heading in a human email, not a field. What
 * follows it runs on into whatever the author wrote next: a note that the
 * build is ready for QA, a request to be told about problems, a restatement of
 * the version and SDK levels. Scooping all of that into `changes` produces a
 * changelog nobody wants to read and buries the two lines that matter.
 *
 * These are conservative: a line is dropped only when it is unambiguously
 * addressed to the reader rather than describing the build, and metadata is
 * moved rather than discarded.
 */

// Addressed to the reader, not a description of the build.
const COURTESY = [
  /\bplease\s+(let me know|review|confirm|advise|check|test|share)\b/i,
  /\blet (me|us) know\b/i,
  /\bfeel free to\b/i,
  /\bif any issues? (are|is) (identified|found|observed)\b/i,
  /\bif any additional changes? (are|is) required\b/i,
  /\b(kindly|do) (confirm|review|advise)\b/i,
  /\bthanks? (and regards|in advance)\b/i
];

const GREETING = /^(dear|hi|hello|hey)\b[^.!?]{0,40}[,:]?\s*$/i;
const SIGNOFF = /^(regards|best regards|kind regards|thanks|thank you|br|sincerely|cheers)\b[,.]?\s*$/i;

// Build metadata that belongs in notes rather than in the changelog.
const METADATA = /^[•*\-\d.\s]*((version\s*(name|code))|((minimum|maximum|min|max)\s*sdk)|target\s*sdk|build\s*type)\s*[:=]/i;
const METADATA_HEADER = /^[•*\-\s]*(version details|configuration notes)\s*[:(]?/i;

const splitSentences = (line) => line.split(/(?<=[.!?])\s+/);

/**
 * Returns { changes, metadata } — the changelog with courtesy and metadata
 * removed, and the metadata lines that were lifted out of it.
 */
export function tidyChanges(raw) {
  const metadata = [];
  const kept = [];

  for (const line of String(raw || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) { kept.push(''); continue; }
    if (GREETING.test(trimmed) || SIGNOFF.test(trimmed)) continue;

    if (METADATA.test(trimmed)) {
      metadata.push(trimmed.replace(/^[•*\-\s]+/, ''));
      continue;
    }
    if (METADATA_HEADER.test(trimmed)) continue;

    // A line can hold a real statement and a request in the same breath.
    const sentences = splitSentences(trimmed).filter((s) => !COURTESY.some((re) => re.test(s)));
    const rebuilt = sentences.join(' ').trim();
    if (rebuilt) kept.push(rebuilt);
  }

  // A trailing heading left with nothing under it, and runs of blank lines.
  const changes = kept.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[\s\n]+|[\s\n]+$/g, '');

  return { changes, metadata };
}

/** Folds lifted metadata into notes without repeating what is already there. */
export function mergeNotes(notes, metadata) {
  const have = String(notes || '').split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean);
  const add = metadata.filter((m) => !have.includes(m.trim().toLowerCase()));
  return [String(notes || '').trim(), ...add].filter(Boolean).join('\n');
}

/* ================================================================== *
 * BUILD EMAIL PARSER
 *
 * The team announces every build by email on a fixed template:
 *
 *     BUILD DETAILS
 *     Release: v1.3.2 (189)
 *     Environment: (California)
 *     ARTIFACT DETAILS
 *     Build Type: Flashed/ Uploaded To Open Testing
 *     Path (FS04): \\fs04\Integra\OCUFII\Executables
 *     SOURCE CODE DETAILS
 *     Path (FS04): \\fs04\Integra\OCUFII\source code\Android
 *     SCOPE OF THIS RELEASE
 *     ...
 *     CONFIGURATION NOTES (OPTIONAL)
 *     - Minimum SDK: 26
 *
 * Retyping that into a form every time is the kind of chore that gets skipped
 * until the record is useless. Pasting the email is not.
 *
 * The parser reads a whole thread, so the first paste backfills the history
 * and every later one adds a single release. It is deliberately forgiving
 * about what it does not recognise and strict about what it claims: a field
 * it cannot find is left empty rather than guessed.
 * ================================================================== */

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
};

/** Parses the date formats Outlook puts in a "Sent:" line. */
export function parseMailDate(s) {
  const v = (s || '').trim();
  if (!v) return '';
  const p = (n) => String(n).padStart(2, '0');

  // "Friday, September 25, 2026 8:23 PM"
  let m = v.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) {
    return `${m[3]}-${p(MONTHS[m[1].toLowerCase()])}-${p(m[2])}`;
  }
  // "20 August 2026 13:27:55"
  m = v.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    return `${m[3]}-${p(MONTHS[m[2].toLowerCase()])}-${p(m[1])}`;
  }
  // "2026-09-25" anywhere in the line
  m = v.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return '';
}

const clean = (s) => (s || '')
  .replace(/<(?:mailto:|file:|https?:)[^<>\s]*>/gi, '')   // Outlook's inline link duplicates
  .replace(/\r/g, '')
  .replace(/\u00a0/g, ' ')
  .replace(/[ \t]+/g, ' ');

function field(block, re) {
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

/**
 * Splits "v1.3.2 (189)" into its parts.
 * Also handles "v1.3.0 (169,170,171)" — one announcement, several builds.
 */
export function parseReleaseLine(line) {
  const v = (line || '').trim();
  const m = v.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (!m) return { version: v, builds: [''] };
  const builds = m[2].split(/[,/]/).map((b) => b.trim()).filter(Boolean);
  return { version: m[1].trim(), builds: builds.length ? builds : [''] };
}

/**
 * Pulls every build announcement out of a pasted email or thread.
 *
 * Returns newest first, the order they appear in a reply chain.
 */
export function parseBuildEmail(raw, { defaultDate = '' } = {}) {
  const text = clean(raw);
  if (!/Release\s*:/i.test(text)) {
    return { ok: false, error: 'No build details found. Paste the whole email, including the "Release:" line.', releases: [] };
  }

  // Each forwarded message starts with a From: header; the outermost one has
  // none, which is why the first chunk is kept even when it has no Sent line.
  const chunks = text.split(/\n\s*(?:_{5,}\s*\n)?\s*From:\s/);
  const out = [];

  for (const chunk of chunks) {
    const releaseLine = field(chunk, /^\s*Release\s*:\s*(.+)$/im);
    if (!releaseLine) continue;
    // A line that is clearly prose rather than a version — the template is
    // sometimes abandoned mid-thread, and inventing a version from a sentence
    // is worse than skipping it.
    if (releaseLine.length > 60 || /\s(has|have|includes|and|the)\s/i.test(releaseLine)) continue;

    const { version, builds } = parseReleaseLine(releaseLine);
    const envLine = field(chunk, /^\s*Environment\s*:\s*(.+)$/im).replace(/[()]/g, '').trim();
    const envs = envLine.split(/[,/]/).map((e) => e.trim()).filter(Boolean);

    const buildType = field(chunk, /^\s*Build\s*Type\s*:\s*(.+)$/im);
    const sent = field(chunk, /^\s*Sent\s*:\s*(.+)$/im);
    const buildDate = parseMailDate(sent) || defaultDate;

    // Two "Path:" lines, distinguished only by the heading above them.
    const artifactUrl = field(chunk, /ARTIFACT DETAILS[\s\S]{0,400}?^\s*Path[^:\n]*:\s*(.+)$/im);
    const sourceUrl = field(chunk, /SOURCE CODE DETAILS[\s\S]{0,400}?^\s*Path[^:\n]*:\s*(.+)$/im);

    const rawChanges = field(chunk,
      /SCOPE OF THIS RELEASE\s*\n([\s\S]*?)(?=\n\s*CONFIGURATION NOTES|\n\s*Regards|\n\s*From\s*:|\n\s*_{5,}|$)/i)
      .split('\n').map((l) => l.replace(/^\s*[*•·]\s*/, '• ').trimEnd()).filter((l) => l.trim())
      .join('\n').trim();
    const tidied = tidyChanges(rawChanges);
    const changes = tidied.changes;

    const minSdk = field(chunk, /Minimum SDK\s*:?\s*(\d+)/i);
    const maxSdk = field(chunk, /Maximum SDK\s*:?\s*(\d+)/i);
    const notes = mergeNotes([
      buildType ? `Build type: ${buildType}` : '',
      minSdk ? `Minimum SDK: ${minSdk}` : '',
      maxSdk ? `Maximum SDK: ${maxSdk}` : ''
    ].filter(Boolean).join('\n'), tidied.metadata);

    // "v1.3.0 (169,170,171)" with "Demo, Sqa, Production" is three builds in
    // one announcement. Pair them up when the counts agree; otherwise the
    // environment belongs to all of them and splitting would invent a fact.
    const paired = builds.length > 1 && envs.length === builds.length;
    builds.forEach((build, i) => {
      const env = paired ? envs[i] : (envs.join(', ') || '');
      out.push({
        ...blankRelease('', buildDate),
        version, build, env, changes, sourceUrl, artifactUrl, buildDate, notes,
        // Never inferred. "Production" as a build flavour means it was built
        // with production config, not that it was released to anyone — the
        // one field here that matters most is the one worth not guessing.
        production: false,
        prodDate: ''
      });
    });
  }

  if (!out.length) {
    return { ok: false, error: 'Found no build announcements in that text.', releases: [] };
  }
  return { ok: true, releases: out };
}

/**
 * Drops announcements already recorded, so re-pasting a thread is safe.
 * Identity is version + build + environment: the same build announced for two
 * environments is two releases, and the same build re-announced is one.
 */
export function dedupeReleases(parsed, existing, appId) {
  const key = (r) => `${(r.version || '').toLowerCase()}|${(r.build || '').toLowerCase()}|${(r.env || '').toLowerCase()}`;
  const have = new Set(existing.filter((r) => r.appId === appId).map(key));
  const seen = new Set();
  const fresh = [];
  let skipped = 0;
  for (const r of parsed) {
    const k = key(r);
    if (have.has(k) || seen.has(k)) { skipped++; continue; }
    seen.add(k);
    fresh.push(r);
  }
  return { fresh, skipped };
}
