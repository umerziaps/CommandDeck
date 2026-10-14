// Command Deck — Team Visibility Board: the unified Project → Component model,
// specs with versions, planned releases, and the migration that gets the
// existing `apps` collection into the new shape.
//
// WHY THIS EXISTS
//
// The board grew two different ideas of "a thing you work on". The timeline
// calls them `projects` (a stream of events: "client sent specs"). Release
// management calls them `apps` (a thing that produces builds). In practice
// one client project has several deliverables — an iOS app, an Android app, a
// web portal — and the team needs one page that answers, per project: what did
// the client ask for, what has shipped, what is coming, and what is stuck.
//
// So: a PROJECT is the client-facing unit. A COMPONENT is one deliverable
// inside it. Releases belong to components. Specs belong to a project (or to
// one component, when a deliverable has its own document). Timeline events keep
// belonging to projects, unchanged — that is why `projects` is extended rather
// than replaced.
//
// Pure: no DOM, no Firebase, no clock except where a date is passed in.
// docs/board.test.js runs it under node --test.

/* ------------------------------------------------------------------ *
 * SCHEMA
 *
 *   users/{uid}/projects/{projectId}          (EXTENDED — same collection
 *                                              the timeline already uses)
 *     name       string
 *     color      string  '#RRGGBB'
 *     createdAt  string
 *     client     string  ''        who it is for
 *     status     string  'active' | 'paused' | 'shipped' | 'archived'
 *     summary    string  ''        one line, shown on the board card
 *     order      number  0         hand-chosen board position
 *
 *   users/{uid}/components/{componentId}      (NEW — succeeds `apps`)
 *     projectId  string
 *     name       string  'Ocufii iOS'
 *     platform   string  see PLATFORMS below
 *     repoUrl, artifactUrl, notes, color
 *     order      number
 *     createdAt  string
 *
 *   users/{uid}/releases/{releaseId}          (EXTENDED)
 *     componentId string             the new owner
 *     appId       string             kept, same value, so a client that has
 *                                   not been reloaded still finds its releases
 *     planned     bool               has not happened yet
 *     targetDate  string  'yyyy-MM-dd' | ''
 *     status      string  see RELEASE_STATUSES
 *     blocker     string  ''         why it is stuck, shown on the board
 *     ...everything releases.js already stores
 *
 *   users/{uid}/specs/{specId}                (NEW)
 *     projectId   string
 *     componentId string  ''         '' = the project's own spec
 *     title       string
 *     html        string             prettified by docs/docx.js
 *     text        string             plain text, kept for diffing
 *     outline     list               heading texts, for a contents rail
 *     wordCount   number
 *     sourceName  string             the .docx filename it came from
 *     version     number             1, 2, 3… per (projectId, componentId)
 *     createdAt   string
 * ------------------------------------------------------------------ */

import { isDayString, todayDay, PROJECT_PALETTE } from './timeline.js';
import { PLATFORMS as PLATFORM_LIST, platformLabel, ownsRelease } from './releases.js';

/* ---------- platforms ----------
 *
 * One list, defined in releases.js and re-exported here with the grouping the
 * board uses. Two lists would mean a key valid in one and not the other, and a
 * component stored as 'portal' quietly reading back as 'other'.
 */
const PLATFORM_GROUPS = {
  ios: 'Mobile', android: 'Mobile', web: 'Web', portal: 'Web',
  backend: 'Platform', other: 'Platform'
};

export const PLATFORMS = PLATFORM_LIST.map((p) => ({ ...p, group: PLATFORM_GROUPS[p.key] || 'Platform' }));
export { platformLabel };
export const isPlatform = (k) => PLATFORMS.some((p) => p.key === k);

/* Words that appear in an app name only to say which platform it is. Used by
 * the migration to work out that "Ocufii Android" and "Ocufii iOS" are two
 * components of one project — and nowhere else, because guessing from names
 * is only acceptable as a one-time suggestion the user gets to see first. */
const PLATFORM_WORDS = [
  ['ios', 'ios'], ['iphone', 'ios'], ['ipad', 'ios'], ['apple', 'ios'],
  ['android', 'android'],
  ['portal', 'portal'], ['dashboard', 'portal'], ['admin', 'portal'],
  ['website', 'web'], ['web', 'web'], ['site', 'web'],
  ['api', 'backend'], ['backend', 'backend'], ['server', 'backend']
];

