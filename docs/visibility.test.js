// docs/visibility.test.js — run with `npm test`.
//
// The migration tests carry the weight here. There are 33 live releases behind
// planMigration, so every case it can meet is pinned: a clean first run, a
// resumed run, apps that collapse into one project, apps whose project already
// exists, a release whose app is gone, and running the whole thing twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLATFORMS, platformLabel, isPlatform,
  PROJECT_STATUSES, projectStatusLabel,
  RELEASE_STATUSES, releaseStatus, releaseStatusLabel, releaseStatusTone,
  isPlanned, isUpcoming, isBlocked, isLive,
  blankProject, normaliseProject, projectBody, validateProject, projectOrder, projectBoardOrder, projectById, nextProjectOrder,
  blankComponent, normaliseComponent, componentBody, validateComponent, componentOrder,
  componentById, componentsOf, nextComponentOrder, releaseComponentId, releasesOf,
  normaliseSpec, specBody, validateSpec, specOrder, specsOf, currentSpec, nextSpecVersion, specSlot,
  diffSpecs, diffHunks,
  projectRollup, liveMatrix, freshness, projectTouchedAt,
  splitAppName, planMigration, migrationWrites,
  MAX_SPEC_HTML
} from './visibility.js';

/* ---------- taxonomy ---------- */

test('platforms cover the four things he actually ships, plus the rest', () => {
  ['ios', 'android', 'web', 'portal', 'backend', 'other'].forEach((k) => {
    assert.equal(isPlatform(k), true, k);
  });
  assert.equal(platformLabel('portal'), 'Web Portal');
  assert.equal(platformLabel('web'), 'Website');
  assert.equal(platformLabel('nonsense'), 'Other');
  assert.equal(PLATFORMS.every((p) => p.group), true);
});

test('project statuses resolve, and nonsense falls back to Active', () => {
  assert.equal(projectStatusLabel('paused'), 'Paused');
  assert.equal(projectStatusLabel('nope'), 'Active');
  assert.equal(PROJECT_STATUSES.length, 4);
});

/* ---------- release status ---------- */

test('a release written before status existed still reads correctly', () => {
  assert.equal(releaseStatus({ production: true }), 'live');
  assert.equal(releaseStatus({ production: false }), 'released');
  assert.equal(releaseStatus({ production: false, planned: true }), 'planned');
});

test('a stored status wins over the inference', () => {
  assert.equal(releaseStatus({ production: false, status: 'qa' }), 'qa');
  assert.equal(releaseStatus({ production: false, planned: true, status: 'building' }), 'building');
});

test('a blocker shows as blocked until it actually ships', () => {
  assert.equal(releaseStatus({ production: false, status: 'qa', blocker: 'waiting on certs' }), 'blocked');
  // Shipped wins: a stale blocker note cannot un-ship a release.
  assert.equal(releaseStatus({ production: true, blocker: 'waiting on certs' }), 'live');
});

test('a prodDate alone never implies production', () => {
  assert.equal(releaseStatus({ production: false, prodDate: '2026-05-01' }), 'released');
  assert.equal(isLive({ production: false, prodDate: '2026-05-01' }), false);
});

test('every status has a label and a tone', () => {
  RELEASE_STATUSES.forEach((s) => {
    assert.equal(releaseStatusLabel(s.key), s.label);
    assert.equal(releaseStatusTone(s.key), s.tone);
  });
  assert.equal(releaseStatusLabel('garbage'), 'Released');
});

test('planned, upcoming and blocked are three different questions', () => {
  const moving = { planned: true, status: 'building' };
  const stuck = { planned: true, status: 'building', blocker: 'client sign-off' };
  const shipped = { planned: true, production: true };

  assert.equal(isPlanned(moving), true);
  assert.equal(isUpcoming(moving), true);
  assert.equal(isBlocked(moving), false);

  // Blocked work is still ahead of us — it just is not moving.
  assert.equal(isPlanned(stuck), true);
  assert.equal(isUpcoming(stuck), false);
  assert.equal(isBlocked(stuck), true);

  // A release that shipped is not planned any more, whatever the flag says.
  assert.equal(isPlanned(shipped), false);
  assert.equal(isBlocked(shipped), false);
});

