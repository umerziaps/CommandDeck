// Pure logic for the Command Deck web client.
//
// Everything here is a plain function of its arguments — no DOM, no
// Firebase, no reading of module-level state. That is the whole point:
// app.js can't be unit-tested because importing it opens a network
// connection and touches `document`, but this file runs anywhere Node does.
//
// Anything that needs "today" takes it as a parameter. A test that reads
// the real clock passes in the morning and fails at midnight.

export const BUCKETS = [
  { key: 'now',     label: 'Now',     empty: 'Nothing active. Pull something up from Later when you start it.' },
  { key: 'waiting', label: 'Waiting', empty: 'Not waiting on anyone.' },
  { key: 'later',   label: 'Later',   empty: 'Captured items land here. Your inbox is clear.' }
];

export const BUCKET_KEYS = BUCKETS.map((b) => b.key);

/** The same ten colours the iOS and Android clients offer. */
export const CAT_PALETTE = [
  '#5EE6C5', '#7C89F0', '#F0B45E', '#FF6B54', '#63C7A6',
  '#C78BF0', '#F07CA8', '#8ECF5E', '#5EB8E6', '#E6C25E'
];

/** First palette colour not already taken. */
export function nextColor(used = []) {
  return CAT_PALETTE.find((c) => !used.includes(c))
    ?? CAT_PALETTE[used.length % CAT_PALETTE.length];
}

export const uid = (prefix = 'i') =>
  prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Escapes text before it goes near innerHTML. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

// --- dates -----------------------------------------------------------------

/** "yyyy-MM-dd" in local time — NOT toISOString(), which shifts to UTC. */
export function todayIso(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function daysBetween(fromIso, toIso) {
  const a = new Date(fromIso + 'T00:00:00');
  const b = new Date(toIso + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

/** "today" / "tomorrow" / "yesterday" / "in 3d" / "4d ago" / "12 Sep". */
export function fmtDate(iso, today = todayIso()) {
  if (!iso) return '';
  const diff = daysBetween(today, iso);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 1 && diff <= 7) return `in ${diff}d`;
  if (diff < -1) return `${Math.abs(diff)}d ago`;
  // A fixed month table rather than toLocaleDateString. Locale-aware
  // formatting is not stable across browsers or ICU versions — en-GB now
  // renders September as "Sept", so the same task would read "14 Sep" on
  // iOS and "14 Sept" on the web. These three clients should agree.
  const d = new Date(iso + 'T00:00:00');
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** '' | 'soon' | 'over' — drives the due chip's colour. */
export function dueState(iso, today = todayIso()) {
  if (!iso) return '';
  const diff = daysBetween(today, iso);
  if (diff < 0) return 'over';
  return diff <= 2 ? 'soon' : '';
}

// --- wire format -----------------------------------------------------------
//
// Field names must match CommandDeck/Models/Item.swift (iOS) and
// model/Item.kt (Android). A rename in one place and not the others reads
// back as a silent default, not an error — hence the tests.

export function normaliseItem(id, d = {}) {
  return {
    id,
    title: d.title || '',
    bucket: BUCKET_KEYS.includes(d.bucket) ? d.bucket : 'later',
    done: !!d.done,
    doneAt: d.doneAt || null,
    waitingOn: d.waitingOn || '',
    due: d.due || '',
    subs: Array.isArray(d.subs) ? d.subs : [],
    catId: d.catId || '',
    urgent: !!d.urgent,
    order: typeof d.order === 'number' ? d.order : 0,
    createdAt: d.createdAt || new Date().toISOString()
  };
}

/** The document shape written back to Firestore. */
export function itemToDoc(item) {
  return {
    title: item.title,
    bucket: item.bucket,
    done: item.done,
    doneAt: item.doneAt ?? null,
    waitingOn: item.waitingOn,
    due: item.due,
    subs: item.subs,
    catId: item.catId,
    urgent: item.urgent,
    order: item.order,
    createdAt: item.createdAt
  };
}

// --- ordering --------------------------------------------------------------

/**
 * Manual order first, newest capture as the tie-break.
 *
 * Note what this does NOT do: float urgent items to the top on every
 * render. The original artifact did, and it fights drag-to-reorder — an
 * item dragged above an urgent one visibly snaps back. Urgency is a
 * one-time lift instead (see liftedOrder).
 */
export const boardOrder = (a, b) =>
  a.order !== b.order
    ? a.order - b.order
    : String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

/** Where a newly captured item goes: the bottom of its bucket. */
export function nextOrder(items, bucket) {
  const peers = items.filter((i) => i.bucket === bucket && !i.done);
  return peers.length ? Math.max(...peers.map((i) => i.order)) + 1 : 0;
}

/** The order that puts an item at the top of its bucket. */
export function liftedOrder(items, item) {
  const peers = items.filter(
    (i) => i.bucket === item.bucket && !i.done && i.id !== item.id
  );
  return (peers.length ? Math.min(...peers.map((p) => p.order)) : 0) - 1;
}

// --- filtering -------------------------------------------------------------

/** filter is '' (all), '__uncat__', or a category id. */
export function matchesFilter(item, filter) {
  if (!filter) return true;
  if (filter === '__uncat__') return !item.catId;
  return item.catId === filter;
}

export function visibleItems(items, bucket, filter) {
  return items
    .filter((i) => !i.done && i.bucket === bucket && matchesFilter(i, filter))
    .sort(boardOrder);
}
