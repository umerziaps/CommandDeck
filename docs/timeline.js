// Command Deck — work timeline: the model.
//
// A record of what happened and when: a client handed over specs, a release
// went out, an incident started. The point is not the individual entry — it is
// being able to zoom out six months later and see the shape of the period,
// which is exactly the thing nobody can reconstruct from memory or from a
// commit log.
//
// Unlike the vault, this is NOT encrypted. That is a deliberate choice and it
// has consequences worth naming: the entries and their attachments are
// readable in the Firebase console, by anyone with access to the Google
// account, and by anyone who gets into the project. That is fine for "release
// 2.1 published on the 14th" and much less fine for a client's specification
// document. The model keeps attachments as metadata pointing at Cloud Storage
// precisely so the decision about what to upload stays a decision.
//
// Pure: no DOM, no Firebase. docs/timeline.test.js runs it under node --test.

/* ------------------------------------------------------------------ *
 * SCHEMA
 *
 *   users/{uid}/events/{eventId}
 *     title        string
 *     date         string  'yyyy-MM-dd' — the day it happened, not the day
 *                          it was recorded. Stored as a string like every
 *                          other date in this project, so the clients and
 *                          the JSON backup agree without timezone drift.
 *     body         string
 *     projectId    string  ('' when unassigned)
 *     attachments  [{ id, name, size, type, path, uploadedAt }]
 *     createdAt    string (ISO 8601)
 *     updatedAt    string (ISO 8601)
 *
 *   users/{uid}/projects/{projectId}
 *     name         string
 *     color        string ('#RRGGBB')
 *     createdAt    string (ISO 8601)
 *
 * `path` is the object's location in Cloud Storage, not a download URL.
 * Download URLs are tokens that live forever once minted and would be a
 * readable handle to a client document sitting in a plaintext document.
 * The app asks for a fresh one when someone actually clicks.
 * ------------------------------------------------------------------ */

export const EVENT_FIELDS = ['title', 'date', 'body', 'projectId'];

export const PROJECT_PALETTE = [
  '#5EE6C5', '#7C89F0', '#F0B45E', '#FF6B54',
  '#58C4F0', '#C98BF0', '#8FD35A', '#F07EA8'
];

export const UNASSIGNED = '__unassigned__';

/* ---------- dates ---------- *
 *
 * Everything here works on 'yyyy-MM-dd' strings and compares them
 * lexicographically, which for that format is the same as comparing dates.
 * No Date objects in the hot path: `new Date('2026-03-01')` is UTC midnight
 * while `new Date(2026, 2, 1)` is local midnight, and mixing them is how a
 * timeline ends up showing an event on the wrong day for half the year.
 */

export const isDayString = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function todayDay(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 'yyyy-MM-dd' → 'yyyy-MM'. The timeline's unit of zoom. */
export const monthOf = (day) => (isDayString(day) ? day.slice(0, 7) : '');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A fixed table rather than toLocaleDateString, for the same reason lib.js
// uses one: locale formatting is not stable across browsers or ICU versions.
export function monthLabel(month, { short = false } = {}) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) return '';
  const [y, m] = month.split('-');
  const names = short ? MONTH_SHORT : MONTH_NAMES;
  return `${names[Number(m) - 1]} ${y}`;
}

export function dayLabel(day) {
  if (!isDayString(day)) return '';
  const [, m, d] = day.split('-');
  return `${Number(d)} ${MONTH_SHORT[Number(m) - 1]}`;
}

/** Shifts a day string by whole months, clamping to the end of short months. */
export function addMonths(day, delta) {
  if (!isDayString(day)) return day;
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + delta, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const p = (n) => String(n).padStart(2, '0');
  // 31 January minus one month is 31 December, but plus one month has to be
  // 28 or 29 February rather than rolling into March.
  return `${target.getUTCFullYear()}-${p(target.getUTCMonth() + 1)}-${p(Math.min(d, lastDay))}`;
}

/* ---------- ranges ---------- */

export const RANGES = [
  { key: '3m', label: '3 months', months: 3 },
  { key: '6m', label: '6 months', months: 6 },
  { key: '1y', label: '1 year', months: 12 },
  { key: '2y', label: '2 years', months: 24 },
  { key: 'all', label: 'All', months: null }
];

export const rangeByKey = (key) => RANGES.find((r) => r.key === key) || RANGES[1];