/* ---------- projects ---------- */

test('normaliseProject repairs every field it is handed badly', () => {
  const p = normaliseProject('p1', { name: 'X', color: 'blue', status: 'nope', order: 'x' });
  assert.equal(p.color.startsWith('#'), true);
  assert.equal(p.status, 'active');
  assert.equal(p.order, 0);
  assert.equal(p.client, '');
});

test('normaliseProject keeps a timeline project readable unchanged', () => {
  // The timeline wrote {name, color, createdAt} and nothing else.
  const p = normaliseProject('p1', { name: 'Ocufii', color: '#5EE6C5', createdAt: '2026-01-01T00:00:00Z' });
  assert.equal(p.name, 'Ocufii');
  assert.equal(p.status, 'active');
  assert.equal(p.summary, '');
});

test('projectBody never carries createdAt, so an edit cannot rewrite it', () => {
  const body = projectBody({ name: ' X ', createdAt: '2020-01-01', id: 'zz' });
  assert.equal('createdAt' in body, false);
  assert.equal('id' in body, false);
  assert.equal(body.name, 'X');
});

test('validateProject rejects blanks, clashes and overlong summaries', () => {
  assert.equal(validateProject({ name: '' }).ok, false);
  assert.equal(validateProject({ name: 'x'.repeat(81) }).ok, false);
  assert.equal(validateProject({ name: 'X', summary: 'y'.repeat(301) }).ok, false);
  const existing = [{ id: 'a', name: 'Ocufii' }];
  assert.equal(validateProject({ name: 'ocufii' }, existing).ok, false);
  assert.equal(validateProject({ name: 'ocufii' }, existing, 'a').ok, true);
});

test('projectOrder keeps the creation order the timeline chips have always had', () => {
  const ps = [
    { id: '1', name: 'Zeta', status: 'active', order: 0, createdAt: '2026-01-01' },
    { id: '2', name: 'Alpha', status: 'archived', order: 0, createdAt: '2026-02-01' },
    { id: '3', name: 'Beta', status: 'active', order: 0, createdAt: '2026-03-01' }
  ];
  assert.deepEqual([...ps].sort(projectOrder).map((p) => p.name), ['Zeta', 'Alpha', 'Beta']);
});

test('the board sorts active work first, then falls back to creation order', () => {
  const ps = [
    { id: '1', name: 'Zeta', status: 'active', order: 0, createdAt: '2026-03-01' },
    { id: '2', name: 'Alpha', status: 'archived', order: 0, createdAt: '2026-01-01' },
    { id: '3', name: 'Beta', status: 'active', order: 0, createdAt: '2026-02-01' },
    { id: '4', name: 'Gamma', status: 'shipped', order: 0, createdAt: '2026-01-15' }
  ];
  assert.deepEqual([...ps].sort(projectBoardOrder).map((p) => p.name),
    ['Beta', 'Zeta', 'Gamma', 'Alpha']);
});

test('a dragged position beats both orderings', () => {
  const ps = [
    { id: '1', name: 'Zeta', status: 'archived', order: 1, createdAt: '2026-03-01' },
    { id: '2', name: 'Alpha', status: 'active', order: 2, createdAt: '2026-01-01' }
  ];
  assert.deepEqual([...ps].sort(projectBoardOrder).map((p) => p.name), ['Zeta', 'Alpha']);
  assert.deepEqual([...ps].sort(projectOrder).map((p) => p.name), ['Zeta', 'Alpha']);
});

test('nextProjectOrder stays 0 until something has been dragged', () => {
  assert.equal(nextProjectOrder([{ order: 0 }, { order: 0 }]), 0);
  assert.equal(nextProjectOrder([{ order: 0 }, { order: 4 }]), 5);
  assert.equal(nextProjectOrder([]), 0);
  assert.equal(projectById([{ id: 'a' }], 'b'), null);
});

test('blankProject rotates the palette', () => {
  assert.notEqual(blankProject(0).color, blankProject(1).color);
  assert.equal(blankProject(0).status, 'active');
});

