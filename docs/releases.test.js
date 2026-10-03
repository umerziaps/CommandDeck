// Tests for release management and the build-email parser.
//
// The parser is the part that earns its keep and the part most likely to go
// quietly wrong: a template changes, a field stops being found, and the record
// fills with releases that are missing the thing you needed. The fixtures here
// are lifted verbatim from a real Ocufii Android build thread.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLATFORMS, APP_PALETTE, platformLabel,
  blankApp, normaliseApp, appBody, validateApp, appOrder, appById,
  blankRelease, normaliseRelease, releaseBody, validateRelease, releaseLabel,
  releaseOrder, filterReleases, environments, latestInProduction, appSummary,
  locationKind, isOpenable, shortLocation,
  parseMailDate, parseReleaseLine, parseBuildEmail, dedupeReleases,
  tidyChanges, mergeNotes
} from './releases.js';

const TODAY = '2026-10-03';
const rel = (over = {}) => ({ ...blankRelease('app1', TODAY), ...over });

/* ---------- apps ---------- */

test('a platform that is not recognised reads as other, never blank', () => {
  assert.equal(normaliseApp('a1', { platform: 'blackberry' }).platform, 'other');
  assert.equal(normaliseApp('a1', { platform: 'ios' }).platform, 'ios');
  assert.equal(platformLabel('android'), 'Android');
  assert.equal(platformLabel('nonsense'), 'Other');
  assert.equal(PLATFORMS.length >= 4, true);
});

test('a malformed app colour never reaches a style attribute', () => {
  assert.equal(normaliseApp('a1', { color: 'red;background:url(x)' }).color, APP_PALETTE[0]);
  assert.equal(normaliseApp('a1', { color: '#AABBCC' }).color, '#AABBCC');
  assert.equal(blankApp(APP_PALETTE.length).color, APP_PALETTE[0], 'the palette wraps');
});

test('app names are required and unique, case-insensitively', () => {
  const existing = [{ id: 'a1', name: 'Ocufii Android' }];
  assert.equal(validateApp({ name: ' ' }, existing).ok, false);
  assert.equal(validateApp({ name: 'ocufii android' }, existing).ok, false);
  assert.equal(validateApp({ name: 'Ocufii Android' }, existing, 'a1').ok, true);
  assert.equal(validateApp({ name: 'Ocufii iOS' }, existing).ok, true);
});

test('appBody trims and keeps only the stored fields', () => {
  const b = appBody({ name: ' Ocufii ', platform: 'android', repoUrl: ' x ', secret: 'no' });
  assert.deepEqual(Object.keys(b).sort(), ['artifactUrl', 'color', 'name', 'notes', 'platform', 'repoUrl']);
  assert.equal(b.name, 'Ocufii');
  assert.equal(appById([{ id: 'a1' }], 'nope'), null);
  assert.deepEqual([{ name: 'Z' }, { name: 'a' }].sort(appOrder).map((a) => a.name), ['a', 'Z']);
});

/* ---------- releases ---------- */

test('a release needs an app, an identity and a date', () => {
  assert.equal(validateRelease(rel({ appId: '' })).ok, false);
  assert.equal(validateRelease(rel({ version: '', build: '' })).ok, false);
  assert.equal(validateRelease(rel({ version: 'v1.0' })).ok, true);
  assert.equal(validateRelease(rel({ version: '', build: '189' })).ok, true, 'a build number alone identifies it');
  assert.equal(validateRelease(rel({ version: 'v1', buildDate: 'soon' })).ok, false);
});

test('a release claiming production must say when', () => {
  // The whole point of the flag is answering "when did this ship". A true
  // flag with no date answers it with silence.
  assert.equal(validateRelease(rel({ version: 'v1', production: true })).ok, false);
  assert.equal(validateRelease(rel({ version: 'v1', production: true, prodDate: TODAY })).ok, true);
});

test('a production date without the flag is dropped, not honoured', () => {
  const r = normaliseRelease('r1', { production: false, prodDate: TODAY });
  assert.equal(r.prodDate, '', 'otherwise it would render as shipped');
});