/** The first day included by a range, or '' for all of time. */
export function rangeStart(key, today = todayDay()) {
  const r = rangeByKey(key);
  return r.months === null ? '' : addMonths(today, -r.months);
}

/* ---------- events ---------- */

export function blankEvent(today = todayDay()) {
  return { title: '', date: today, body: '', projectId: '', attachments: [] };
}

export function normaliseEvent(id, data = {}) {
  return {
    id,
    title: typeof data.title === 'string' ? data.title : '',
    date: isDayString(data.date) ? data.date : '',
    body: typeof data.body === 'string' ? data.body : '',
    projectId: typeof data.projectId === 'string' ? data.projectId : '',
    attachments: Array.isArray(data.attachments)
      ? data.attachments.map(normaliseAttachment).filter(Boolean)
      : [],
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : '',
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : ''
  };
}

export function eventBody(event) {
  return {
    title: (event?.title || '').trim(),
    date: isDayString(event?.date) ? event.date : '',
    body: typeof event?.body === 'string' ? event.body : '',
    projectId: typeof event?.projectId === 'string' ? event.projectId : '',
    attachments: Array.isArray(event?.attachments)
      ? event.attachments.map(attachmentBody)
      : []
  };
}

export function validateEvent(event) {
  const title = (event?.title || '').trim();
  if (!title) return { ok: false, error: 'Give the event a title.' };
  if (title.length > 200) return { ok: false, error: 'That title is too long (200 characters max).' };
  if (!isDayString(event?.date)) return { ok: false, error: 'Pick a date.' };
  if ((event?.body || '').length > 20000) return { ok: false, error: 'That description is too long (20,000 characters max).' };
  return { ok: true };
}

// Newest first. A timeline is read from the present backwards; the question is
// always "what happened recently", not "what happened first".
export const eventOrder = (a, b) =>
  String(b.date || '').localeCompare(String(a.date || ''))
  || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

export function filterEvents(events, { rangeKey = '6m', projectId = '', query = '', today = todayDay() } = {}) {
  const from = rangeStart(rangeKey, today);
  const q = query.trim().toLowerCase();

  return events.filter((e) => {
    if (from && String(e.date || '') < from) return false;
    if (projectId === UNASSIGNED) { if (e.projectId) return false; }
    else if (projectId && e.projectId !== projectId) return false;
    if (q && !['title', 'body'].some((f) => (e[f] || '').toLowerCase().includes(q))) return false;
    return true;
  });
}

/** Events bucketed by month, newest month first, for the scrolling spine. */
export function groupByMonth(events) {
  const buckets = new Map();
  for (const e of [...events].sort(eventOrder)) {
    const m = monthOf(e.date);
    if (!m) continue;
    if (!buckets.has(m)) buckets.set(m, []);
    buckets.get(m).push(e);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, items]) => ({ month, label: monthLabel(month), events: items }));
}

/**
 * One bar per month across the whole window, INCLUDING the months with
 * nothing in them.
 *
 * The empty months are the point. A strip drawn only from months that have
 * events shows an evenly busy year no matter what happened; the quiet stretch
 * in August is information, and leaving it out is the difference between a
 * chart and a decoration.
 */
export function monthlyDensity(events, { rangeKey = '6m', today = todayDay() } = {}) {
  const counts = new Map();
  for (const e of events) {
    const m = monthOf(e.date);
    if (m) counts.set(m, (counts.get(m) || 0) + 1);
  }
  if (!counts.size && rangeByKey(rangeKey).months === null) return [];

  const from = rangeStart(rangeKey, today);
  const firstSeen = [...counts.keys()].sort()[0];
  const startMonth = from ? monthOf(from) : (firstSeen || monthOf(today));
  const endMonth = monthOf(today);

  const bars = [];
  let cursor = `${startMonth}-01`;
  // Bounded so a bad date can never spin here: 50 years of months.
  for (let i = 0; i < 600 && monthOf(cursor) <= endMonth; i++) {
    const m = monthOf(cursor);
    bars.push({ month: m, label: monthLabel(m, { short: true }), count: counts.get(m) || 0 });
    cursor = addMonths(cursor, 1);
  }
  return bars;
}