/* ---------- components ---------- */

test('normaliseComponent defaults an unknown platform to other', () => {
  const c = normaliseComponent('c1', { name: 'X', platform: 'watchos', projectId: 'p1' });
  assert.equal(c.platform, 'other');
  assert.equal(c.projectId, 'p1');
});

test('a component needs a project', () => {
  assert.equal(validateComponent({ name: 'iOS', projectId: '' }).ok, false);
  assert.equal(validateComponent({ name: 'iOS', projectId: 'p1' }).ok, true);
});

test('component names collide only inside the same project', () => {
  const existing = [{ id: 'c1', projectId: 'p1', name: 'iOS' }];
  assert.equal(validateComponent({ name: 'iOS', projectId: 'p1' }, existing).ok, false);
  assert.equal(validateComponent({ name: 'iOS', projectId: 'p2' }, existing).ok, true);
  assert.equal(validateComponent({ name: 'iOS', projectId: 'p1' }, existing, 'c1').ok, true);
});

test('components sort iOS, Android, Website, Portal before Backend', () => {
  const cs = [
    { id: '1', name: 'API', platform: 'backend', order: 0 },
    { id: '2', name: 'Portal', platform: 'portal', order: 0 },
    { id: '3', name: 'App', platform: 'ios', order: 0 }
  ];
  assert.deepEqual([...cs].sort(componentOrder).map((c) => c.platform), ['ios', 'portal', 'backend']);
});

test('componentsOf filters by project and nextComponentOrder is per project', () => {
  const cs = [
    { id: '1', projectId: 'p1', name: 'A', platform: 'ios', order: 0 },
    { id: '2', projectId: 'p2', name: 'B', platform: 'ios', order: 7 }
  ];
  assert.deepEqual(componentsOf(cs, 'p1').map((c) => c.id), ['1']);
  assert.equal(nextComponentOrder(cs, 'p1'), 0);
  assert.equal(nextComponentOrder(cs, 'p2'), 8);
  assert.equal(componentById(cs, '9'), null);
  assert.equal(componentBody({ name: ' A ', projectId: 'p1' }).name, 'A');
  assert.equal(blankComponent('p1', 0).projectId, 'p1');
});

test('releaseComponentId accepts a release written either way', () => {
  assert.equal(releaseComponentId({ componentId: 'c1', appId: 'a1' }), 'c1');
  assert.equal(releaseComponentId({ appId: 'a1' }), 'a1');     // pre-migration
  assert.equal(releaseComponentId({}), '');
  const rs = [{ appId: 'a1' }, { componentId: 'a1' }, { appId: 'a2' }];
  assert.equal(releasesOf(rs, 'a1').length, 2);
});

/* ---------- specs ---------- */

test('spec versions count per slot, not per project', () => {
  const specs = [
    { id: '1', projectId: 'p1', componentId: '', version: 1, createdAt: 'a' },
    { id: '2', projectId: 'p1', componentId: '', version: 2, createdAt: 'b' },
    { id: '3', projectId: 'p1', componentId: 'c1', version: 1, createdAt: 'c' }
  ];
  assert.equal(nextSpecVersion(specs, 'p1', ''), 3);
  assert.equal(nextSpecVersion(specs, 'p1', 'c1'), 2);
  assert.equal(nextSpecVersion(specs, 'p2', ''), 1);
  assert.equal(currentSpec(specs, 'p1', '').id, '2');
  assert.equal(currentSpec(specs, 'p9', ''), null);
  assert.equal(specsOf(specs, 'p1', '').length, 2);
  assert.equal(specSlot({ projectId: 'p1' }), 'p1::');
});

test('specOrder puts the newest version first', () => {
  const ss = [{ version: 1, createdAt: 'a' }, { version: 3, createdAt: 'c' }, { version: 2, createdAt: 'b' }];
  assert.deepEqual([...ss].sort(specOrder).map((s) => s.version), [3, 2, 1]);
});