test('production is strictly boolean — a truthy string must not ship a release', () => {
  assert.equal(normaliseRelease('r1', { production: 'yes' }).production, false);
  assert.equal(normaliseRelease('r1', { production: 1 }).production, false);
  assert.equal(normaliseRelease('r1', { production: true }).production, true);
});

test('build numbers stay strings, because they are labels', () => {
  const r = normaliseRelease('r1', { build: '007' });
  assert.equal(r.build, '007', 'coercing to a number would print 7');
});

test('the release label reads the way the team writes it', () => {
  assert.equal(releaseLabel({ version: 'v1.3.2', build: '189' }), 'v1.3.2 (189)');
  assert.equal(releaseLabel({ version: 'v1.3.2' }), 'v1.3.2');
  assert.equal(releaseLabel({ build: '189' }), 'build 189');
  assert.equal(releaseLabel({}), 'untitled');
});

test('releases sort newest first, and numerically within a day', () => {
  const rs = [
    rel({ version: 'a', build: '9', buildDate: '2026-02-24' }),
    rel({ version: 'b', build: '10', buildDate: '2026-02-24' }),
    rel({ version: 'c', build: '1', buildDate: '2026-03-01' })
  ];
  assert.deepEqual([...rs].sort(releaseOrder).map((r) => r.version), ['c', 'b', 'a'],
    'build 10 must come after build 9, not before it as a string compare would');
});

test('non-numeric build numbers still sort without throwing', () => {
  const rs = [rel({ build: '1.2-rc', buildDate: TODAY }), rel({ build: '1.10-rc', buildDate: TODAY })];
  assert.equal([...rs].sort(releaseOrder).length, 2);
});

test('filters combine: app, environment, production and text', () => {
  const rs = [
    rel({ version: 'a', env: 'California', production: true, prodDate: TODAY }),
    rel({ version: 'b', env: 'Virginia' }),
    rel({ version: 'c', env: 'California', changes: 'beacon snooze' }),
    rel({ version: 'd', appId: 'app2', env: 'California' })
  ];
  assert.deepEqual(filterReleases(rs, { appId: 'app1' }).map((r) => r.version), ['a', 'b', 'c']);
  assert.deepEqual(filterReleases(rs, { appId: 'app1', env: 'california' }).map((r) => r.version), ['a', 'c'],
    'environment matching ignores case — the team is not consistent about it');
  assert.deepEqual(filterReleases(rs, { appId: 'app1', prodOnly: true }).map((r) => r.version), ['a']);
  assert.deepEqual(filterReleases(rs, { query: 'BEACON' }).map((r) => r.version), ['c']);
});

test('the environment list is deduplicated case-insensitively but keeps what was typed', () => {
  const envs = environments([rel({ env: 'California' }), rel({ env: 'california' }), rel({ env: 'Ohio' })]);
  assert.deepEqual(envs, ['California', 'Ohio']);
});

test('the latest production release is picked by when it shipped, not when it was built', () => {
  const rs = [
    rel({ version: 'old-build-late-ship', buildDate: '2026-01-01', production: true, prodDate: '2026-06-01' }),
    rel({ version: 'new-build-early-ship', buildDate: '2026-05-01', production: true, prodDate: '2026-05-02' }),
    rel({ version: 'never-shipped', buildDate: '2026-09-01' })
  ];
  assert.equal(latestInProduction(rs, 'app1').version, 'old-build-late-ship');
  assert.equal(latestInProduction(rs, 'nope'), null);
});

test('the summary counts how far the app has drifted past what shipped', () => {
  const rs = [
    rel({ build: '1', buildDate: '2026-01-01', production: true, prodDate: '2026-01-02' }),
    rel({ build: '2', buildDate: '2026-02-01' }),
    rel({ build: '3', buildDate: '2026-03-01' })
  ];
  const s = appSummary(rs, 'app1');
  assert.equal(s.total, 3);
  assert.equal(s.production.build, '1');
  assert.equal(s.sinceProduction, 2);
  assert.equal(s.latest.build, '3');
});

