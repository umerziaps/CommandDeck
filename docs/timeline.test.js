// Tests for the timeline model.
//
//   npm test       — runs this alongside lib and vault
//
// The date arithmetic is the part most worth pinning down. A timeline that is
// off by a month at a boundary, or that silently drops February, is wrong in a
// way nobody notices until they are trying to remember what happened in a
// quarter that no longer adds up.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isDayString, todayDay, monthOf, monthLabel, dayLabel, addMonths,
  RANGES, rangeByKey, rangeStart,
  blankEvent, normaliseEvent, eventBody, validateEvent, eventOrder,
  filterEvents, groupByMonth, monthlyDensity, countByProject,
  blankProject, normaliseProject, validateProject, projectOrder, projectById,
  attachmentPath, validateAttachment, normaliseAttachment, formatBytes, attachmentKind,
  MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_EVENT, PROJECT_PALETTE, UNASSIGNED
} from './timeline.js';

const TODAY = '2026-10-03';
const ev = (id, date, over = {}) =>
  ({ id, date, title: id, body: '', projectId: '', attachments: [], createdAt: `${date}T09:00:00Z`, ...over });

/* ---------- dates ---------- */

test('day strings are recognised, and near-misses are not', () => {
  assert.equal(isDayString('2026-10-03'), true);
  assert.equal(isDayString('2026-1-3'), false);
  assert.equal(isDayString('03/10/2026'), false);
  assert.equal(isDayString(''), false);
  assert.equal(isDayString(null), false);
});

test('todayDay uses local calendar fields, not a UTC conversion', () => {
  // new Date().toISOString().slice(0,10) is the obvious implementation and it
  // is wrong: late evening anywhere east of UTC reports tomorrow, and the
  // event lands on the wrong day of the timeline.
  const d = new Date(2026, 9, 3, 23, 30);   // local 3 Oct, late
  assert.equal(todayDay(d), '2026-10-03');
  const e = new Date(2026, 0, 1, 0, 15);
  assert.equal(todayDay(e), '2026-01-01');
});

test('addMonths clamps rather than rolling into the next month', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28', '31 Jan + 1 month must not become 3 March');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29', 'and must know about leap years');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonths('2026-10-03', -12), '2025-10-03');
  assert.equal(addMonths('2026-10-03', 0), '2026-10-03');
});

test('addMonths crosses year boundaries in both directions', () => {
  assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
  assert.equal(addMonths('2025-12-15', 1), '2026-01-15');
  assert.equal(addMonths('2026-10-03', -24), '2024-10-03');
});

test('month and day labels use a fixed table, not the locale', () => {
  // en-GB now renders September as "Sept" in some ICU versions; a timeline
  // heading that changes shape between browsers is not acceptable.
  assert.equal(monthLabel('2026-09'), 'September 2026');
  assert.equal(monthLabel('2026-09', { short: true }), 'Sep 2026');
  assert.equal(monthLabel('nonsense'), '');
  assert.equal(dayLabel('2026-10-03'), '3 Oct');
  assert.equal(dayLabel(''), '');
});

/* ---------- ranges ---------- */

test('each range starts where it should', () => {
  assert.equal(rangeStart('3m', TODAY), '2026-07-03');
  assert.equal(rangeStart('6m', TODAY), '2026-04-03');
  assert.equal(rangeStart('1y', TODAY), '2025-10-03');
  assert.equal(rangeStart('2y', TODAY), '2024-10-03');
  assert.equal(rangeStart('all', TODAY), '', 'all time has no start');
});

test('an unknown range key falls back rather than throwing', () => {
  assert.equal(rangeByKey('nope').key, '6m');
  assert.equal(RANGES.some((r) => r.key === 'all'), true);
});

/* ---------- filtering ---------- */