export const PROJECT_STATUSES = [
  { key: 'active', label: 'Active' },
  { key: 'paused', label: 'Paused' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'archived', label: 'Archived' }
];

export const projectStatusLabel = (k) =>
  PROJECT_STATUSES.find((s) => s.key === k)?.label || 'Active';

/* ---------- release lifecycle ----------
 *
 * `production` stays the source of truth for "did the client get it", because
 * the rules already validate it and 33 live releases already carry it. Status
 * is the finer grain on top, and it is DERIVED when absent so that every
 * release written before this file existed still renders correctly.
 */
export const RELEASE_STATUSES = [
  { key: 'planned', label: 'Planned', tone: 'wait' },
  { key: 'building', label: 'Building', tone: 'work' },
  { key: 'qa', label: 'In QA', tone: 'work' },
  { key: 'released', label: 'Released', tone: 'done' },
  { key: 'live', label: 'In Production', tone: 'live' },
  { key: 'blocked', label: 'Blocked', tone: 'bad' },
  { key: 'cancelled', label: 'Cancelled', tone: 'off' }
];

export const isReleaseStatus = (k) => RELEASE_STATUSES.some((s) => s.key === k);
export const releaseStatusLabel = (k) =>
  RELEASE_STATUSES.find((s) => s.key === k)?.label || 'Released';
export const releaseStatusTone = (k) =>
  RELEASE_STATUSES.find((s) => s.key === k)?.tone || 'done';

/* The stored status wins when it is set; otherwise it is inferred from the
 * two facts every old release has. Deliberately NOT inferring 'live' from a
 * prodDate alone — the same rule the parser follows: production is something
 * a human confirms, never something the data implies. */
export function releaseStatus(r) {
  if (r?.blocker && !r?.production) return 'blocked';
  if (isReleaseStatus(r?.status)) return r.status;
  if (r?.production === true) return 'live';
  if (r?.planned === true) return 'planned';
  return 'released';
}

/* Two different questions, deliberately two functions:
 *   isPlanned  — is this release still ahead of us? A blocked one still is.
 *   isUpcoming — is it ahead of us AND moving? A blocked one is not, which is
 *                why the board lists it in the blocked box instead. */
export const isPlanned = (r) => r?.planned === true && r?.production !== true;
export const isUpcoming = (r) => isPlanned(r) && releaseStatus(r) !== 'blocked';
export const isBlocked = (r) => releaseStatus(r) === 'blocked';
export const isLive = (r) => r?.production === true;

/* ---------- projects ---------- */

export function blankProject(existingCount = 0) {
  return {
    name: '',
    color: PROJECT_PALETTE[existingCount % PROJECT_PALETTE.length],
    client: '',
    status: 'active',
    summary: ''
  };
}

export function normaliseProject(id, d = {}) {
  const str = (v) => (typeof v === 'string' ? v : '');
  let color = str(d.color);
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) color = PROJECT_PALETTE[0];
  return {
    id,
    name: str(d.name),
    color,
    createdAt: str(d.createdAt),
    client: str(d.client),
    status: PROJECT_STATUSES.some((s) => s.key === d.status) ? d.status : 'active',
    summary: str(d.summary),
    order: typeof d.order === 'number' && Number.isFinite(d.order) ? d.order : 0
  };
}

/* The body a write sends. `createdAt` is set once at creation by the caller
 * and never included here, so an edit cannot overwrite it. */
export function projectBody(p) {
  const n = normaliseProject('x', p);
  return {
    name: n.name.trim(),
    color: n.color,
    client: n.client.trim(),
    status: n.status,
    summary: n.summary,
    order: n.order
  };
}

export function validateProject(project, existing = [], selfId = null) {
  const name = (project?.name || '').trim();
  if (!name) return { ok: false, error: 'Give the project a name.' };
  if (name.length > 80) return { ok: false, error: 'That name is too long (80 characters max).' };
  if ((project?.client || '').length > 80) {
    return { ok: false, error: 'That client name is too long (80 characters max).' };
  }
  if ((project?.summary || '').length > 300) {
    return { ok: false, error: 'Keep the summary under 300 characters — it is one line on a card.' };
  }
  const clash = existing.some((p) =>
    p.id !== selfId && (p.name || '').trim().toLowerCase() === name.toLowerCase());
  if (clash) return { ok: false, error: 'You already have a project with that name.' };
  return { ok: true };
}