test('validateSpec refuses an empty document and an oversized one', () => {
  assert.equal(validateSpec({ projectId: '', title: 'T', html: '<p>x</p>' }).ok, false);
  assert.equal(validateSpec({ projectId: 'p', title: '', html: '<p>x</p>' }).ok, false);
  assert.equal(validateSpec({ projectId: 'p', title: 'T', html: '   ' }).ok, false);
  assert.equal(validateSpec({ projectId: 'p', title: 'T', html: '<p>x</p>' }).ok, true);
  const big = validateSpec({ projectId: 'p', title: 'T', html: 'x'.repeat(MAX_SPEC_HTML + 1) });
  assert.equal(big.ok, false);
  assert.match(big.error, /too large/);
});

test('normaliseSpec drops non-string outline entries and defaults version to 1', () => {
  const s = normaliseSpec('s1', { projectId: 'p', outline: ['A', 3, null, 'B'], version: 0 });
  assert.deepEqual(s.outline, ['A', 'B']);
  assert.equal(s.version, 1);
  assert.equal(specBody(s).outline.length, 2);
});

/* ---------- spec diff ---------- */

test('an unchanged re-upload reports identical', () => {
  const a = { text: 'One\nTwo\nThree' };
  const d = diffSpecs(a, { text: 'One\nTwo\nThree' });
  assert.equal(d.identical, true);
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
  assert.equal(d.unchanged, 3);
});

test('a changed clause shows as one removal and one addition, in place', () => {
  const d = diffSpecs(
    { text: 'Intro\nThe door shall unlock in 2 seconds.\nOutro' },
    { text: 'Intro\nThe door shall unlock in 5 seconds.\nOutro' }
  );
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.deepEqual(d.rows.map((r) => r.kind), ['same', 'removed', 'added', 'same']);
});

test('a new section is pure addition, with the surrounding text untouched', () => {
  const d = diffSpecs(
    { text: 'A\nB' },
    { text: 'A\nNew section\nMore detail\nB' }
  );
  assert.equal(d.added, 2);
  assert.equal(d.removed, 0);
});

test('blank lines and trailing whitespace are not changes', () => {
  const d = diffSpecs({ text: 'A\n\n  B  \n' }, { text: 'A\nB' });
  assert.equal(d.identical, true);
});

test('a diff against nothing is all additions', () => {
  const d = diffSpecs(null, { text: 'A\nB' });
  assert.equal(d.added, 2);
  assert.equal(d.removed, 0);
});

test('a huge spec falls back to a set diff rather than hanging', () => {
  const a = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join('\n');
  const b = `${a}\nline new`;
  const d = diffSpecs({ text: a }, { text: b });
  assert.equal(d.truncated, true);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 0);
});

test('the LCS path handles the largest spec it accepts in reasonable time', () => {
  const a = Array.from({ length: 1200 }, (_, i) => `para ${i}`).join('\n');
  const b = Array.from({ length: 1200 }, (_, i) => (i === 600 ? 'para CHANGED' : `para ${i}`)).join('\n');
  const t0 = Date.now();
  const d = diffSpecs({ text: a }, { text: b });
  assert.equal(d.truncated, false);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.equal(Date.now() - t0 < 10_000, true, 'LCS at the cap should not take ten seconds');
});

test('diffHunks collapses the unchanged middle and marks the gap', () => {
  const d = diffSpecs(
    { text: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].join('\n') },
    { text: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'CHANGED'].join('\n') }
  );
  const hunks = diffHunks(d, 1);
  assert.equal(hunks.some((h) => h.kind === 'gap'), true);
  // Every change survives the collapse.
  assert.equal(hunks.filter((h) => h.kind === 'added').length, 1);
  assert.equal(hunks.filter((h) => h.kind === 'removed').length, 1);
  assert.equal(hunks.length < d.rows.length, true);
});

test('diffHunks on an identical pair shows nothing but the gap', () => {
  const d = diffSpecs({ text: 'A\nB\nC' }, { text: 'A\nB\nC' });
  assert.deepEqual(diffHunks(d, 1), []);
});

/* ---------- roll-up ---------- */