test('the range window includes its first day and excludes the day before', () => {
  const events = [ev('a', '2026-07-03'), ev('b', '2026-07-02')];
  const got = filterEvents(events, { rangeKey: '3m', today: TODAY }).map((e) => e.id);
  assert.deepEqual(got, ['a'], 'the boundary day itself must be inside the window');
});

test('all-time keeps everything, however old', () => {
  const events = [ev('old', '2019-01-01'), ev('new', TODAY)];
  assert.equal(filterEvents(events, { rangeKey: 'all', today: TODAY }).length, 2);
});

test('filtering by project, and by unassigned', () => {
  const events = [ev('a', TODAY, { projectId: 'p1' }), ev('b', TODAY), ev('c', TODAY, { projectId: 'p2' })];
  assert.deepEqual(filterEvents(events, { rangeKey: 'all', projectId: 'p1', today: TODAY }).map((e) => e.id), ['a']);
  assert.deepEqual(filterEvents(events, { rangeKey: 'all', projectId: UNASSIGNED, today: TODAY }).map((e) => e.id), ['b']);
  assert.equal(filterEvents(events, { rangeKey: 'all', projectId: '', today: TODAY }).length, 3);
});

test('search covers the title and the detail', () => {
  const events = [
    ev('a', TODAY, { title: 'Client delivered SDS specs' }),
    ev('b', TODAY, { title: 'Release 2.1', body: 'published to the staging fleet' })
  ];
  assert.deepEqual(filterEvents(events, { rangeKey: 'all', query: 'sds', today: TODAY }).map((e) => e.id), ['a']);
  assert.deepEqual(filterEvents(events, { rangeKey: 'all', query: 'STAGING', today: TODAY }).map((e) => e.id), ['b']);
});

test('filters combine rather than replacing one another', () => {
  const events = [
    ev('a', '2026-09-01', { projectId: 'p1', title: 'spec' }),
    ev('b', '2026-09-01', { projectId: 'p2', title: 'spec' }),
    ev('c', '2019-09-01', { projectId: 'p1', title: 'spec' })
  ];
  const got = filterEvents(events, { rangeKey: '3m', projectId: 'p1', query: 'spec', today: TODAY });
  assert.deepEqual(got.map((e) => e.id), ['a']);
});

/* ---------- ordering and grouping ---------- */

test('a timeline reads newest first', () => {
  const got = [ev('a', '2026-01-01'), ev('c', '2026-10-01'), ev('b', '2026-05-01')]
    .sort(eventOrder).map((e) => e.id);
  assert.deepEqual(got, ['c', 'b', 'a']);
});

test('two events on the same day fall back to when they were recorded', () => {
  const a = ev('a', '2026-10-01', { createdAt: '2026-10-01T09:00:00Z' });
  const b = ev('b', '2026-10-01', { createdAt: '2026-10-01T17:00:00Z' });
  assert.deepEqual([a, b].sort(eventOrder).map((e) => e.id), ['b', 'a']);
});

test('grouping buckets by month, newest month first', () => {
  const groups = groupByMonth([ev('a', '2026-08-02'), ev('b', '2026-10-01'), ev('c', '2026-08-30')]);
  assert.deepEqual(groups.map((g) => g.month), ['2026-10', '2026-08']);
  assert.deepEqual(groups[1].events.map((e) => e.id), ['c', 'a']);
});

test('grouping drops events with no usable date instead of making a phantom month', () => {
  const groups = groupByMonth([ev('a', '2026-10-01'), ev('bad', '')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].events.length, 1);
});

test('grouping never loses an event', () => {
  const events = Array.from({ length: 30 }, (_, i) =>
    ev(`e${i}`, `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`));
  const total = groupByMonth(events).reduce((n, g) => n + g.events.length, 0);
  assert.equal(total, 30);
});

/* ---------- the density strip ---------- */