/* Hand position first, then creation order, then name.
 *
 * Creation order rather than status is deliberate: this is the order the
 * timeline's project chips have always been in, and the board is not a reason
 * to reshuffle a bar he has learned the shape of. The board applies its own
 * status-aware sort on top — see projectBoardOrder. */
export const projectOrder = (a, b) =>
  ((a.order || 0) - (b.order || 0))
  || (a.createdAt || '').localeCompare(b.createdAt || '')
  || (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });

/* On the board, work in progress comes first. Shipped and archived projects
 * are still reachable through the status filter; they are just not what
 * anyone opens the board to look at. */
const STATUS_RANK = { active: 0, paused: 1, shipped: 2, archived: 3 };

export const projectBoardOrder = (a, b) =>
  ((a.order || 0) - (b.order || 0))
  || ((STATUS_RANK[a.status] ?? 0) - (STATUS_RANK[b.status] ?? 0))
  || (a.createdAt || '').localeCompare(b.createdAt || '')
  || (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });

export const projectById = (projects, id) => projects.find((p) => p.id === id) || null;

export function nextProjectOrder(projects) {
  const arranged = projects.some((p) => (p.order || 0) !== 0);
  if (!arranged) return 0;
  return Math.max(0, ...projects.map((p) => p.order || 0)) + 1;
}

/* ---------- components ---------- */

export function blankComponent(projectId = '', existingCount = 0) {
  return {
    projectId,
    name: '',
    platform: 'ios',
    repoUrl: '',
    artifactUrl: '',
    notes: '',
    color: PROJECT_PALETTE[existingCount % PROJECT_PALETTE.length]
  };
}

export function normaliseComponent(id, d = {}) {
  const str = (v) => (typeof v === 'string' ? v : '');
  let color = str(d.color);
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) color = PROJECT_PALETTE[0];
  return {
    id,
    projectId: str(d.projectId),
    name: str(d.name),
    platform: isPlatform(d.platform) ? d.platform : 'other',
    repoUrl: str(d.repoUrl),
    artifactUrl: str(d.artifactUrl),
    notes: str(d.notes),
    color,
    order: typeof d.order === 'number' && Number.isFinite(d.order) ? d.order : 0,
    createdAt: str(d.createdAt)
  };
}

export function componentBody(c) {
  const n = normaliseComponent('x', c);
  return {
    projectId: n.projectId,
    name: n.name.trim(),
    platform: n.platform,
    repoUrl: n.repoUrl.trim(),
    artifactUrl: n.artifactUrl.trim(),
    notes: n.notes,
    color: n.color,
    order: n.order
  };
}

export function validateComponent(c, existing = [], selfId = null) {
  const name = (c?.name || '').trim();
  if (!name) return { ok: false, error: 'Give the component a name.' };
  if (name.length > 80) return { ok: false, error: 'That name is too long (80 characters max).' };
  if (!(c?.projectId || '').trim()) {
    return { ok: false, error: 'Pick the project this component belongs to.' };
  }
  // Uniqueness is per project: "iOS" under two different clients is fine, and
  // insisting otherwise would force every component to carry its project's
  // name in its own.
  const clash = existing.some((o) =>
    o.id !== selfId
    && o.projectId === c.projectId
    && (o.name || '').trim().toLowerCase() === name.toLowerCase());
  if (clash) return { ok: false, error: 'That project already has a component with that name.' };
  return { ok: true };
}

const PLATFORM_RANK = PLATFORMS.reduce((acc, p, i) => ({ ...acc, [p.key]: i }), {});

export const componentOrder = (a, b) =>
  ((a.order || 0) - (b.order || 0))
  || ((PLATFORM_RANK[a.platform] ?? 99) - (PLATFORM_RANK[b.platform] ?? 99))
  || (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });

export const componentById = (components, id) => components.find((c) => c.id === id) || null;