const fixture = () => ({
  projects: [{ id: 'p1', name: 'Ocufii', status: 'active', color: '#5EE6C5', createdAt: '2026-01-01T00:00:00Z' }],
  components: [
    { id: 'c1', projectId: 'p1', name: 'Ocufii iOS', platform: 'ios', order: 0 },
    { id: 'c2', projectId: 'p1', name: 'Ocufii Android', platform: 'android', order: 0 }
  ],
  releases: [
    { id: 'r1', componentId: 'c1', version: 'v1.0', env: 'Production', production: true, prodDate: '2026-03-01', updatedAt: '2026-03-01T00:00:00Z' },
    { id: 'r2', componentId: 'c1', version: 'v1.1', env: 'Sqa', production: false, planned: false },
    { id: 'r3', componentId: 'c2', version: 'v2.0', planned: true, targetDate: '2026-12-01' },
    { id: 'r4', componentId: 'c2', version: 'v1.9', planned: true, targetDate: '2026-01-05', blocker: 'waiting on client sign-off' }
  ],
  specs: [
    { id: 's1', projectId: 'p1', componentId: '', version: 2, title: 'Ocufii Platform', createdAt: '2026-06-01T00:00:00Z' },
    { id: 's0', projectId: 'p1', componentId: '', version: 1, title: 'Ocufii Platform', createdAt: '2026-04-01T00:00:00Z' }
  ],
  events: [{ id: 'e1', projectId: 'p1', date: '2026-02-01', createdAt: '2026-02-01T00:00:00Z' }]
});

test('a project roll-up answers the five board questions in one pass', () => {
  const f = fixture();
  const r = projectRollup(f.projects[0], { ...f, today: '2026-08-22' });
  assert.equal(r.components.length, 2);
  assert.equal(r.releases, 2, 'builds recorded, not rows — the two planned ones are counted separately');
  assert.equal(r.plannedCount, 2);
  assert.equal(r.liveCount, 1);
  assert.equal(r.lastShipped, '2026-03-01');
  assert.equal(r.spec.version, 2);
  assert.equal(r.specCount, 2);
  assert.equal(r.eventCount, 1);
  // r4 carries a blocker, so it is listed once — as blocked, not as planned.
  assert.equal(r.blocked.length, 1);
  assert.deepEqual(r.planned.map((x) => x.id), ['r3']);
});

test('an overdue planned release is flagged against the date it is given', () => {
  const f = fixture();
  // r4 is blocked and already past its target; r3 is not due until December.
  const mid = projectRollup(f.projects[0], { ...f, today: '2026-08-22' });
  assert.deepEqual(mid.overdue.map((x) => x.id), ['r4'],
    'a blocker is a reason, not an extension — blocked work can be overdue');
  const late = projectRollup(f.projects[0], { ...f, today: '2027-01-01' });
  assert.deepEqual(late.overdue.map((x) => x.id), ['r4', 'r3']);
  const early = projectRollup(f.projects[0], { ...f, today: '2026-01-01' });
  assert.equal(early.overdue.length, 0);
});

test('per-component roll-up names what is live and what is next', () => {
  const f = fixture();
  const r = projectRollup(f.projects[0], { ...f, today: '2026-08-22' });
  const ios = r.perComponent.find((x) => x.component.id === 'c1');
  const android = r.perComponent.find((x) => x.component.id === 'c2');
  assert.equal(ios.inProduction.version, 'v1.0');
  assert.equal(ios.nextPlanned, null);
  assert.equal(ios.total, 2, 'both iOS rows are real builds');
  assert.equal(android.inProduction, null);
  assert.equal(android.blocked, 1);
  assert.equal(android.total, 0, 'two planned releases are not two builds');
  assert.equal(android.plannedCount, 2);
  // r4 is blocked and targeted earlier than r3, so it is what is next —
  // "next planned: none" next to a visible blocker would be a lie.
  assert.equal(android.nextPlanned.id, 'r4');
});

test('a project with nothing in it rolls up to zeroes, not to a crash', () => {
  const r = projectRollup({ id: 'pX', name: 'Empty' }, {});
  assert.equal(r.components.length, 0);
  assert.equal(r.releases, 0);
  assert.equal(r.spec, null);
  assert.equal(r.lastShipped, '');
});