test('the strip includes months with nothing in them', () => {
  // The empty months ARE the information. A strip built only from months that
  // have events shows an evenly busy year no matter what actually happened.
  const bars = monthlyDensity([ev('a', '2026-10-01'), ev('b', '2026-08-01')],
    { rangeKey: '3m', today: TODAY });
  assert.deepEqual(bars.map((b) => `${b.month}:${b.count}`),
    ['2026-07:0', '2026-08:1', '2026-09:0', '2026-10:1']);
});

test('the strip spans the whole window even when nothing happened in it', () => {
  const bars = monthlyDensity([], { rangeKey: '6m', today: TODAY });
  assert.equal(bars.length, 7, 'six months back, inclusive of both ends');
  assert.equal(bars.every((b) => b.count === 0), true);
});

test('a year window produces thirteen bars, not twelve', () => {
  const bars = monthlyDensity([], { rangeKey: '1y', today: TODAY });
  assert.equal(bars[0].month, '2025-10');
  assert.equal(bars.at(-1).month, '2026-10');
  assert.equal(bars.length, 13);
});

test('all-time starts at the earliest event, not at the dawn of time', () => {
  const bars = monthlyDensity([ev('a', '2026-08-01')], { rangeKey: 'all', today: TODAY });
  assert.equal(bars[0].month, '2026-08');
  assert.equal(bars.at(-1).month, '2026-10');
});

test('all-time with no events produces nothing rather than an empty axis', () => {
  assert.deepEqual(monthlyDensity([], { rangeKey: 'all', today: TODAY }), []);
});

test('the strip is bounded — a stray old date cannot spin the loop', () => {
  const bars = monthlyDensity([ev('ancient', '1900-01-01')], { rangeKey: 'all', today: TODAY });
  assert.ok(bars.length <= 600, `expected the loop to be capped, got ${bars.length}`);
});

test('counts per project include the empty ones and the unassigned bucket', () => {
  const projects = [{ id: 'p1' }, { id: 'p2' }];
  const counts = countByProject([ev('a', TODAY, { projectId: 'p1' }), ev('b', TODAY)], projects);
  assert.equal(counts.p1, 1);
  assert.equal(counts.p2, 0);
  assert.equal(counts[UNASSIGNED], 1);
});

test('an event pointing at a deleted project counts as unassigned, not as a phantom', () => {
  const counts = countByProject([ev('a', TODAY, { projectId: 'ghost' })], [{ id: 'p1' }]);
  assert.equal(counts[UNASSIGNED], 1);
  assert.equal(counts.ghost, undefined);
});

/* ---------- the event model ---------- */

test('a new event defaults to today and nothing else', () => {
  const e = blankEvent(TODAY);
  assert.equal(e.date, TODAY);
  assert.deepEqual(e.attachments, []);
});

test('normaliseEvent coerces junk rather than trusting the document', () => {
  const e = normaliseEvent('e1', { title: 42, date: 'not a date', body: null, attachments: 'nope' });
  assert.equal(e.title, '');
  assert.equal(e.date, '');
  assert.equal(e.body, '');
  assert.deepEqual(e.attachments, []);
});

test('an event needs a title and a real date', () => {
  assert.equal(validateEvent({ title: '', date: TODAY }).ok, false);
  assert.equal(validateEvent({ title: 'x', date: '' }).ok, false);
  assert.equal(validateEvent({ title: 'x', date: 'last tuesday' }).ok, false);
  assert.equal(validateEvent({ title: 'x', date: TODAY }).ok, true);
});

test('eventBody keeps exactly the stored fields', () => {
  const body = eventBody({ ...blankEvent(TODAY), title: ' spaced ', secret: 'no' });
  assert.deepEqual(Object.keys(body).sort(), ['attachments', 'body', 'date', 'projectId', 'title']);
  assert.equal(body.title, 'spaced', 'titles are trimmed before storage');
});

/* ---------- projects ---------- */

test('projects walk the palette and wrap', () => {
  assert.equal(blankProject(0).color, PROJECT_PALETTE[0]);
  assert.equal(blankProject(PROJECT_PALETTE.length).color, PROJECT_PALETTE[0]);
});