export function countByProject(events, projects) {
  const counts = { [UNASSIGNED]: 0 };
  for (const p of projects) counts[p.id] = 0;
  for (const e of events) {
    const id = e.projectId && projects.some((p) => p.id === e.projectId) ? e.projectId : UNASSIGNED;
    counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}

/* ---------- projects ---------- */

export function blankProject(existingCount = 0) {
  return { name: '', color: PROJECT_PALETTE[existingCount % PROJECT_PALETTE.length] };
}

export function normaliseProject(id, data = {}) {
  let color = typeof data.color === 'string' ? data.color : '';
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) color = PROJECT_PALETTE[0];
  return {
    id,
    name: typeof data.name === 'string' ? data.name : '',
    color,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : ''
  };
}

export function validateProject(project, existing = [], selfId = null) {
  const name = (project?.name || '').trim();
  if (!name) return { ok: false, error: 'Give the project a name.' };
  if (name.length > 80) return { ok: false, error: 'That name is too long (80 characters max).' };
  const clash = existing.some((p) =>
    p.id !== selfId && (p.name || '').trim().toLowerCase() === name.toLowerCase());
  if (clash) return { ok: false, error: 'You already have a project with that name.' };
  return { ok: true };
}

export const projectOrder = (a, b) =>
  (a.createdAt || '').localeCompare(b.createdAt || '')
  || (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });

export const projectById = (projects, id) => projects.find((p) => p.id === id) || null;

/* ---------- attachments ---------- */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;   // 10 MB
export const MAX_ATTACHMENTS_PER_EVENT = 12;

// Not a security control — Storage rules enforce the real limits, and a
// content type sent by a browser is a claim, not a fact. This is here to stop
// someone accidentally parking a 400 MB video in a 10 GB bucket.
export function validateAttachment(file, existing = []) {
  if (!file) return { ok: false, error: 'No file.' };
  if (existing.length >= MAX_ATTACHMENTS_PER_EVENT) {
    return { ok: false, error: `That is the limit of ${MAX_ATTACHMENTS_PER_EVENT} attachments on one event.` };
  }
  if (typeof file.size === 'number' && file.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: `${file.name || 'That file'} is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}.` };
  }
  if (typeof file.size === 'number' && file.size === 0) {
    return { ok: false, error: `${file.name || 'That file'} is empty.` };
  }
  return { ok: true };
}

export function normaliseAttachment(a) {
  if (!a || typeof a.path !== 'string' || !a.path) return null;
  return {
    id: typeof a.id === 'string' ? a.id : '',
    name: typeof a.name === 'string' ? a.name : 'attachment',
    size: typeof a.size === 'number' ? a.size : 0,
    type: typeof a.type === 'string' ? a.type : '',
    path: a.path,
    uploadedAt: typeof a.uploadedAt === 'string' ? a.uploadedAt : ''
  };
}

export const attachmentBody = (a) => ({
  id: a.id || '', name: a.name || '', size: a.size || 0,
  type: a.type || '', path: a.path || '', uploadedAt: a.uploadedAt || ''
});

/**
 * Where an attachment lives in Cloud Storage.
 *
 * The uploaded name is sanitised and the attachment id is prefixed, so two
 * files called "scan.pdf" cannot collide and a crafted name cannot climb out
 * of the event's own folder. The original name is kept in Firestore for
 * display — this is a storage key, not a label.
 */
export function attachmentPath(uid, eventId, attachmentId, filename) {
  const safe = String(filename || 'file')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-80) || 'file';
  return `users/${uid}/events/${eventId}/${attachmentId}-${safe}`;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / (1024 ** i);
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** A coarse kind for the icon. Extension first: browsers lie about type. */
export function attachmentKind(a) {
  const name = (a?.name || '').toLowerCase();
  const type = (a?.type || '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|heic|bmp|svg)$/.test(name) || type.startsWith('image/')) return 'image';
  if (/\.pdf$/.test(name) || type === 'application/pdf') return 'pdf';
  if (/\.(eml|msg)$/.test(name) || type.startsWith('message/')) return 'email';
  if (/\.(docx?|odt|rtf|pages)$/.test(name)) return 'doc';
  if (/\.(xlsx?|csv|numbers)$/.test(name)) return 'sheet';
  if (/\.(pptx?|key)$/.test(name)) return 'slides';
  if (/\.(zip|tar|gz|7z|rar)$/.test(name)) return 'archive';
  return 'file';
}