export const componentsOf = (components, projectId) =>
  components.filter((c) => c.projectId === projectId).sort(componentOrder);

export function nextComponentOrder(components, projectId) {
  const peers = components.filter((c) => c.projectId === projectId);
  const arranged = peers.some((c) => (c.order || 0) !== 0);
  if (!arranged) return 0;
  return Math.max(0, ...peers.map((c) => c.order || 0)) + 1;
}

/* A release can be stored against either key depending on when it was
 * written. Reading has to accept both; writing always sets both. */
export const releaseComponentId = (r) => (r?.componentId || r?.appId || '');

/* Matches on either stored key — see ownsRelease in releases.js. App ids and
 * component ids never collide, so a release cannot land under the wrong one. */
export const releasesOf = (releases, componentId) =>
  releases.filter((r) => ownsRelease(r, componentId));

/* ---------- specs ---------- */

export const MAX_SPEC_HTML = 400_000;      // ~400 KB of markup; a long Word spec
export const MAX_SPEC_TEXT = 200_000;      // lands around 60–80 KB of each

export function normaliseSpec(id, d = {}) {
  const str = (v) => (typeof v === 'string' ? v : '');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    id,
    projectId: str(d.projectId),
    componentId: str(d.componentId),
    title: str(d.title),
    html: str(d.html),
    text: str(d.text),
    outline: Array.isArray(d.outline) ? d.outline.filter((o) => typeof o === 'string') : [],
    wordCount: num(d.wordCount),
    sourceName: str(d.sourceName),
    version: num(d.version) || 1,
    createdAt: str(d.createdAt)
  };
}

export function specBody(s) {
  const n = normaliseSpec('x', s);
  return {
    projectId: n.projectId,
    componentId: n.componentId,
    title: n.title.trim(),
    html: n.html,
    text: n.text,
    outline: n.outline.slice(0, 200),
    wordCount: n.wordCount,
    sourceName: n.sourceName,
    version: n.version
  };
}

export function validateSpec(s) {
  if (!(s?.projectId || '').trim()) return { ok: false, error: 'Pick a project for this spec.' };
  if (!(s?.title || '').trim()) return { ok: false, error: 'The spec needs a title.' };
  if (!(s?.html || '').trim()) return { ok: false, error: 'That document came through empty.' };
  if ((s.html || '').length > MAX_SPEC_HTML) {
    return { ok: false, error: 'That document is too large to store (400 KB of formatting max). Split it, or upload the relevant section.' };
  }
  if ((s.text || '').length > MAX_SPEC_TEXT) {
    return { ok: false, error: 'That document is too long to store (about 30,000 words max).' };
  }
  return { ok: true };
}

/* Specs for one slot, newest first. A slot is a (project, component) pair;
 * componentId '' is the project's own document. */
export const specSlot = (s) => `${s?.projectId || ''}::${s?.componentId || ''}`;

export const specOrder = (a, b) =>
  (b.version || 0) - (a.version || 0)
  || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

export function specsOf(specs, projectId, componentId = '') {
  return specs
    .filter((s) => s.projectId === projectId && (s.componentId || '') === (componentId || ''))
    .sort(specOrder);
}

export const currentSpec = (specs, projectId, componentId = '') =>
  specsOf(specs, projectId, componentId)[0] || null;

export function nextSpecVersion(specs, projectId, componentId = '') {
  const mine = specsOf(specs, projectId, componentId);
  if (!mine.length) return 1;
  return Math.max(...mine.map((s) => s.version || 0)) + 1;
}

/* ---------- spec diff ----------
 *
 * Line-level, not word-level. A spec revision is almost always "this clause
 * changed" or "this section is new", and a word-level diff of a 6,000-word
 * document produces a wall of noise that nobody reads. Lines are paragraphs
 * here, because docx.js emits one line per block.
 *
 * The algorithm is a longest-common-subsequence walk over paragraph hashes.
 * Bounded: above LCS_LIMIT paragraphs it falls back to a set comparison,
 * which loses move detection but cannot hang the tab.
 */
const LCS_LIMIT = 1200;

const specLines = (text) =>
  String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);