test('an app that has never shipped reports every build as unshipped', () => {
  assert.equal(appSummary([rel({ build: '1' }), rel({ build: '2' })], 'app1').sinceProduction, 2);
});

/* ---------- locations ---------- */

test('a UNC path is not a link, and the model knows it', () => {
  // A browser will not open \\fs04\... from an https page. Rendering it as an
  // anchor gives you a control that silently does nothing.
  assert.equal(locationKind('\\\\fs04\\Integra\\OCUFII\\Executables'), 'unc');
  assert.equal(isOpenable('\\\\fs04\\Integra'), false);
  assert.equal(locationKind('https://github.com/x/y'), 'url');
  assert.equal(isOpenable('https://github.com/x/y'), true);
  assert.equal(locationKind('C:\\builds\\out'), 'path');
  assert.equal(locationKind('/Users/omarzia/iOS'), 'path');
  assert.equal(locationKind('file:///tmp/x'), 'uri');
  assert.equal(isOpenable('file:///tmp/x'), false, 'an https page cannot open file://');
  assert.equal(locationKind(''), 'empty');
});

test('a long location keeps the end, which is the part that identifies it', () => {
  const p = '\\\\fs04\\Integra\\OCUFII\\source code\\Android';
  assert.equal(shortLocation(p, 20).endsWith('Android'), true);
  assert.ok(shortLocation(p, 20).length <= 20);
  assert.equal(shortLocation('short', 20), 'short');
});

/* ---------- dates in mail headers ---------- */

test('the Outlook date formats in this thread all parse', () => {
  assert.equal(parseMailDate('Friday, September 25, 2026 8:23 PM'), '2026-09-25');
  assert.equal(parseMailDate('20 August 2026 13:27:55'), '2026-08-20');
  assert.equal(parseMailDate('Tuesday, July 21, 2026 3:47 PM'), '2026-07-21');
  assert.equal(parseMailDate('Thursday, February 26, 2026 2:31 PM'), '2026-02-26');
  assert.equal(parseMailDate('2026-02-13 19:31'), '2026-02-13');
  assert.equal(parseMailDate('who knows'), '');
  assert.equal(parseMailDate(''), '');
});

/* ---------- the release line ---------- */

test('a release line splits into version and build', () => {
  assert.deepEqual(parseReleaseLine('v1.3.2 (189)'), { version: 'v1.3.2', builds: ['189'] });
  assert.deepEqual(parseReleaseLine('v1.3.0 (169,170,171)'), { version: 'v1.3.0', builds: ['169', '170', '171'] });
  assert.deepEqual(parseReleaseLine('v1.3.0 (166, 167)'), { version: 'v1.3.0', builds: ['166', '167'] });
  assert.deepEqual(parseReleaseLine('v2.0'), { version: 'v2.0', builds: [''] });
});

/* ---------- the parser, against the real template ---------- */

const ONE_BUILD = `Dear Team,

The following build and the APK and AAB files have been generated and uploaded, and it is ready for testing.

BUILD DETAILS

Release: v1.3.2 (189)

Environment:  (California)

ARTIFACT DETAILS

Build Type: Flashed/ Uploaded To Open Testing

Path (FS04): \\\\fs04\\Integra\\OCUFII\\Executables

SOURCE CODE DETAILS

Path (FS04):  \\\\fs04\\Integra\\OCUFII\\source code\\Android

SCOPE OF THIS RELEASE

  *   Added flexi Door in Demo mode
  *   Upgrade the Android to 36 port and obfuscation

CONFIGURATION NOTES (OPTIONAL)

- Minimum SDK:  26

- Maximum SDK  36
`;