test('liveMatrix gives the newest production build per component per environment', () => {
  const f = fixture();
  const extra = [...f.releases,
    { id: 'r5', componentId: 'c1', version: 'v1.2', env: 'Production', production: true, prodDate: '2026-07-01' },
    { id: 'r6', componentId: 'c2', version: 'v1.0', env: 'Demo', production: true, prodDate: '2026-02-01' }];
  const m = liveMatrix(f.components, extra);
  assert.deepEqual(m.envs, ['Demo', 'Production']);
  const ios = m.rows.find((r) => r.component.id === 'c1');
  assert.equal(ios.cells.find((c) => c.env === 'Production').release.version, 'v1.2');
  assert.equal(ios.cells.find((c) => c.env === 'Demo').release, null);
});

test('a production release with no environment lands under Production', () => {
  const m = liveMatrix([{ id: 'c1', name: 'X' }], [{ id: 'r', componentId: 'c1', env: '  ', production: true, prodDate: '2026-01-01' }]);
  assert.deepEqual(m.envs, ['Production']);
});

/* ---------- freshness ---------- */

test('freshness reads in human time and turns stale at a fortnight', () => {
  const now = new Date('2026-08-22T12:00:00Z');
  const at = (iso) => freshness(iso, now);
  assert.equal(at('2026-08-22T11:59:30Z').label, 'just now');
  assert.equal(at('2026-08-22T11:30:00Z').label, '30 minutes ago');
  assert.equal(at('2026-08-22T10:30:00Z').label, 'an hour ago');
  assert.equal(at('2026-08-22T04:00:00Z').label, '8 hours ago');
  assert.equal(at('2026-08-21T11:00:00Z').label, 'yesterday');
  assert.equal(at('2026-08-15T12:00:00Z').label, '7 days ago');
  assert.equal(at('2026-08-15T12:00:00Z').stale, false);
  assert.equal(at('2026-08-01T12:00:00Z').stale, true);
  assert.equal(at('2026-07-13T12:00:00Z').label, 'a month ago');   // 40 days
  assert.equal(at('2026-06-01T12:00:00Z').label, '2 months ago');  // 82 days
  assert.equal(at('2026-01-01T12:00:00Z').label, '7 months ago');
  assert.equal(at('').label, 'never updated');
  assert.equal(at('not a date').stale, true);
});

test('projectTouchedAt takes the newest stamp from anything under the project', () => {
  const f = fixture();
  assert.equal(projectTouchedAt(f.projects[0], f), '2026-06-01T00:00:00Z');
  // A release updated later wins over the spec.
  const bumped = { ...f, releases: [{ ...f.releases[0], updatedAt: '2026-09-09T00:00:00Z' }] };
  assert.equal(projectTouchedAt(f.projects[0], bumped), '2026-09-09T00:00:00Z');
  assert.equal(projectTouchedAt({ id: 'pX' }, {}), '');
});

/* ---------- name splitting ---------- */

test('splitAppName pulls the platform off the end', () => {
  assert.deepEqual(splitAppName('Ocufii Android'), { base: 'ocufii', platform: 'android', display: 'Ocufii' });
  assert.deepEqual(splitAppName('Ocufii iOS'), { base: 'ocufii', platform: 'ios', display: 'Ocufii' });
  assert.deepEqual(splitAppName('SCA Web Portal'), { base: 'sca web', platform: 'portal', display: 'SCA Web' });
  assert.deepEqual(splitAppName('Ocufii'), { base: 'ocufii', platform: '', display: 'Ocufii' });
});

test('splitAppName keeps his casing, so SCA does not become Sca', () => {
  assert.equal(splitAppName('SCA Android').display, 'SCA');
  assert.equal(splitAppName('Ocufii 2.0 Android').display, 'Ocufii 2.0');
  assert.equal(splitAppName('Ocufii 2.0 Android').base, 'ocufii 20');
});

test('splitAppName does not strip a platform word from the middle of a name', () => {
  // "Helper Android Studio" is not an Android build of "Helper Studio"…
  assert.equal(splitAppName('Helper Android Studio').platform, '');
  // …but a leading marker on a two-word name is still a marker.
  assert.deepEqual(splitAppName('Android Ocufii'), { base: 'ocufii', platform: 'android', display: 'Ocufii' });
});