function lcsDiff(a, b) {
  const n = a.length; const m = b.length;
  // Uint16Array rows rather than nested plain arrays: at the 1,200-line cap
  // this is ~2.9 MB instead of ~12 MB of boxed numbers, and the LCS length
  // can never exceed 1,200 so 16 bits is always enough.
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { out.push({ kind: 'removed', text: a[i] }); i += 1; }
    else { out.push({ kind: 'added', text: b[j] }); j += 1; }
  }
  while (i < n) { out.push({ kind: 'removed', text: a[i] }); i += 1; }
  while (j < m) { out.push({ kind: 'added', text: b[j] }); j += 1; }
  return out;
}

function setDiff(a, b) {
  const inB = new Set(b);
  const inA = new Set(a);
  return [
    ...a.filter((l) => !inB.has(l)).map((text) => ({ kind: 'removed', text })),
    ...b.filter((l) => !inA.has(l)).map((text) => ({ kind: 'added', text }))
  ];
}

export function diffSpecs(oldSpec, newSpec) {
  const a = specLines(oldSpec?.text);
  const b = specLines(newSpec?.text);
  const truncated = a.length > LCS_LIMIT || b.length > LCS_LIMIT;
  const rows = truncated ? setDiff(a, b) : lcsDiff(a, b);
  const added = rows.filter((r) => r.kind === 'added').length;
  const removed = rows.filter((r) => r.kind === 'removed').length;
  return {
    rows,
    added,
    removed,
    unchanged: rows.length - added - removed,
    truncated,
    identical: added === 0 && removed === 0
  };
}

/* The rows worth showing: every change, plus up to `context` unchanged
 * paragraphs around each one, with a marker where paragraphs were skipped. */
export function diffHunks(diff, context = 1) {
  const rows = diff?.rows || [];
  const keep = new Set();
  rows.forEach((r, i) => {
    if (r.kind === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k += 1) {
      keep.add(k);
    }
  });
  const out = [];
  let gap = 0;
  rows.forEach((r, i) => {
    if (keep.has(i)) {
      if (gap > 0) { out.push({ kind: 'gap', count: gap }); gap = 0; }
      out.push(r);
    } else {
      gap += 1;
    }
  });
  if (gap > 0 && out.length) out.push({ kind: 'gap', count: gap });
  return out;
}

/* ---------- board roll-up ----------
 *
 * One pass over the data producing exactly what a board card needs, so the
 * renderer does no arithmetic. `today` is injected rather than read, because
 * "overdue" is the one thing here that depends on the clock.
 */
export function projectRollup(project, { components = [], releases = [], specs = [], events = [], today = todayDay() } = {}) {
  const mine = componentsOf(components, project.id);
  const ids = new Set(mine.map((c) => c.id));
  const rel = releases.filter((r) => ids.has(releaseComponentId(r)));

  const byTarget = (a, b) =>
    String(a.targetDate || '9999').localeCompare(String(b.targetDate || '9999'));

  const live = rel.filter(isLive);
  // Blocked releases are listed once, in the blocked box. Repeating them under
  // "planned" would make the board look busier than the work actually is.
  const planned = rel.filter(isUpcoming).sort(byTarget);
  const blocked = rel.filter(isBlocked).sort(byTarget);
  // Overdue counts blocked work too: a blocker is a reason, not an extension.
  const overdue = [...planned, ...blocked]
    .filter((r) => r.targetDate && r.targetDate < today).sort(byTarget);

  const lastShipped = live
    .map((r) => r.prodDate)
    .filter(isDayString)
    .sort()
    .pop() || '';

  const perComponent = mine.map((c) => {
    const cr = releasesOf(rel, c.id);
    const cLive = cr.filter(isLive)
      .sort((a, b) => String(b.prodDate || '').localeCompare(String(a.prodDate || '')));
    // Blocked work is still the next planned thing — it just says so. Leaving
    // it out would print "next planned: none" next to a visible blocker.
    const cPlanned = cr.filter(isPlanned).sort(byTarget);
    return {
      component: c,
      // Builds, not rows: a release that has not been built is not a build.
      total: cr.filter((r) => !isPlanned(r)).length,
      plannedCount: cPlanned.length,
      inProduction: cLive[0] || null,
      nextPlanned: cPlanned[0] || null,
      spec: currentSpec(specs, project.id, c.id),
      blocked: cr.filter(isBlocked).length
    };
  });

  return {
    project,
    components: mine,
    perComponent,
    spec: currentSpec(specs, project.id, ''),
    specCount: specs.filter((s) => s.projectId === project.id).length,
    // `releases` is builds recorded. Planned work is counted separately,
    // because adding the two makes a project look busier than it is.
    releases: rel.filter((r) => !isPlanned(r)).length,
    plannedCount: planned.length + blocked.length,
    liveCount: live.length,
    planned,
    blocked,
    overdue,
    lastShipped,
    eventCount: events.filter((e) => e.projectId === project.id).length
  };
}