test('a single build email parses into one release with every field', () => {
  const { ok, releases } = parseBuildEmail(ONE_BUILD, { defaultDate: '2026-09-25' });
  assert.equal(ok, true);
  assert.equal(releases.length, 1);
  const r = releases[0];
  assert.equal(r.version, 'v1.3.2');
  assert.equal(r.build, '189');
  assert.equal(r.env, 'California');
  assert.equal(r.buildDate, '2026-09-25');
  assert.equal(r.artifactUrl, '\\\\fs04\\Integra\\OCUFII\\Executables');
  assert.equal(r.sourceUrl, '\\\\fs04\\Integra\\OCUFII\\source code\\Android');
  assert.match(r.changes, /Added flexi Door in Demo mode/);
  assert.match(r.changes, /Upgrade the Android to 36 port/);
  assert.match(r.notes, /Minimum SDK: 26/);
  assert.match(r.notes, /Maximum SDK: 36/);
  assert.match(r.notes, /Build type: Flashed/);
});

test('the artifact and source paths are not swapped', () => {
  // Two "Path:" lines distinguished only by the heading above them. Getting
  // this backwards is invisible until someone follows the wrong one.
  const { releases } = parseBuildEmail(ONE_BUILD, { defaultDate: TODAY });
  assert.ok(releases[0].artifactUrl.endsWith('Executables'));
  assert.ok(releases[0].sourceUrl.endsWith('Android'));
});

test('production is never inferred, not even from an environment called Production', () => {
  // "Production" as a build flavour means built with production config. It
  // does not mean anybody released it, and this is the field most worth not
  // guessing.
  const { releases } = parseBuildEmail(
    ONE_BUILD.replace('(California)', '(Production)'), { defaultDate: TODAY });
  assert.equal(releases[0].env, 'Production');
  assert.equal(releases[0].production, false);
  assert.equal(releases[0].prodDate, '');
});

const THREAD = `${ONE_BUILD}
From: AsadUllah Ehsan <asadullah.ehsan@Powersoft19.com>
Sent: Friday, August 21, 2026 6:05 PM
Subject: RE: Ocufii Android Version Management

BUILD DETAILS
Release: v1.3.2 (188)
Environment:  (Virginia)
ARTIFACT DETAILS
Build Type: Flashed/ Uploaded To Open Testing
Path (FS04): \\\\fs04\\Integra\\OCUFII\\Executables
SOURCE CODE DETAILS
Path (FS04):  \\\\fs04\\Integra\\OCUFII\\source code\\Android
SCOPE OF THIS RELEASE
Production build for google playstore.
CONFIGURATION NOTES (OPTIONAL)
- Minimum SDK:  26
- Maximum SDK  35

From: AsadUllah Ehsan
Sent: Tuesday, February 24, 2026 9:29 PM
Subject: RE: Ocufii Android Version Management

BUILD DETAILS
Release: v1.3.0 (169,170,171)
Environment: (Demo, Sqa, Production)
ARTIFACT DETAILS
Path (FS04): \\\\fs04\\Integra\\OCUFII\\Executables
SOURCE CODE DETAILS
Path (FS04): \\\\fs04\\Integra\\OCUFII\\source code\\Android
SCOPE OF THIS RELEASE
Enhancements:
1. A new DEMO build type has been added for the AWS Ohio region.
CONFIGURATION NOTES (OPTIONAL)
- Minimum SDK:  26
`;

test('a whole thread backfills the history, newest first', () => {
  const { ok, releases } = parseBuildEmail(THREAD, { defaultDate: '2026-09-25' });
  assert.equal(ok, true);
  assert.deepEqual(releases.slice(0, 2).map((r) => r.build), ['189', '188']);
  assert.equal(releases[1].buildDate, '2026-08-21', 'each build takes the date of its own message');
});

test('one announcement covering several builds becomes several releases, paired with their environments', () => {
  const { releases } = parseBuildEmail(THREAD, { defaultDate: '2026-09-25' });
  const multi = releases.filter((r) => r.version === 'v1.3.0');
  assert.deepEqual(multi.map((r) => r.build), ['169', '170', '171']);
  assert.deepEqual(multi.map((r) => r.env), ['Demo', 'Sqa', 'Production']);
  assert.equal(multi.every((r) => r.buildDate === '2026-02-24'), true);
});