test('a one-word name is never read as nothing but a platform', () => {
  assert.deepEqual(splitAppName('Android'), { base: 'android', platform: '', display: 'Android' });
});

/* ---------- migration ---------- */

const apps = [
  { id: 'a1', name: 'Ocufii Android', platform: 'android', color: '#5EE6C5', repoUrl: 'git@x', artifactUrl: '', notes: 'n', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'a2', name: 'Ocufii iOS', platform: 'ios', color: '#7C89F0', repoUrl: '', artifactUrl: '', notes: '', createdAt: '2026-01-02T00:00:00Z' },
  { id: 'a3', name: 'SCA Android', platform: 'android', color: '#F0B45E', repoUrl: '', artifactUrl: '', notes: '', createdAt: '2026-01-03T00:00:00Z' }
];

const releases = [
  { id: 'r1', appId: 'a1', version: 'v1.3.0', build: '169' },
  { id: 'r2', appId: 'a1', version: 'v1.3.1', build: '170' },
  { id: 'r3', appId: 'a2', version: 'v1.0.0', build: '12' },
  { id: 'r4', appId: 'a3', version: 'v0.9', build: '3' }
];

test('two platform builds of one product collapse into one project', () => {
  const plan = planMigration({ apps, releases });
  assert.deepEqual(plan.projects.map((p) => p.name).sort(), ['Ocufii', 'SCA']);
  assert.equal(plan.counts.projectsCreated, 2);
  assert.equal(plan.counts.componentsCreated, 3);
  const ocufii = plan.projects.find((p) => p.name === 'Ocufii');
  const under = plan.components.filter((c) => c.projectRef === ocufii.ref);
  assert.deepEqual(under.map((c) => c.name).sort(), ['Ocufii Android', 'Ocufii iOS']);
  // The component keeps the app's full name; only the project loses the suffix.
  assert.deepEqual(under.map((c) => c.platform).sort(), ['android', 'ios']);
});

test('every release follows its app to the new component', () => {
  const plan = planMigration({ apps, releases });
  assert.equal(plan.counts.releasesLinked, 4);
  const byId = new Map(plan.releases.map((r) => [r.id, r]));
  const a1 = plan.components.find((c) => c.appId === 'a1');
  assert.equal(byId.get('r1').componentRef, a1.ref);
  assert.equal(byId.get('r2').componentRef, a1.ref);
  assert.equal(byId.get('r1').label, 'v1.3.0 (169)');
});

test('an existing timeline project is reused, not duplicated', () => {
  const projects = [{ id: 'p1', name: 'Ocufii', color: '#5EE6C5', createdAt: '2026-01-01T00:00:00Z' }];
  const plan = planMigration({ apps, projects, releases });
  assert.deepEqual(plan.projects.map((p) => p.name), ['SCA']);
  const ocufiiComps = plan.components.filter((c) => c.projectRef === 'p1');
  assert.equal(ocufiiComps.length, 2);
  assert.equal(ocufiiComps[0].projectAction, 'reuse');
  assert.equal(plan.counts.projectsCreated, 1);
});

test('a project named with a version number still matches', () => {
  const projects = [{ id: 'p1', name: 'Ocufii 2.0', color: '#5EE6C5' }];
  const plan = planMigration({ apps: [apps[0]], projects, releases: [] });
  assert.equal(plan.counts.projectsCreated, 0);
  assert.equal(plan.components[0].projectRef, 'p1');
});