/* "What is live where" — one row per component per environment, which is the
 * question the team actually asks and that no single release answers. */
export function liveMatrix(components, releases) {
  const envs = new Set();
  const cells = new Map();
  components.forEach((c) => {
    releasesOf(releases, c.id).filter(isLive).forEach((r) => {
      const env = (r.env || '').trim() || 'Production';
      envs.add(env);
      const key = `${c.id}::${env}`;
      const held = cells.get(key);
      if (!held || String(r.prodDate || '').localeCompare(String(held.prodDate || '')) > 0) {
        cells.set(key, r);
      }
    });
  });
  const envList = [...envs].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return {
    envs: envList,
    rows: components.map((c) => ({
      component: c,
      cells: envList.map((env) => ({ env, release: cells.get(`${c.id}::${env}`) || null }))
    }))
  };
}

/* ---------- freshness ----------
 *
 * A visibility board that is three weeks stale is worse than no board, because
 * the team stops asking and starts believing it. So every card says when it
 * was last touched, and says it loudly once it is old.
 */
export function freshness(iso, now = new Date()) {
  const then = iso ? new Date(iso) : null;
  if (!then || Number.isNaN(then.getTime())) return { label: 'never updated', stale: true, days: Infinity };
  const mins = Math.max(0, Math.round((now.getTime() - then.getTime()) / 60000));
  const days = Math.floor(mins / 1440);
  let label;
  if (mins < 2) label = 'just now';
  else if (mins < 60) label = `${mins} minutes ago`;
  else if (mins < 120) label = 'an hour ago';
  else if (mins < 1440) label = `${Math.floor(mins / 60)} hours ago`;
  else if (days === 1) label = 'yesterday';
  else if (days < 30) label = `${days} days ago`;
  else if (days < 60) label = 'a month ago';
  else label = `${Math.floor(days / 30)} months ago`;
  return { label, days, stale: days >= 14 };
}

/* The newest timestamp anything under a project carries. Specs and releases
 * both count — a project whose spec is old but whose releases are daily is
 * not stale. */
export function projectTouchedAt(project, { components = [], releases = [], specs = [], events = [] } = {}) {
  const ids = new Set(componentsOf(components, project.id).map((c) => c.id));
  const stamps = [
    project.createdAt,
    ...specs.filter((s) => s.projectId === project.id).map((s) => s.createdAt),
    ...releases.filter((r) => ids.has(releaseComponentId(r))).map((r) => r.updatedAt || r.createdAt),
    ...events.filter((e) => e.projectId === project.id).map((e) => e.updatedAt || e.createdAt)
  ].filter((s) => typeof s === 'string' && s);
  return stamps.sort().pop() || '';
}

/* ------------------------------------------------------------------ *
 * MIGRATION
 *
 * `apps` becomes `components`, and each app gets a project to live in. There
 * are 33 live releases behind this, so the rules are:
 *
 *   1. Nothing is written until the plan has been shown and accepted.
 *   2. Nothing is deleted. The `apps` documents stay where they are, and
 *      releases keep their `appId`. A rollback is "stop reading components".
 *   3. Running it twice is a no-op, so an interrupted run can be resumed.
 *
 * The name-matching below is a SUGGESTION. It is the only place in this
 * codebase that infers meaning from a string, and it is allowed to because
 * the user reads every row before anything happens.
 * ------------------------------------------------------------------ */

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* 'SCA Android' → { base: 'sca', platform: 'android', display: 'SCA' }
 *
 * `base` is the matching key — lowercased, punctuation gone. `display` is the
 * same words with the user's own casing intact, because a project called "Sca"
 * is a project he will rename by hand the day he sees it. */