test('when the counts do not line up, the environment is not invented', () => {
  const odd = THREAD.replace('(Demo, Sqa, Production)', '(Demo, Sqa)');
  const multi = parseBuildEmail(odd, { defaultDate: TODAY }).releases.filter((r) => r.version === 'v1.3.0');
  assert.equal(multi.length, 3);
  assert.equal(multi.every((r) => r.env === 'Demo, Sqa'), true,
    'pairing two environments onto three builds would be a guess');
});

test('prose where a version should be is skipped, not turned into a release', () => {
  const broken = `BUILD DETAILS
Release: This production build includes all recent fixes and the required Android 15 compliance updates.
SCOPE OF THIS RELEASE
things`;
  const res = parseBuildEmail(broken);
  assert.equal(res.ok, false, 'a sentence is not a version number');
});

test('text with no build details is refused with a usable message', () => {
  const res = parseBuildEmail('Hi, can you send me the latest build?');
  assert.equal(res.ok, false);
  assert.match(res.error, /Release/);
  assert.deepEqual(res.releases, []);
});

test("Outlook's inline link duplicates are stripped from the paths", () => {
  const withLinks = ONE_BUILD.replace(
    'Path (FS04): \\\\fs04\\Integra\\OCUFII\\Executables',
    'Path (FS04): \\\\fs04\\Integra\\OCUFII\\Executables<file://fs04/Integra/OCUFII/Executables>');
  const { releases } = parseBuildEmail(withLinks, { defaultDate: TODAY });
  assert.equal(releases[0].artifactUrl, '\\\\fs04\\Integra\\OCUFII\\Executables');
});

/* ---------- re-pasting ---------- */

test('re-pasting a thread adds nothing the second time', () => {
  const { releases } = parseBuildEmail(THREAD, { defaultDate: TODAY });
  const existing = releases.map((r, i) => normaliseRelease(`r${i}`, { ...r, appId: 'app1' }));
  const { fresh, skipped } = dedupeReleases(releases, existing, 'app1');
  assert.equal(fresh.length, 0);
  assert.equal(skipped, releases.length);
});

test('the same build announced for two environments is two releases, not a duplicate', () => {
  const parsed = [
    { version: 'v1.3.0', build: '169', env: 'Demo' },
    { version: 'v1.3.0', build: '169', env: 'Production' }
  ];
  assert.equal(dedupeReleases(parsed, [], 'app1').fresh.length, 2);
});

test('a release already recorded under a DIFFERENT app is not treated as a duplicate', () => {
  const existing = [normaliseRelease('r1', { appId: 'other', version: 'v1', build: '1', env: 'Demo' })];
  const { fresh } = dedupeReleases([{ version: 'v1', build: '1', env: 'Demo' }], existing, 'app1');
  assert.equal(fresh.length, 1, 'two apps can legitimately both have a build 1');
});

test('releaseBody keeps exactly the stored fields', () => {
  const b = releaseBody({ ...blankRelease('app1', TODAY), version: 'v1', junk: 'no' });
  assert.deepEqual(Object.keys(b).sort(), [
    'appId', 'artifactUrl', 'build', 'buildDate', 'changes', 'env',
    'notes', 'prodDate', 'production', 'sourceUrl', 'version'
  ]);
});

/* ---------- tidying a human email into a changelog ---------- *
 *
 * From a real import: the changes field carried the build's own version and
 * SDK levels (already in notes) plus a request to report issues, and the
 * actual change was one line in the middle of it.
 */

const MESSY = `The completed work includes:
Audit log for Account creation and deletion is sometimes missing has been fixed
Version Details:
• Version Name: 1.0.1
• Version Code: 9
• Maximum SDK: 36
• Minimum SDK: 26
The implementation is complete and ready for QA/testing. Please let me know if any issues are identified or if any additional changes are required.`;

test('version and SDK lines are lifted out of the changelog', () => {
  const { changes, metadata } = tidyChanges(MESSY);
  assert.doesNotMatch(changes, /Version Code/);
  assert.doesNotMatch(changes, /Minimum SDK/);
  assert.doesNotMatch(changes, /Version Details/);
  assert.deepEqual(metadata, ['Version Name: 1.0.1', 'Version Code: 9', 'Maximum SDK: 36', 'Minimum SDK: 26']);
});