test('a malformed project colour is replaced, never written into a style attribute', () => {
  assert.equal(normaliseProject('p1', { name: 'X', color: 'red;background:url(x)' }).color, PROJECT_PALETTE[0]);
  assert.equal(normaliseProject('p1', { name: 'X', color: '#A1B2C3' }).color, '#A1B2C3');
});

test('project names are required and unique, case-insensitively', () => {
  const existing = [{ id: 'p1', name: 'Ocufii 2.0' }];
  assert.equal(validateProject({ name: '  ' }, existing).ok, false);
  assert.equal(validateProject({ name: 'ocufii 2.0' }, existing).ok, false);
  assert.equal(validateProject({ name: 'Ocufii 2.0' }, existing, 'p1').ok, true);
  assert.equal(validateProject({ name: 'FLP' }, existing).ok, true);
});

test('projects keep creation order so renaming one does not reshuffle the bar', () => {
  const ps = [{ id: 'b', name: 'A', createdAt: '2' }, { id: 'a', name: 'Z', createdAt: '1' }];
  assert.deepEqual([...ps].sort(projectOrder).map((p) => p.id), ['a', 'b']);
  assert.equal(projectById(ps, 'nope'), null);
});

/* ---------- attachments ---------- */

test('the storage path cannot be climbed out of', () => {
  const p = attachmentPath('u1', 'e1', 'a1', '../../../etc/passwd');
  assert.ok(p.startsWith('users/u1/events/e1/'), p);
  assert.equal(p.includes('/..'), false);
  assert.equal(p.split('/').length, 5, 'a crafted name must not add path segments');
});

test('two files with the same name cannot collide', () => {
  assert.notEqual(
    attachmentPath('u1', 'e1', 'a1', 'scan.pdf'),
    attachmentPath('u1', 'e1', 'a2', 'scan.pdf')
  );
});

test('a very long filename is truncated rather than rejected', () => {
  const p = attachmentPath('u1', 'e1', 'a1', `${'x'.repeat(400)}.pdf`);
  assert.ok(p.length < 200, `path was ${p.length} characters`);
  assert.ok(p.endsWith('.pdf'), 'the extension is the end worth keeping');
});

test('attachment limits are enforced before an upload starts', () => {
  assert.equal(validateAttachment({ name: 'a.pdf', size: 1024 }, []).ok, true);
  assert.equal(validateAttachment({ name: 'a.pdf', size: MAX_ATTACHMENT_BYTES + 1 }, []).ok, false);
  assert.equal(validateAttachment({ name: 'a.pdf', size: 0 }, []).ok, false);
  assert.equal(validateAttachment(null, []).ok, false);
  const full = Array.from({ length: MAX_ATTACHMENTS_PER_EVENT }, (_, i) => ({ id: `a${i}` }));
  assert.equal(validateAttachment({ name: 'a.pdf', size: 10 }, full).ok, false);
});

test('an attachment with no path is dropped — it would render as an unclickable chip', () => {
  assert.equal(normaliseAttachment({ name: 'x.pdf' }), null);
  assert.equal(normaliseAttachment(null), null);
  assert.equal(normaliseAttachment({ path: 'users/u/e/a-x.pdf' }).name, 'attachment');
});

test('byte sizes read the way a person would say them', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(10 * 1024 * 1024), '10 MB');
});

test('the attachment icon is chosen by extension first, because browsers lie about type', () => {
  assert.equal(attachmentKind({ name: 'spec.PDF', type: 'application/octet-stream' }), 'pdf');
  assert.equal(attachmentKind({ name: 'thread.eml', type: '' }), 'email');
  assert.equal(attachmentKind({ name: 'shot.png', type: '' }), 'image');
  assert.equal(attachmentKind({ name: 'notes', type: 'image/png' }), 'image', 'type is the fallback, not ignored');
  assert.equal(attachmentKind({ name: 'thing.xyz', type: '' }), 'file');
});