export function splitAppName(name) {
  const raw = String(name || '').trim().split(/\s+/).filter(Boolean);
  // One key per raw token, so dropping a token keeps the two lists aligned.
  // norm('2.0') is '2 0', hence the space squeeze — no platform word has digits.
  const keys = raw.map((t) => norm(t).replace(/\s+/g, ''));
  let platform = '';
  const keptRaw = [];
  const keptKeys = [];
  // Only a trailing or leading platform word is a platform marker. "Helper
  // Android Studio" is not an Android build of "Helper Studio".
  raw.forEach((tok, i) => {
    const hit = PLATFORM_WORDS.find(([word]) => word === keys[i]);
    const edge = i === 0 || i === raw.length - 1;
    if (hit && edge && !platform && raw.length > 1) { platform = hit[1]; return; }
    keptRaw.push(tok);
    keptKeys.push(keys[i]);
  });
  return {
    base: keptKeys.join(' ').trim() || norm(name),
    platform,
    display: keptRaw.join(' ').trim() || String(name || '').trim()
  };
}

/* Fold 'v2', 'v 2', '2 0' at the end of a name together, so "Ocufii 2.0" and
 * "Ocufii v2" land in the same project. Conservative: only at the end. */
const foldVersion = (base) => base.replace(/\s+v?\d+(\s+\d+)*$/, '').trim() || base;

export function planMigration({ apps = [], projects = [], components = [], releases = [] } = {}, { today = todayDay() } = {}) {
  const warnings = [];
  const plannedProjects = [];   // { ref, action, id?, name, color }
  const plannedComponents = []; // { ref, appId, name, platform, projectRef, color }
  const plannedReleases = [];   // { id, componentRef, label }

  const projectByName = new Map();
  projects.forEach((p) => {
    projectByName.set(norm(p.name), p);
    projectByName.set(foldVersion(norm(p.name)), p);
  });

  // Components that already exist stop their app from being migrated twice.
  const componentByKey = new Map();
  components.forEach((c) => componentByKey.set(`${c.projectId}::${norm(c.name)}`, c));
  const componentByName = new Map();
  components.forEach((c) => {
    if (!componentByName.has(norm(c.name))) componentByName.set(norm(c.name), c);
  });

  const newProjectByBase = new Map();   // base name → ref of a project this plan creates

  const sorted = [...apps].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));

  sorted.forEach((app, i) => {
    const existingComponent = componentByName.get(norm(app.name));
    if (existingComponent) {
      plannedComponents.push({
        ref: existingComponent.id,
        action: 'reuse',
        appId: app.id,
        name: existingComponent.name,
        platform: existingComponent.platform,
        projectRef: existingComponent.projectId,
        projectName: projectById(projects, existingComponent.projectId)?.name || '(unknown project)',
        color: existingComponent.color
      });
      return;
    }

    const { base, platform, display } = splitAppName(app.name);
    const folded = foldVersion(base);

    // Does a project already cover this?
    let projectRef = '';
    let projectName = '';
    let projectAction = '';
    const hit = projectByName.get(base) || projectByName.get(folded);
    if (hit) {
      projectRef = hit.id;
      projectName = hit.name;
      projectAction = 'reuse';
    } else if (newProjectByBase.has(folded)) {
      const made = newProjectByBase.get(folded);
      projectRef = made.ref;
      projectName = made.name;
      projectAction = 'share';
    } else {
      const ref = `new:project:${folded || `app-${i}`}`;
      // The app's own words, minus the platform suffix, with its own casing.
      // titleCase is only a last resort for a name that normalised to nothing.
      projectName = display || titleCase(folded || base);
      const made = { ref, name: projectName };
      newProjectByBase.set(folded, made);
      plannedProjects.push({
        ref,
        action: 'create',
        name: projectName,
        color: app.color || PROJECT_PALETTE[plannedProjects.length % PROJECT_PALETTE.length],
        createdAt: app.createdAt || today
      });
      projectRef = ref;
      projectAction = 'create';
    }

    const componentName = app.name || titleCase(base) || 'Component';
    const dupKey = `${projectRef}::${norm(componentName)}`;
    if (componentByKey.has(dupKey)) {
      warnings.push(`"${componentName}" already exists under ${projectName} — leaving it alone.`);
      return;
    }
    componentByKey.set(dupKey, { id: `new:component:${app.id}` });

    plannedComponents.push({
      ref: `new:component:${app.id}`,
      action: 'create',
      appId: app.id,
      name: componentName,
      platform: isPlatform(platform) ? platform : (isPlatform(app.platform) ? app.platform : 'other'),
      projectRef,
      projectName,
      projectAction,
      color: app.color || PROJECT_PALETTE[0],
      repoUrl: app.repoUrl || '',
      artifactUrl: app.artifactUrl || '',
      notes: app.notes || '',
      createdAt: app.createdAt || today
    });
  });

  // Releases: point each at the component its app became.
  const refByAppId = new Map();
  plannedComponents.forEach((c) => refByAppId.set(c.appId, c));

  let alreadyLinked = 0;
  let orphaned = 0;
  releases.forEach((r) => {
    // Already pointed at a component that exists: a resumed run skips it.
    if (r.componentId && componentById(components, r.componentId)) {
      alreadyLinked += 1;
      return;
    }
    const target = refByAppId.get(r.appId);
    if (!target) { orphaned += 1; return; }
    plannedReleases.push({
      id: r.id,
      componentRef: target.ref,
      componentName: target.name,
      label: `${r.version || '—'}${r.build ? ` (${r.build})` : ''}`
    });
  });

  if (orphaned) {
    warnings.push(`${orphaned} release${orphaned === 1 ? '' : 's'} point at an app that no longer exists. They stay readable but will not appear on the board until you re-assign them.`);
  }

  const creates = plannedProjects.filter((p) => p.action === 'create').length;
  const compCreates = plannedComponents.filter((c) => c.action === 'create').length;

  return {
    projects: plannedProjects,
    components: plannedComponents,
    releases: plannedReleases,
    warnings,
    counts: {
      projectsCreated: creates,
      projectsReused: plannedComponents.filter((c) => c.projectAction === 'reuse').length,
      componentsCreated: compCreates,
      componentsReused: plannedComponents.filter((c) => c.action === 'reuse').length,
      releasesLinked: plannedReleases.length,
      releasesAlreadyLinked: alreadyLinked,
      releasesOrphaned: orphaned
    },
    // Everything already done means there is nothing to confirm.
    empty: creates === 0 && compCreates === 0 && plannedReleases.length === 0
  };
}