test('the actual change survives tidying', () => {
  // The whole point. Trimming is only worth doing if it never eats content.
  assert.match(tidyChanges(MESSY).changes, /Audit log for Account creation and deletion/);
});

test('a request addressed to the reader is dropped, the statement beside it is not', () => {
  const { changes } = tidyChanges(MESSY);
  assert.doesNotMatch(changes, /Please let me know/);
  assert.doesNotMatch(changes, /additional changes are required/);
  assert.match(changes, /ready for QA\/testing/, 'that sentence describes the build and stays');
});

test('greetings and sign-offs go', () => {
  const { changes } = tidyChanges('Dear Team,\nFixed the crash\nRegards,');
  assert.equal(changes, 'Fixed the crash');
});

test('an ordinary changelog is returned untouched', () => {
  const plain = '• Added support for FlexiDoor Beacon\n• Replaced Face ID with Two-Factor Authentication (2FA)';
  assert.equal(tidyChanges(plain).changes, plain);
  assert.deepEqual(tidyChanges(plain).metadata, []);
});

test('a line that merely mentions a version is not mistaken for metadata', () => {
  // "Version Code: 9" is metadata. "Upgraded to version 2 of the SDK" is a change.
  const { changes, metadata } = tidyChanges('Upgraded to version 2 of the beacon SDK');
  assert.match(changes, /Upgraded to version 2/);
  assert.deepEqual(metadata, []);
});

test('tidying is safe on empty and whitespace input', () => {
  assert.deepEqual(tidyChanges(''), { changes: '', metadata: [] });
  assert.deepEqual(tidyChanges(null), { changes: '', metadata: [] });
  assert.equal(tidyChanges('\n\n  \n').changes, '');
});

test('merging metadata into notes does not repeat what is already there', () => {
  const notes = 'Build type: Flashed\nMinimum SDK: 26';
  const merged = mergeNotes(notes, ['Minimum SDK: 26', 'Version Code: 9']);
  assert.equal((merged.match(/Minimum SDK: 26/g) || []).length, 1);
  assert.match(merged, /Version Code: 9/);
});

test('merging into empty notes does not leave a leading blank line', () => {
  assert.equal(mergeNotes('', ['Version Code: 9']), 'Version Code: 9');
  assert.equal(mergeNotes(null, []), '');
});

test('the template parser now produces a clean changelog from a messy email', () => {
  const email = `BUILD DETAILS
Release: v1.0.1 (9)
Environment: (US West Oregon)
ARTIFACT DETAILS
Path (FS04): \\\\fs04\\out
SOURCE CODE DETAILS
Path (FS04): \\\\fs04\\src
SCOPE OF THIS RELEASE
${MESSY}
CONFIGURATION NOTES (OPTIONAL)
- Minimum SDK: 26
- Maximum SDK 36`;
  const r = parseBuildEmail(email, { defaultDate: TODAY }).releases[0];
  assert.match(r.changes, /Audit log/);
  assert.doesNotMatch(r.changes, /Please let me know/);
  assert.doesNotMatch(r.changes, /Version Code/);
  assert.match(r.notes, /Version Code: 9/, 'the metadata moved rather than vanishing');
  assert.equal((r.notes.match(/Minimum SDK: 26/g) || []).length, 1, 'and is not duplicated');
});

/* ---------- shortening a path ---------- */

test('a long path keeps both ends, so it still reads as a path', () => {
  // Cutting the front produced "…s04\\Integra\\…", which looks like a broken
  // string rather than a shortened one.
  const p = '\\\\fs04\\Integra\\OCUFII\\source code\\Android\\Regal VA';
  const short = shortLocation(p, 30);
  assert.ok(short.startsWith('\\\\fs04'), `lost the server name: ${short}`);
  assert.ok(short.endsWith('Regal VA'), `lost the leaf: ${short}`);
  assert.ok(short.includes('…'));
  assert.ok(short.length <= 30);
});

test('a path that fits is not touched', () => {
  assert.equal(shortLocation('\\\\fs04\\out', 52), '\\\\fs04\\out');
});