test('running the migration a second time changes nothing', () => {
  const first = planMigration({ apps, releases });
  // Simulate the result of executing it.
  const madeProjects = first.projects.map((p, i) => ({ id: `P${i}`, name: p.name, color: p.color }));
  const refToId = new Map(first.projects.map((p, i) => [p.ref, `P${i}`]));
  const madeComponents = first.components.map((c, i) => ({
    id: `C${i}`, projectId: refToId.get(c.projectRef) || c.projectRef, name: c.name, platform: c.platform
  }));
  const compRefToId = new Map(first.components.map((c, i) => [c.ref, `C${i}`]));
  const madeReleases = releases.map((r) => {
    const planned = first.releases.find((x) => x.id === r.id);
    return planned ? { ...r, componentId: compRefToId.get(planned.componentRef) } : r;
  });

  const second = planMigration({
    apps, projects: madeProjects, components: madeComponents, releases: madeReleases
  });
  assert.equal(second.empty, true);
  assert.equal(second.counts.projectsCreated, 0);
  assert.equal(second.counts.componentsCreated, 0);
  assert.equal(second.counts.releasesLinked, 0);
  assert.equal(second.counts.releasesAlreadyLinked, 4);
  assert.equal(second.counts.componentsReused, 3);
});

test('an interrupted run resumes: the done half is skipped, the rest is planned', () => {
  const projects = [{ id: 'P0', name: 'Ocufii' }];
  const components = [{ id: 'C0', projectId: 'P0', name: 'Ocufii Android', platform: 'android' }];
  const half = releases.map((r) => (r.appId === 'a1' ? { ...r, componentId: 'C0' } : r));
  const plan = planMigration({ apps, projects, components, releases: half });
  assert.equal(plan.counts.releasesAlreadyLinked, 2);
  assert.equal(plan.counts.releasesLinked, 2);
  assert.equal(plan.counts.componentsCreated, 2);      // iOS and SCA still to do
  assert.equal(plan.empty, false);
});

test('a release whose app is gone is reported, never silently dropped', () => {
  const plan = planMigration({ apps: [apps[0]], releases: [{ id: 'rX', appId: 'ghost', version: 'v1' }] });
  assert.equal(plan.counts.releasesOrphaned, 1);
  assert.equal(plan.releases.length, 0);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /no longer exists/);
});

test('an app whose name carries no platform keeps its own name as the project', () => {
  const plan = planMigration({ apps: [{ id: 'a9', name: 'Safe Deposit Solutions', platform: 'web' }] });
  assert.equal(plan.projects[0].name, 'Safe Deposit Solutions');
  assert.equal(plan.components[0].platform, 'web');   // falls back to the stored platform
});

test('nothing to migrate reports empty', () => {
  const plan = planMigration({});
  assert.equal(plan.empty, true);
  assert.equal(plan.warnings.length, 0);
});

test('migrationWrites orders projects, then components, then releases', () => {
  const plan = planMigration({ apps, releases });
  const writes = migrationWrites(plan);
  const kinds = writes.map((w) => w.collection);
  assert.equal(kinds.indexOf('projects') < kinds.indexOf('components'), true);
  assert.equal(kinds.lastIndexOf('components') < kinds.indexOf('releases'), true);
  assert.equal(writes.filter((w) => w.collection === 'releases').length, 4);
});

test('a migration write never touches appId, so an old client keeps working', () => {
  const writes = migrationWrites(planMigration({ apps, releases }));
  writes.filter((w) => w.collection === 'releases').forEach((w) => {
    assert.deepEqual(Object.keys(w.data), ['componentId']);
    assert.equal(w.op, 'update');
  });
});

test('migration writes carry every field a component needs to validate', () => {
  const writes = migrationWrites(planMigration({ apps, releases }), { today: '2026-08-22' });
  writes.filter((w) => w.collection === 'components').forEach((w) => {
    ['projectId', 'name', 'platform', 'repoUrl', 'artifactUrl', 'notes', 'color', 'order', 'createdAt']
      .forEach((k) => assert.equal(k in w.data, true, `${w.data.name} missing ${k}`));
    assert.match(w.data.color, /^#[0-9A-Fa-f]{6}$/);
  });
  writes.filter((w) => w.collection === 'projects').forEach((w) => {
    ['name', 'color', 'client', 'status', 'summary', 'order', 'createdAt']
      .forEach((k) => assert.equal(k in w.data, true, `${w.data.name} missing ${k}`));
  });
});

test('the created project inherits the app colour, so the board does not change colour under him', () => {
  const plan = planMigration({ apps: [apps[0]], releases: [] });
  assert.equal(plan.projects[0].color, '#5EE6C5');
});