function titleCase(s) {
  return String(s || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/* The plan as an ordered list of writes. Returned rather than executed so the
 * caller owns the Firestore handle and the 500-per-batch limit — and so this
 * stays testable without a database.
 *
 * Order matters: projects before the components that reference them, components
 * before the releases that reference them. The caller resolves each `ref` to a
 * real document id as it goes, which is what `resolve` is threaded through for.
 */
export function migrationWrites(plan, { today = todayDay() } = {}) {
  const writes = [];
  plan.projects.filter((p) => p.action === 'create').forEach((p) => {
    writes.push({
      op: 'create',
      collection: 'projects',
      ref: p.ref,
      data: {
        name: p.name,
        color: p.color,
        client: '',
        status: 'active',
        summary: '',
        order: 0,
        createdAt: p.createdAt || today
      }
    });
  });
  plan.components.filter((c) => c.action === 'create').forEach((c) => {
    writes.push({
      op: 'create',
      collection: 'components',
      ref: c.ref,
      projectRef: c.projectRef,
      data: {
        projectId: c.projectRef,   // resolved by the caller
        name: c.name,
        platform: c.platform,
        repoUrl: c.repoUrl || '',
        artifactUrl: c.artifactUrl || '',
        notes: c.notes || '',
        color: c.color,
        order: 0,
        createdAt: c.createdAt || today
      }
    });
  });
  plan.releases.forEach((r) => {
    writes.push({
      op: 'update',
      collection: 'releases',
      id: r.id,
      componentRef: r.componentRef,
      // appId is deliberately untouched. A release carrying both keys is
      // readable by this client and by one that has not been reloaded.
      data: { componentId: r.componentRef }
    });
  });
  return writes;
}
